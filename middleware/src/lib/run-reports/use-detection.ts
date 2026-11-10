// Use detection (docs/learning-loop-design.md §4 "Evidence"): which skills a
// session LOADED, observed in Claude Code's own event stream
// (`claude -p --output-format stream-json --verbose`), never self-reported.
//
// A load is a `tool_use` block named `Skill` in an `assistant` event; the skill's
// name is its input's `skill` (the documented key), accepted under `name` or
// `command` too so a CLI that renames it still counts. A `Read` of a skill's
// own SKILL.md under a `.claude/skills/` directory counts as a load as well
// (the model opening the file by hand). The session transcript file is not
// read: its format is internal.
//
// tools/local-compute-report.mjs holds the same rule in plain Node for the
// worker; __tests__/run-report-worker-parity.test.ts keeps the two equal.

/** A portable skill name: lowercase letters, digits and hyphens, at most 64 characters. */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SKILL_FILE_RE = /(?:^|\/)\.claude\/skills\/([a-z0-9][a-z0-9-]{0,63})\/SKILL\.md$/;

/** The skills one stream-json event shows being loaded ([] for most events). */
export function skillsLoadedByEvent(ev: unknown): string[] {
  if (!ev || typeof ev !== 'object') return [];
  const e = ev as Record<string, unknown>;
  if (e['type'] !== 'assistant') return [];
  const content = (e['message'] as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b['type'] !== 'tool_use') continue;
    const input = (b['input'] && typeof b['input'] === 'object' ? b['input'] : {}) as Record<string, unknown>;
    if (b['name'] === 'Skill') {
      const raw = input['skill'] ?? input['name'] ?? input['command'];
      // A plugin skill is "plugin:name"; the library's own skills never are, so the last segment is the name.
      const name = typeof raw === 'string' ? raw.trim().replace(/^\//, '').split(':').pop()!.toLowerCase() : '';
      if (SKILL_NAME_RE.test(name)) out.push(name);
    } else if (b['name'] === 'Read') {
      const path = input['file_path'];
      const m = typeof path === 'string' ? SKILL_FILE_RE.exec(path) : null;
      if (m) out.push(m[1]!);
    }
  }
  return out;
}

/** Every distinct skill a stream of events loaded, in first-load order, capped. */
export function skillsLoadedFrom(events: Iterable<unknown>, cap = 50): string[] {
  const seen = new Set<string>();
  for (const ev of events) {
    for (const s of skillsLoadedByEvent(ev)) {
      if (seen.size >= cap) return [...seen];
      seen.add(s);
    }
  }
  return [...seen];
}
