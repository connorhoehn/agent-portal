#!/usr/bin/env node
// The decision watcher's one paid check (docs/meeting-consent-design.md, "Detection", package 5).
//
//   node scripts/meeting-assistant/watcher-check.mjs          NO CALL, NO COST. Prints the request it would send and stops.
//   node scripts/meeting-assistant/watcher-check.mjs --yes    THE PAID CHECK. Sends ONE Converse request to Amazon Nova Lite with the
//                                                             default AWS profile and prints only the parsed answer and the token counts.
//
// The request is built by the middleware's own builder (middleware/src/lib/meeting-assistant/decision-prompt.ts, loaded through tsx), from
// a fixed, fictional transcript, so what is checked is exactly what the watcher sends. The answer is read by the same strict parser.
// Nothing else is printed of the answer: no raw text. Expected cost: about 750 tokens in and under 100 out, well under $0.0001.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const MW = path.resolve(here, '../../middleware');
const requireMw = createRequire(path.join(MW, 'package.json'));
const { tsImport } = requireMw('tsx/esm/api');
const prompt = await tsImport(pathToFileURL(path.join(MW, 'src/lib/meeting-assistant/decision-prompt.ts')).href, import.meta.url);

// Fictional people and words. Expected answer: a decision, "cut over the smallest tenants first", evidence [3, 4] (and maybe 5).
const input = {
  roster: ['Priya Shah', 'Sam Ortiz', 'Lee Park'],
  lines: [
    { seq: 1, speaker: 'Lee Park', text: 'The staging cutover went fine last night, no errors in the logs.' },
    { seq: 2, speaker: 'Priya Shah', text: 'Good. So what order do we do production in?' },
    { seq: 3, speaker: 'Sam Ortiz', text: "Let's cut over the smallest tenants first, then the big three next week." },
    { seq: 4, speaker: 'Priya Shah', text: 'Agreed, smallest first.' },
    { seq: 5, speaker: 'Lee Park', text: 'Works for me. I can watch the dashboards during the window.' },
  ],
};

const body = prompt.buildDecisionRequest(input);
const PRICE_IN = 0.06 / 1e6;
const PRICE_OUT = 0.24 / 1e6;
const chars = body.system[0].text.length + body.messages[0].content[0].text.length;

if (!process.argv.includes('--yes')) {
  console.log('Would send ONE request to Amazon Nova Lite (default AWS profile). Nothing was sent.\n');
  console.log(JSON.stringify(body, null, 2));
  const tokensIn = Math.ceil(chars / 4);
  console.log(`\nAbout ${tokensIn} tokens in, at most ${body.inferenceConfig.maxTokens} out: at most $${(tokensIn * PRICE_IN + body.inferenceConfig.maxTokens * PRICE_OUT).toFixed(6)}.`);
  console.log('Run again with --yes to send it.');
  process.exit(0);
}

process.env.AWS_PROFILE ??= 'default';
const { BedrockRuntimeClient, ConverseCommand } = requireMw('@aws-sdk/client-bedrock-runtime');
const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1', maxAttempts: 2 });
const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), 15_000);
let resp;
try {
  resp = await client.send(new ConverseCommand(body), { abortSignal: abort.signal });
} catch (e) {
  console.error('The request failed:', e?.name ?? 'error');
  process.exit(1);
} finally {
  clearTimeout(timer);
}
const text = (resp.output?.message?.content ?? []).map((c) => c.text ?? '').join('');
const answer = prompt.parseDecisionAnswer(prompt.extractJson(text));
const usage = { inputTokens: resp.usage?.inputTokens ?? null, outputTokens: resp.usage?.outputTokens ?? null };
console.log(JSON.stringify({ answer: answer ?? 'MALFORMED (dropped by the parser)', usage }, null, 2));
if (usage.inputTokens != null && usage.outputTokens != null) console.log(`Cost: $${(usage.inputTokens * PRICE_IN + usage.outputTokens * PRICE_OUT).toFixed(6)}`);
process.exit(answer ? 0 : 2);
