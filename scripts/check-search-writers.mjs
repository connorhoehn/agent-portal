#!/usr/bin/env node
// Every orgiq writer that changes a searchable record updates the search index
// after its commit (middleware/src/lib/search-index/writes.ts).
//
// The check: in each module that owns an indexed record type, every exported
// function whose name says it writes (create/update/add/remove/set/…) or whose
// body writes an indexed table must call `noteSearchWrite` / `noteSearchWriteSoon`,
// or be listed in EXEMPT below with the reason it changes no searchable field.
// A new writer therefore fails this check until it is hooked or exempted.
//
//   node scripts/check-search-writers.mjs [--json]
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Modules that own an indexed record (lib/search-index/orgiq.ts reads them). */
const MODULES = [
  'middleware/src/providers/projects.ts',        // initiative
  'middleware/src/providers/work-items.ts',      // work
  'middleware/src/providers/decisions.ts',       // decision
  'middleware/src/providers/design-reviews.ts',  // decision (approved designs)
  'middleware/src/providers/prompt-library.ts',  // asset
  'middleware/src/providers/graph-proposals.ts', // person (skills, title, collaborations)
  'middleware/src/providers/org-teams.ts',       // team
  'middleware/src/providers/aurora.ts',          // person
  // S2 lanes: one block per tenant, each lane edits only its own block.
  'middleware/src/providers/assessment.ts',      // assessment: team, dimension, exception, feedback, run, submission, story, document
  // [assessment modules]
  'middleware/src/providers/social-channels.ts', // social channel
  'middleware/src/providers/social-platform.ts', // social room, team, recording
  'middleware/src/lib/social-chat.ts',           // social message, pin, dm, channel (membership)
  // [pipelines modules]
  'middleware/src/providers/pipeline-definitions.ts', // pipelines: definition, runbook, approval, run
  'middleware/src/providers/bots.ts',                 // pipelines: bot, run
  'middleware/src/providers/access.ts',          // access: request, catalog, policy, event, review, review-item, delegation
];
const WRITER_NAME = /^(create|update|upsert|delete|remove|add|set|link|unlink|record|publish|apply|decide|answer|signoff|approve|reject|rename|merge|assign|reassign|move|archive|retire|insert|put|save|write|import|promote|dismiss|compute)[A-Z_]/;
/** Per-tenant table names whose INSERT/UPDATE/DELETE marks a function as a writer (S2 lanes extend their own entry). */
const TENANT_TABLE_WRITES = [
  // [assessment tables]
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+social_channels\b/i,
  // [pipelines tables]
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:orgiq\.)?access_(requests|request_steps|events|catalog_items|policies|reviews|review_items|delegations)\b/i,
];
const INDEXED_TABLE_WRITE = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:orgiq\.)?(projects|project_contributions|work_items|decisions|decision_participants|people|person_skills|collaborations|teams|team_memberships)\b/i;
const HOOK = /\bnoteSearchWrite(?:Soon)?\(/;
/** `module:function` → why it changes no searchable field. */
const EXEMPT = {
  // ── social (S2): who changes what, and why a writer is exempt ──
  'social-platform.ts:setTeamFavorite': 'a personal pin on a team is not a searchable field',
  'social-chat.ts:createMemorySocialChatBackend': 'builds the store; every write goes through the store the watcher patches (watchChatForWorkGraph), which indexes it',
  'social-chat.ts:createSocialChatBackend': 'builds the store; every write goes through the store the watcher patches (watchChatForWorkGraph), which indexes it',
  'social-chat.ts:setSocialChatBackend': 'wires the backend and patches its stores with the indexing watcher (watchChatForWorkGraph)',
  'social-chat.ts:setThreadLiveAppend': 'wires the live broadcast; the thread message itself is written by the patched store',
  // [pipelines exempt]
  'pipeline-definitions.ts:setDefaultApproverRole': 'the default approver role is tenant configuration; no indexed pipelines doc carries it',
  'assessment.ts:createKnowledgeComment': 'knowledge-doc comments are not part of the document doc (title and body only)',
  'assessment.ts:deleteKnowledgeComment': 'knowledge-doc comments are not part of the document doc (title and body only)',
  'assessment.ts:updateSubmissionLink': 'evidence links on an envelope are not indexed (title, submitter, team, status are)',
  'work-items.ts:decideStatusTransition': 'a pure transition rule; it writes nothing',
  'work-items.ts:decideDecisionLink': 'a pure link rule; it writes nothing',
  'design-reviews.ts:decideApproval': 'a pure approval rule; it writes nothing',
  'work-items.ts:linkDecisionToWorkItem': 'the decision ↔ work link is not a doc field or an indexed edge',
  'work-items.ts:unlinkDecisionFromWorkItem': 'the decision ↔ work link is not a doc field or an indexed edge',
  'work-items.ts:recordWorkItemEstimate': 'estimates (points, cost) are not searched',
  'work-items.ts:reviewWorkItemEstimate': 'estimate review is not searched',
  'work-items.ts:addWorkItemComment': 'comments are not part of the work doc',
  'work-items.ts:createWorkItemComment': 'comments are not part of the work doc',
  'work-items.ts:createWorkItemCriterion': 'acceptance criteria are not part of the work doc',
  'work-items.ts:updateWorkItemCriterion': 'acceptance criteria are not part of the work doc',
  'work-items.ts:deleteWorkItemCriterion': 'acceptance criteria are not part of the work doc',
  'design-reviews.ts:answerQuestion': 'a thread post changes neither the design\'s title, summary nor status',
};

/** The body of `export (async) function name(` — walks braces, skipping strings and template literals roughly. */
function functions(src) {
  const out = [];
  const re = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    // find the body's opening brace after the parameter list
    let i = m.index + m[0].length, depth = 1;
    while (i < src.length && depth > 0) { const c = src[i++]; if (c === '(') depth++; else if (c === ')') depth--; }
    // Skip a return type: a `{` inside `<…>` or right after `:`/`|`/`&`/`,` is a type literal, not the body.
    let angle = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === ';' && angle === 0) break;
      if (c === '<') angle++;
      else if (c === '>' && src[i - 1] !== '=') angle--;
      else if (c === '{') {
        const prev = src.slice(0, i).trimEnd().slice(-1);
        if (angle > 0 || [':', '|', '&', ','].includes(prev)) { let d = 0; for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) break; } continue; }
        break;
      }
    }
    if (src[i] !== '{') continue; // an overload signature
    const start = i; depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) break; }
    }
    out.push({ name: m[1], body: src.slice(start, i + 1) });
  }
  return out;
}

