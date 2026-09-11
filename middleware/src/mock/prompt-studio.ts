// Prompt Studio's two model calls, offline — invoke and optimize.
//
// `POST /library/:promptId/invoke` runs a prompt through ConverseStream, and
// `POST /library/:promptId/optimize` asks Bedrock's OptimizePrompt to rewrite
// a template. Both are model work, and a mock has no model. What it CAN do is
// two honest things, and neither of them is "return a plausible answer and let
// the page believe a model wrote it":
//
//   * invoke RENDERS the template. Bedrock expands `{{…}}` server-side when a
//     prompt ARN is the model, so the one part of an invocation that is
//     mechanical — substituting the variables the caller supplied into the
//     template the library holds — can be done exactly. The offline invoke
//     streams that rendered prompt, prefixed with a line saying what it is, so
//     an operator testing a prompt offline sees precisely what would have been
//     sent and cannot mistake it for a completion.
//   * optimize REFUSES. There is no rewrite a fixture can perform that would
//     be a rewrite; returning the input unchanged and calling it "optimized"
//     is the rubber stamp docs/mock-floor.md rules out, and returning invented
//     prose would be worse. It answers 503 with the reason, which is the same
//     thing the live route answers when OptimizePrompt is unavailable.

import { findMockPrompt } from './canary-library.js';

/** The banner the rendered prompt is prefixed with. Never a model id. */
export const OFFLINE_RENDER_NOTICE =
  '[offline/template-render] No model ran. Below is the prompt exactly as it ' +
  'would have been sent, with your variables substituted.';

/**
 * The text an offline invoke streams, or null when there is no such prompt or
 * version — which the route turns into the same 503 the GetPrompt failure
 * produces, rather than streaming a made-up answer for a prompt that is
 * not there.
 */
export function offlineInvokePrompt(
  promptId: string,
  version: string | undefined,
  variables: Record<string, string>,
): string | null {
  const prompt = findMockPrompt(promptId);
  if (!prompt) return null;
  const wanted = version ?? 'DRAFT';
  const v = prompt.versions.find((x) => x.version === wanted);
  if (!v) return null;
  const rendered = v.variant.templateText.replace(
    /{{\s*([\w.-]+)\s*}}/g,
    (_m, name: string) =>
      Object.prototype.hasOwnProperty.call(variables, name)
        ? variables[name]!
        : `{{${name}}}`,
  );
  return `${OFFLINE_RENDER_NOTICE}\n\n${rendered}`;
}

/** Why optimize cannot be answered offline. Carried to the caller verbatim. */
export const OFFLINE_OPTIMIZE_REFUSAL =
  'OptimizePrompt rewrites a template with a model, and there is no model ' +
  'offline. Returning the template unchanged would report a rewrite that did ' +
  'not happen.';

export function offlineOptimize(): { error: string; detail: string } {
  return { error: 'Bedrock unavailable', detail: OFFLINE_OPTIMIZE_REFUSAL };
}
