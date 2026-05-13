// Tiny AJV wrapper for output schema conformance checks in the observability
// data plane.
//
// Each template_id row in observability.sampling_config may carry a JSON Schema
// in the `schema_json` column. When present, the trace-sink validates the
// agent's response against it and records the boolean `schema_valid` on the
// trace row. The CloudWatch `SchemaConformance` metric is just the rolling
// average of that boolean per agent.
//
// We compile-cache by the JSON-stringified schema so repeat templates don't
// re-pay AJV's compile cost.

import AjvImport, { type ValidateFunction } from 'ajv';

// AJV v8 ships a CommonJS-style default export; under TS NodeNext with the
// `esModuleInterop` we use, the runtime value lands on `.default`. We try the
// default first and fall back to the namespace itself to stay compatible with
// both shapes.
const Ajv: any = (AjvImport as any).default ?? (AjvImport as any);

const ajv = new Ajv({
  allErrors: false,
  strict: false,
  // We're validating untrusted JSON payloads from agents; lenient mode keeps
  // schema authoring cheap (extra keywords don't blow up compile).
});

const _cache = new Map<string, ValidateFunction>();

function compile(schema: object): ValidateFunction | null {
  let key: string;
  try {
    key = JSON.stringify(schema);
  } catch {
    return null;
  }
  const cached = _cache.get(key);
  if (cached) return cached;
  try {
    const fn = ajv.compile(schema);
    _cache.set(key, fn);
    return fn;
  } catch (err) {
    console.warn('[schema-validator] compile failed:', (err as Error).message);
    return null;
  }
}

/**
 * Validate `output` against `schema`. Returns:
 *   - `true`  → output matches schema
 *   - `false` → output is invalid OR the schema itself is malformed
 *               (we err toward "fail" so a broken schema visibly tanks the
 *                SchemaConformance metric instead of silently passing)
 *
 * If you want "no schema configured" semantics, the caller should not call
 * this at all and should leave `schema_valid` as `null` on the trace row.
 */
export function validate(output: unknown, schema: object): boolean {
  const fn = compile(schema);
  if (!fn) return false;
  try {
    return fn(output) === true;
  } catch {
    return false;
  }
}

/**
 * Try to interpret a text payload as JSON for schema validation. Agents
 * usually return free-form text; the schema check only applies when the
 * response is parseable JSON. Returns the parsed value, or `undefined` if
 * the text is empty / not valid JSON.
 */
export function tryParseJson(text: string): unknown {
  if (!text) return undefined;
  const t = text.trim();
  if (!t) return undefined;
  // Common case: agents wrap JSON in ```json fences. Strip them.
  const stripped = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(stripped);
  } catch {
    return undefined;
  }
}
