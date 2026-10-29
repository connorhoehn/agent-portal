// Nova Pro vision extractor. Takes a PNG screenshot + the source URL and
// returns a structured page summary (title, summary, mainText, discovered
// links with click coordinates). Used by the AgentCore Browser crawler to
// produce KB-ready markdown without ever fetching the page HTML server-side.
//
// HARD CONSTRAINT: only amazon.nova-pro-v1:0 — no Anthropic models. Nova
// Pro supports multimodal Converse with `image` content blocks.

import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { recordBffCall } from '../providers/spend-ledger.js';
import { config } from '../config.js';
import type { DiscoveredLink, VisionExtractionResult } from './crawler-types.js';

const VISION_MODEL = 'amazon.nova-pro-v1:0';

let _client: BedrockRuntimeClient | null = null;
function client(): BedrockRuntimeClient {
  if (!_client) _client = new BedrockRuntimeClient({ region: config.region });
  return _client;
}

const BASE_PROMPT = `You are a web page analyzer. The image is a screenshot of a fully rendered web page (JavaScript has already executed).

Source URL: {URL}

Extract the page's content into STRICT JSON with EXACTLY this shape (no markdown fences, no preamble, no trailing commentary):

{
  "title": "the page title as it appears in the screenshot (heading or browser tab text). 200 chars max.",
  "summary": "2-3 sentences describing what this page is about and who it's for.",
  "mainText": "The page's CORE TEXTUAL CONTENT, cleaned. Include headings, paragraphs, list items, and visible body copy. EXCLUDE: site-wide navigation chrome, cookie banners, footer boilerplate, social-media badges, repeated UI labels. Preserve paragraph breaks with \\n\\n. 5000 chars max.",
  "discoveredLinks": [
    {
      "label": "the visible link/button text",
      "targetUrl": "absolute URL if you can read an href out of the page, or null for pure SPA buttons",
      "clickX": <integer pixel x of the link/button center, from the screenshot's coordinate space>,
      "clickY": <integer pixel y of the link/button center>,
      "isSpaLink": <true if the link is a JS-driven button (href "#", "javascript:", missing, or a button); false if it's a normal anchor with an http(s) href>
    }
  ]
}

Rules:
- Output ONLY the JSON object. No \`\`\` fences. No prose before or after.
- discoveredLinks: include up to 25 of the most prominent navigational elements (top nav, primary CTAs, hero links, sidebar nav). Do not include footer legal links, breadcrumb segments, or social badges.
- If you cannot reliably estimate clickX/clickY for a link, omit that entry rather than guessing wildly.
- If the page is empty / blank / error / cookie-wall, return summary explaining that and an empty discoveredLinks array.`;

const STRICT_RETRY_PROMPT = `Your previous response could not be parsed as JSON. Output ONLY raw JSON with this exact shape — no code fences, no commentary:

{"title":"...","summary":"...","mainText":"...","discoveredLinks":[{"label":"...","targetUrl":null,"clickX":0,"clickY":0,"isSpaLink":false}]}

Source URL: {URL}`;

interface NovaJsonShape {
  title?: unknown;
  summary?: unknown;
  mainText?: unknown;
  discoveredLinks?: unknown;
}

function stripFences(text: string): string {
  // Nova occasionally wraps JSON in ```json ... ``` even when told not to.
  let t = text.trim();
  // Common fence patterns: ```json\n{...}\n``` or ```\n{...}\n```
  const fenceMatch = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  if (fenceMatch && fenceMatch[1]) {
    t = fenceMatch[1].trim();
  }
  // Sometimes the model emits leading prose before the JSON object. Slice from
  // the first '{' to the matching final '}'.
  const firstBrace = t.indexOf('{');
  const lastBrace = t.lastIndexOf('}');
  if (firstBrace > 0 && lastBrace > firstBrace) {
    t = t.slice(firstBrace, lastBrace + 1);
  }
  return t;
}

