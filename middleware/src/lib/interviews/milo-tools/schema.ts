// What the interview tools' schemas share.
import type { JsonSchemaObject } from '../../voice/catalogue.js';

/** The schema of a tool that takes no arguments. */
export const noArgs = (): JsonSchemaObject => ({ type: 'object', properties: {}, required: [], additionalProperties: false });

/** The largest arguments a pad tool's call may carry (a dozen cases or a 60-line helper); every other tool keeps 4 KB. */
export const PAD_TOOL_ARGS_BYTES = 12_288;
