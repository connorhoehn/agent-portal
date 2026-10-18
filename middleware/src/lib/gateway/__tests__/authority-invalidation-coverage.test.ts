// Every authority write calls the invalidation seam (lib/gateway/authority-invalidation.ts).
//
// The gateway caches POSITIVE channel verdicts. A write that removes authority
// and does not tell the seam leaves the old verdict admitting frames until
// maxAgeMs (authority-cache-contract.test.ts shows it happen). This file is the
// static half of that contract:
//
//   1. SURFACES: in each file that writes an input of the channel decision, a
//      function containing a write site must also call the seam (or a helper
//      verified below to call it), or be listed in `exempt` with the reason it
//      cannot narrow anyone's authority;
//   2. ELSEWHERE: the same write signatures anywhere else under src/ fail, so a
//      new writer of grants, rosters, seats, access rows, team rows or Cedar
//      policies has to be registered here — and so has to call the seam;
//   3. WIRING: the gateway binds the cache to the seam, and committed Social
//      membership writes reach it (locally and from peers).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..', '..');
/** Blank comments and import statements (same length, newlines kept): a name there is not a write. */
const blank = (text: string) => text.replace(/[^\n]/g, ' ');
const code = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, blank)
  .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)))
  .replace(/^import[\s\S]*?;$/gm, blank);
const read = (file: string) => code(readFileSync(join(ROOT, file), 'utf8'));