function coerceLinks(raw: unknown): DiscoveredLink[] {
  if (!Array.isArray(raw)) return [];
  const out: DiscoveredLink[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const label = typeof obj['label'] === 'string' ? (obj['label'] as string).trim() : '';
    if (!label) continue;
    const rawTarget = obj['targetUrl'];
    const targetUrl =
      typeof rawTarget === 'string' && /^https?:\/\//i.test(rawTarget)
        ? rawTarget
        : null;
    const clickXRaw = obj['clickX'];
    const clickYRaw = obj['clickY'];
    const isSpaLink = obj['isSpaLink'] === true || targetUrl === null;
    const link: DiscoveredLink = {
      label: label.slice(0, 200),
      targetUrl,
      isSpaLink,
    };
    if (typeof clickXRaw === 'number' && Number.isFinite(clickXRaw)) {
      link.clickX = Math.max(0, Math.round(clickXRaw));
    }
    if (typeof clickYRaw === 'number' && Number.isFinite(clickYRaw)) {
      link.clickY = Math.max(0, Math.round(clickYRaw));
    }
    out.push(link);
    if (out.length >= 50) break;
  }
  return out;
}

function coerceResult(parsed: NovaJsonShape): Omit<VisionExtractionResult, 'tokensIn' | 'tokensOut' | 'latencyMs'> {
  return {
    title: typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 500) : '',
    summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
    mainText: typeof parsed.mainText === 'string' ? parsed.mainText : '',
    discoveredLinks: coerceLinks(parsed.discoveredLinks),
  };
}

interface ConverseAttempt {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

async function runConverse(pngBytes: Buffer, prompt: string): Promise<ConverseAttempt> {
  const resp = await client().send(
    new ConverseCommand({
      modelId: VISION_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { image: { format: 'png', source: { bytes: pngBytes } } },
            { text: prompt },
          ],
        },
      ],
      inferenceConfig: { maxTokens: 4000, temperature: 0.1 },
    }),
  );
  void recordBffCall({ feature: 'vision-extractor', model: VISION_MODEL, usage: resp.usage });
  const blocks = resp.output?.message?.content ?? [];
  const text = blocks.map((c) => ('text' in c ? c.text ?? '' : '')).join('').trim();
  return {
    text,
    tokensIn: resp.usage?.inputTokens ?? 0,
    tokensOut: resp.usage?.outputTokens ?? 0,
  };
}

export async function extractFromScreenshot(
  pngBytes: Buffer,
  url: string,
): Promise<VisionExtractionResult> {
  const startedAt = Date.now();
  let tokensIn = 0;
  let tokensOut = 0;

  const prompt1 = BASE_PROMPT.replace('{URL}', url);
  try {
    const first = await runConverse(pngBytes, prompt1);
    tokensIn += first.tokensIn;
    tokensOut += first.tokensOut;

    const cleaned = stripFences(first.text);
    try {
      const parsed = JSON.parse(cleaned) as NovaJsonShape;
      const result = coerceResult(parsed);
      return {
        ...result,
        tokensIn,
        tokensOut,
        latencyMs: Date.now() - startedAt,
      };
    } catch {
      // Fall through to retry.
    }

    // Retry with a stricter prompt.
    const prompt2 = STRICT_RETRY_PROMPT.replace('{URL}', url);
    const second = await runConverse(pngBytes, prompt2);
    tokensIn += second.tokensIn;
    tokensOut += second.tokensOut;
    const cleaned2 = stripFences(second.text);
    try {
      const parsed2 = JSON.parse(cleaned2) as NovaJsonShape;
      const result2 = coerceResult(parsed2);
      return {
        ...result2,
        tokensIn,
        tokensOut,
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      console.warn('[vision-extractor] retry parse failed:', (err as Error).message);
    }
  } catch (err) {
    console.warn('[vision-extractor] Converse failed:', (err as Error).message);
  }

  // Best-effort empty result so the crawler can still emit a page record.
  return {
    title: '',
    summary: '(extraction failed)',
    mainText: '',
    discoveredLinks: [],
    tokensIn,
    tokensOut,
    latencyMs: Date.now() - startedAt,
  };
}