const failures = [];
const checked = [];
for (const rel of MODULES) {
  const file = rel.split('/').pop();
  let src;
  try { src = readFileSync(resolve(ROOT, rel), 'utf8'); } catch { failures.push(`${rel}: missing`); continue; }
  for (const fn of functions(src)) {
    const writes = WRITER_NAME.test(fn.name) || INDEXED_TABLE_WRITE.test(fn.body) || TENANT_TABLE_WRITES.some((re) => re.test(fn.body));
    if (!writes) continue;
    const key = `${file}:${fn.name}`;
    const hooked = HOOK.test(fn.body);
    checked.push({ key, hooked, exempt: EXEMPT[key] ?? null });
    if (!hooked && !EXEMPT[key]) failures.push(`${key} writes but never calls noteSearchWrite (hook it after the commit, or exempt it with a reason in scripts/check-search-writers.mjs)`);
  }
}
for (const key of Object.keys(EXEMPT)) {
  const hit = checked.find((c) => c.key === key);
  if (!hit) failures.push(`${key} is exempt but no such writer exists any more — drop the exemption`);
  else if (hit.hooked) failures.push(`${key} is exempt but now calls noteSearchWrite — drop the exemption`);
}
if (process.argv.includes('--json')) console.log(JSON.stringify({ checked, failures }, null, 1));
else {
  console.log(`search writers: ${checked.filter((c) => c.hooked).length} hooked, ${checked.filter((c) => !c.hooked && c.exempt).length} exempt, ${failures.length} failing`);
  for (const f of failures) console.log(`  FAIL ${f}`);
}
process.exit(failures.length ? 1 : 0);