const SEAM = /\b(invalidateForUser|invalidateChannel|invalidateAll|applyChannel)\(/;

interface Surface {
  file: string;
  /** Where an authority input is written. */
  sites: RegExp;
  /** What a writing function must call: the seam, or a helper checked in `helpers`. */
  calls: RegExp;
  /** Helper name → what its own body must call. */
  helpers?: Record<string, RegExp>;
  /** Functions that match `sites` but cannot narrow anyone's authority, with why. */
  exempt?: Record<string, string>;
  /** Functions that must exist and write (guards a rename hiding a site). */
  known: string[];
}

const SURFACES: Surface[] = [
  {
    file: 'src/providers/identity.ts',
    sites: /GRANT_ROLE_SQL|REVOKE_ROLE_SQL|writeGrantSet\(|session_epoch = session_epoch \+ 1|\.epoch = \(|clone\.grants = |rows\[at\] = row|removeClone\(/,
    calls: /\bdirectoryChanged\(/,
    helpers: { directoryChanged: /\binvalidateForUser\(/ },
    known: ['bumpSessionEpoch', 'applyMockGrants', 'writeRole', 'setGrants', 'deleteIdentityClone'],
  },
  {
    file: 'src/providers/social-platform.ts',
    sites: /teamRosterMirror\.(set|clear)\(|teamRosterMirror\.get\([^)]*\)\?\.delete\(|members\.(splice|push)\(|socialTeamMembersFixture\.rows\(\)\.push\(/,
    calls: SEAM,
    exempt: {
      mirrorAdd: 'adds a member to the roster mirror: a grant, which the cache never needs told about (refusals are not cached)',
      createTeamRow: 'a new team and its creator: no verdict on its channels can exist yet',
    },
    known: ['getTeam', 'addTeamMemberRow', 'removeTeamMemberRow', 'resetSocialTeamMirror'],
  },
  {
    file: 'src/lib/social-chat.ts',
    sites: /persist\.putMember\(|this\.upsert\(/,
    // MirroredMembershipStore.putMember notifies onCommittedWrite; the gateway
    // binds that to applyChannel (WIRING below) and the Redis router to the peers.
    calls: /this\.writeObservers\)/,
    known: ['putMember'],
  },
  {
    file: 'src/lib/call-chat.ts',
    sites: /control\.departed\.(add|delete)\(|control\.ended = true|state\.leave\(/,
    calls: SEAM,
    known: ['invalidate', 'registeredCurrent', 'removed', 'restoredCurrent', 'reconcile', 'finish'],
  },
  {
    file: 'src/providers/access.ts',
    sites: /accessRequestsFixture\.rows\(\)\.push\(|requests\[i\] = |accessStepsFixture\.rows\(\)\.push\(|all\[j\] = |Object\.assign\(row, |rows\.push\(stored\)|row\.endedAt = |row\.(sensitive|defaultDuration) = /,
    calls: SEAM,
    exempt: {
      casReviewItem: 'access reviews are not an input of the thread read rule (lib/access/rules.ts mayRead)',
    },
    known: ['insertRequest', 'saveTransition', 'casRequest', 'casStep', 'insertDelegation', 'endDelegation', 'updateCatalogItem'],
  },
  {
    file: 'src/providers/assessment.ts',
    sites: /deleteTeamRow\(|dropTeam\(/,
    calls: SEAM,
    known: ['deleteTeamImpl'],
  },
  {
    file: 'src/lib/authz.ts',
    sites: /\bcache\.clear\(\)/,
    calls: SEAM,
    known: ['clearAuthzCache'],
  },
  {
    file: 'src/routes/identity.ts',
    sites: /new (Create|Update|Delete)PolicyCommand\(|new PutSchemaCommand\(/,
    calls: /\bclearAuthzCache\(/,
    known: [],
  },
  {
    file: 'src/routes/mock-control.ts',
    sites: /\.resetAll\(|\bfixture\.reset\(\)|\bpin\(fixture, /,
    calls: /\brehydrateAll\(/,
    helpers: { rehydrateAll: /\binvalidateAll\(/ },
    known: [],
  },
];

/** Write signatures that must not appear outside the registered surfaces. */
const SIGNATURES: Array<{ what: string; pattern: RegExp; allowed: string[] }> = [
  // An EXECUTION of the grant/epoch statements (lib/access/sql.ts re-exports and
  // defines them for the provisioning lane; running them must go through the seam).
  { what: 'a grant/epoch write', pattern: /\b\w*(?:exec|execute|query|send)\w*\([^)]*\b(?:GRANT_ROLE_SQL|REVOKE_ROLE_SQL|BUMP_EPOCH_SQL|END_GRANT_SQL)\b|session_epoch = session_epoch|writeGrantSet\(/,
    allowed: ['src/providers/identity.ts', 'src/lib/identity-grants-sql.ts'] },
  { what: 'a Social team roster write', pattern: /socialTeamMembersFixture\.rows\(\)\.(push|splice)\(|teamRosterMirror\.(set|delete|clear)\(/,
    allowed: ['src/providers/social-platform.ts'] },
  { what: 'an access request/step/delegation write', pattern: /(accessRequestsFixture|accessStepsFixture|accessDelegationsFixture|accessCatalogFixture)\.rows\(\)\.(push|splice)\(/,
    allowed: ['src/providers/access.ts'] },
  { what: 'an assessment team delete', pattern: /\bdeleteTeamRow\(|\bdropTeam\(/,
    // assessment-aurora.ts / mock/assessment.ts are the two stores deleteTeam() calls.
    allowed: ['src/providers/assessment.ts', 'src/providers/assessment-aurora.ts', 'src/mock/assessment.ts'] },
  { what: 'a Cedar policy write', pattern: /new (Create|Update|Delete)PolicyCommand\(|new PutSchemaCommand\(/,
    // Boot seeding runs before the gateway accepts a socket.
    allowed: ['src/routes/identity.ts', 'src/lib/policy-seeds.ts'] },
  { what: 'a huddle seat departure', pattern: /\.departed\.add\(/, allowed: ['src/lib/call-chat.ts'] },
];

// ── a small source walker: named functions/methods and their brace-matched bodies ──

type Fn = { name: string; start: number; end: number };
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'await', 'function', 'new', 'typeof', 'else', 'do', 'try']);
/** An Express handler `router.<verb>('/path', …, async (req, res) => {` is named `<VERB> /path`. */
const HANDLER = /\b\w+\.(get|post|put|patch|delete|use)\(\s*['"`]([^'"`]*)['"`][^\n]*=>\s*\{\s*$/;
const HEADER = /^\s*(?:export\s+)?(?:default\s+)?(?:(?:public|private|protected|static|readonly|override)\s+)*(?:async\s+)?(?:function\s*\*?\s*)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;

function functions(source: string): Fn[] {
  const lines = source.split('\n');
  const offsets: number[] = []; let at = 0;
  for (const line of lines) { offsets.push(at); at += line.length + 1; }
  const out: Fn[] = [];
  const close = (open: number): number => {
    let depth = 0, k = open;
    for (; k < source.length; k++) {
      const c = source[k];
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) break;
    }
    return k;
  };
  for (let i = 0; i < lines.length; i++) {
    const handler = HANDLER.exec(lines[i]!);
    if (handler) {
      const open = offsets[i]! + lines[i]!.lastIndexOf('{');
      out.push({ name: `${handler[1]!.toUpperCase()} ${handler[2]}`, start: open, end: close(open) });
      continue;
    }
    const m = HEADER.exec(lines[i]!);
    if (!m || KEYWORDS.has(m[1]!)) continue;
    // A one-line function: `function f(): void { … }`.
    const oneLine = /\)\s*(?::[^{]*)?\{.*\}\s*;?\s*$/.exec(lines[i]!);
    if (oneLine) {
      const open = offsets[i]! + lines[i]!.indexOf('{', lines[i]!.indexOf(')'));
      out.push({ name: m[1]!, start: open, end: close(open) });
      continue;
    }
    // The header ends on the first line ending in `{` before any line ending in `;`.
    let j = i;
    while (j < lines.length && !/\{\s*$/.test(lines[j]!) && !/;\s*$/.test(lines[j]!)) j++;
    if (j >= lines.length || !/\{\s*$/.test(lines[j]!)) continue;
    const open = offsets[j]! + lines[j]!.lastIndexOf('{');
    out.push({ name: m[1]!, start: open, end: close(open) });
  }
  return out;
}
const innermost = (fns: Fn[], index: number): Fn | null =>
  fns.filter(f => f.start <= index && index <= f.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0] ?? null;

function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap(name => {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : sourceFiles(rel);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [rel] : [];
  });
}

describe('every authority write calls the invalidation seam', () => {
  for (const surface of SURFACES) {
    it(surface.file, () => {
      const source = read(surface.file);
      const fns = functions(source);
      const body = (fn: Fn) => source.slice(fn.start, fn.end + 1);
      const writers = new Map<string, Fn>();
      const missing: string[] = [];
      for (const match of source.matchAll(new RegExp(surface.sites.source, 'g'))) {
        const lineStart = source.lastIndexOf('\n', match.index!) + 1;
        if (/^export \{/.test(source.slice(lineStart, lineStart + 8))) continue; // a re-export names, never writes
        const fn = innermost(fns, match.index!);
        if (!fn) { missing.push(`a write outside any named function: ${match[0]}`); continue; }
        writers.set(fn.name, fn);
        if (surface.exempt?.[fn.name]) continue;
        if (!surface.calls.test(body(fn)) && !SEAM.test(body(fn))) missing.push(`${fn.name}() writes (${match[0].trim()}) without calling the seam`);
      }
      for (const [helper, must] of Object.entries(surface.helpers ?? {})) {
        const fn = fns.find(f => f.name === helper);
        expect(fn && must.test(body(fn)) ? helper : `${helper} must call ${must}`).toBe(helper);
      }
      for (const name of surface.known) {
        if (!writers.has(name)) missing.push(`${name}() is no longer found writing — renamed? update this list`);
      }
      for (const name of Object.keys(surface.exempt ?? {})) {
        if (!writers.has(name)) missing.push(`exemption ${name}() no longer writes — remove it`);
      }
      expect(missing).toEqual([]);
    });
  }

  it('no authority write signature appears outside the registered surfaces', () => {
    const strays: string[] = [];
    for (const file of sourceFiles('src')) {
      const rel = relative(ROOT, join(ROOT, file));
      const source = read(rel);
      for (const sig of SIGNATURES) {
        if (sig.allowed.includes(rel)) continue;
        const hit = sig.pattern.exec(source);
        if (hit) strays.push(`${rel}: ${sig.what} (${hit[0]}) — call lib/gateway/authority-invalidation.ts after it commits and register it here`);
      }
    }
    expect(strays).toEqual([]);
  });

  it('the gateway binds its verdict cache to the seam, and membership writes and peer events reach it', () => {
    const gateway = read('src/lib/realtime-gateway.ts');
    expect(gateway).toMatch(/bindAuthorityCache\(verdicts\.cache, \{ peers: clusterRouter\?\.peerEvents/);
    expect(gateway).toMatch(/onCommittedWrite\(channel => applyChannel\(/);
    expect(gateway).toMatch(/membershipStore: chatBackend\.membershipStore/);
    expect(gateway).toMatch(/authorityCache: \{ invalidateChannel: \(channel: string\) => applyChannel\(/);
    expect(gateway).toMatch(/onDisconnect: \(clientId: string\) => \{ verdicts\.cache\.invalidateConnection\(clientId\)/);
  });

  it('the walker finds what it claims to (self-check)', () => {
    const fns = functions('export async function a(x: { y: number }): Promise<void> {\n  if (x) {\n    b();\n  }\n}\nclass K {\n  private async m(\n    q: string,\n  ): Promise<{ r: 1 }> {\n    return q;\n  }\n}\n');
    expect(fns.map(f => f.name)).toEqual(['a', 'm']);
  });
});
