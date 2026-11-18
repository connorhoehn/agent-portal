// The seeded ids of the interviews tenant by what each row is, and the parser of the judge's 404 tables. Pure:
// no browser and no server, so the judge (scripts/validate-interviews.sh) and a plain node test can read it.
// scripts/journeys/interviews/lib.mjs re-exports everything here for the walk's pieces.
import assert from 'node:assert/strict';

/**
 * The seeded world (middleware/src/mock/interviews.ts), named by what each row is. A piece reads ids from here
 * and never types one: a reseed then changes this table and nothing else. scripts/journeys/tests/interviews-seed.test.mjs
 * fails when an id here is not in the fixture.
 */
export const SEED = Object.freeze({
  cast: Object.freeze({
    recruiter: 'u-greta',          // Greta Lindqvist: every opening, ManageCandidates
    interviewer: 'u-hugo',         // Hugo Marchetti: leads the Backend coding and design rounds
    interviewer2: 'u-wen',         // Wen Zhao: leads the iOS and the behavioural rounds
    hiringManager: 'u-amara',      // Amara Okafor: the Backend and Engineering Manager openings, not iOS
    workOnly: 'u-theo',            // holds nothing in this tenant (the other-workspace page; the API's 403)
  }),
  names: Object.freeze({ 'u-greta': 'Greta Lindqvist', 'u-hugo': 'Hugo Marchetti', 'u-wen': 'Wen Zhao', 'u-amara': 'Amara Okafor' }),
  openings: Object.freeze({ backend: 'op-backend', ios: 'op-ios', em: 'op-em' }),
  candidates: Object.freeze({
    mateo: 'cand-rx6tcaqj', ingrid: 'cand-qz63q3a3', kwame: 'cand-nx59ftdv', lucia: 'cand-88j9dpte', daniel: 'cand-d7vdruga', aiko: 'cand-s52jevud',
    ravi: 'cand-w4pvy8m9', chloe: 'cand-9p2atayb', samuel: 'cand-6smu3v2v', nadia: 'cand-xbmv4nvd', jonah: 'cand-zrtncmb2', elif: 'cand-pf3xhgxf',
  }),
  applications: Object.freeze({
    mateo: 'app-7b69njmx', ingrid: 'app-vfzc2x6g', kwame: 'app-pn7v4yev', lucia: 'app-g393z287', daniel: 'app-y2pmbks8', aiko: 'app-3j6avdmd',
    ravi: 'app-j7zuguu3', chloe: 'app-4shk59u3', samuel: 'app-ddk4nvfg', nadia: 'app-efd7rc6g', jonah: 'app-5j2chffb', elif: 'app-5xecwhnp',
  }),
  rounds: Object.freeze({ coding: 'rd-coding', design: 'rd-design', together: 'rd-together', leadership: 'rd-leadership' }),
  /** Interviews by candidate and round, with the seeded state, lead and panel in the comment. */
  interviews: Object.freeze({
    ingridCoding: 'iv-d7q4n9xe',     // scored, technical, lead Hugo, 9 days ago
    ingridTogether: 'iv-f2b6t5zh',   // scored, behavioural, lead Wen, 6 days ago
    mateoCoding: 'iv-j6x2d9sb',      // scored, technical, lead Hugo, 3 days ago
    raviCoding: 'iv-p2v7j4ye',       // scored, technical, lead Wen, 2 days ago
    jonahLeadership: 'iv-g9r1y8lp',  // ended yesterday, behavioural, lead Wen: Wen's scorecard is due
    mateoDesign: 'iv-k1p5w8ra',      // ready, technical, lead Hugo, tomorrow: the default interview for a candidate's visit
    aikoCoding: 'iv-c3k8w2ma',       // ready, technical, lead Wen, in 2 days
    kwameCoding: 'iv-h4m7c3vu',      // (the key is old) Kwame's system design round: assigned (nobody has answered), lead Hugo, in 3 days
    kwameLive: 'iv-s4e8u2zk',        // Kwame's coding round, live since twelve minutes ago: lead Hugo, Wen on the panel, no call yet
    raviTogether: 'iv-r6d1k9wt',     // assigned, behavioural, lead Wen, in 4 days
    nadiaDesign: 'iv-m8t3h6ng',      // accepted, technical, lead Hugo, in 5 days
    nadiaLeadership: 'iv-n5z9f2cq',  // accepted, behavioural, lead Wen with Hugo on the panel, in 6 days
  }),
  /** The interview a candidate's visit uses unless a piece needs another: ready, a lead, a time tomorrow. */
  guestInterview: 'iv-k1p5w8ra',
  /** The one seeded interview with a panel member (Hugo, beside Wen who leads). */
  panelInterview: 'iv-n5z9f2cq',
});

/** `{interviews.mateoDesign}` in a path → the seeded id. An unknown name throws: a table never guesses. */
export function seedPath(template) {
  return template.replace(/\{([a-zA-Z0-9]+)\.([a-zA-Z0-9]+)\}/g, (_, group, name) => {
    const id = SEED[group]?.[name];
    assert.ok(typeof id === 'string', `no seeded id {${group}.${name}}`);
    return id;
  });
}

/**
 * Parse a 404 table (scripts/validate-interviews.d/<row>.404). One route per line:
 *
 *   METHOD /api/path/with/{interviews.mateoDesign} | refused principals | allowed principals | {"json":"body"}
 *
 * A principal is a cast name (recruiter, interviewer, interviewer2, hiringManager, workOnly), `anon` (no session),
 * `guest` (a candidate holding a link to SEED.guestInterview) or `guest:<interviews name>` (a link to that one).
 * Refused means 404 unless the principal says otherwise (`guest=401`, `workOnly=403`). Allowed means the route did
 * not refuse: any status but 401, 403 and 404 (a write with no body may well answer 400; that is not a refusal).
 * The last two columns are optional. `#` starts a comment; blank lines are skipped.
 */
export function parseRefusalTable(text) {
  const rows = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) return;
    const cols = line.split('|').map((c) => c.trim());
    const m = /^(GET|POST|PUT|DELETE|PATCH)\s+(\/\S+)$/.exec(cols[0] ?? '');
    assert.ok(m, `line ${i + 1}: expected "METHOD /path", got "${cols[0]}"`);
    const principals = (col, fallback) => (col ?? '').split(/\s+/).filter(Boolean).map((p) => {
      const [who, status] = p.split('=');
      return { who, want: status ? Number(status) : fallback };
    });
    const refused = principals(cols[1], 404);
    assert.ok(refused.length > 0, `line ${i + 1}: no refused principal`);
    rows.push({ line: i + 1, method: m[1], path: seedPath(m[2]), refused, allowed: principals(cols[2], null), body: cols[3] ? JSON.parse(cols[3]) : undefined });
  });
  return rows;
}
