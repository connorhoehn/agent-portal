// The lab loop's durable half — fleet memory and human consults, offline.
//
// `MOCK_EXPERIENCES` and `MOCK_CONSULTS` were two bare `[]`s inside
// providers/lab.ts, each with a module-level `expSeq`/`conSeq` counter beside
// it. Three things were wrong with that, and they compound:
//
//   1. NOTHING COULD BE UNDONE. `POST /api/lab/experiences`,
//      `POST /api/lab/consults` and `POST /api/lab/consults/:id/answer` all
//      append or mutate, and `POST /api/__mock/reset` reached none of them —
//      an auditor's consult stayed on the Work page until the process
//      restarted.
//   2. THE COUNTERS OUTLIVED THE ROWS. `++expSeq` is monotonic in the process,
//      so after a reset the store would be empty while the next id was
//      `exp-mock-9`. `nextMockExperienceId` below reads the high-water mark off
//      the live rows instead, which is right in both directions — the same fix
//      mock/org-findings.ts made for `find-mock-N`.
//   3. THE STORE WAS EMPTY, so `GET /api/lab/experiences` returned `[]` and an
//      unbuilt feature and an unseeded one looked identical (contract.ts #5).
//      The write sweep could not even synthesise a body for
//      `POST /api/rediscovery/outcomes`, because it picks an `experienceId`
//      off that list and the list had nothing in it.
//
// AGE IS THE CLAIM FOR AN EXPERIENCE, NOT THE DAY — fleet memory is ranked by
// relevance and rendered as prose ("19 days ago"), nothing buckets it by
// calendar day — so the experiences below take a plain `clock.daysAgo`.
//
// A CONSULT IS DIFFERENT, and it is the one place on this surface where the
// clock is load-bearing rather than decorative: `expireStale` expires a
// `pending` consult 30 minutes after `createdAt`, on read. So the seeded
// pending consult is stamped minutes ago, not hours — a seed stamped
// `hoursAgo(3)` would arrive already `expired` and the Work page's "waiting on
// you" panel would be empty in every fresh process. It does age out of the
// window in a long-running dev session, exactly as a real one would;
// `POST /api/__mock/reset` re-stamps it.

import { clock, defineFixture } from './core/index.js';
// Type-only, so it is erased at compile: providers/lab.ts imports the fixtures
// below at run time, and a value import back the other way would be a genuine
// cycle rather than a shared shape.
import type { LabConsult, LabExperience } from '../providers/lab.js';

/**
 * What the fleet has learned, across repos on purpose: the point of fleet
 * memory is that the answer to today's problem is usually somewhere else.
 * Every `kind` the store accepts is represented, because a kind filter with no
 * rows behind it is indistinguishable from a broken query.
 *
 * These are deliberately the same incidents mock/promotions.ts clusters into
 * candidates — an observation and the pattern it feeds are two views of one
 * event, and inventing a second, disjoint cast would make the ladder's own
 * story unreadable.
 */
function seedExperiences(): LabExperience[] {
  return [
    {
      id: 'exp-mock-1',
      sessionId: 'sess-mock-aurora-cold-start-000000000001', boxId: 'box-mock-1',
      repo: 'aws-agentcore', initiativeId: 'p-observability',
      kind: 'worked',
      title: 'Warm-up SELECT 1 then a 6x3s backoff clears the Aurora cold-start race',
      body: 'The first Data API call to a scale-to-zero 0.5-ACU cluster fails with '
          + 'HttpEndpointNotEnabledException until the HTTP endpoint enables. Genuine SQL errors '
          + 'still raise immediately, so the loop does not mask real bugs.',
      tags: ['aurora', 'data-api', 'cold-start'],
      createdAt: clock.daysAgo(6),
    },
    {
      id: 'exp-mock-2',
      sessionId: 'sess-mock-arm64-fargate-0000000000001', boxId: 'box-mock-1',
      repo: 'aws-agentcore', initiativeId: 'p-agent-fleet-ops',
      kind: 'failed',
      title: 'Fargate replaced the middleware task in a loop with exec format error',
      body: 'The image was built on Apple Silicon and Fargate defaulted the task definition to '
          + 'x86_64. The service sat in UPDATE_IN_PROGRESS the whole time and no log line named '
          + 'the architecture.',
      tags: ['fargate', 'arm64'],
      createdAt: clock.daysAgo(12),
    },
    {
      id: 'exp-mock-3',
      sessionId: 'sess-mock-adot-configurator-00000000001', boxId: 'box-mock-2',
      repo: 'aws-agentcore', initiativeId: 'p-observability',
      kind: 'gotcha',
      title: 'Vanilla opentelemetry-distro leaves aws/spans silently empty on AgentCore Runtime',
      body: 'AgentCore Runtime injects OTEL_PYTHON_CONFIGURATOR=aws_configurator, which only '
          + 'exists in aws-opentelemetry-distro. With the vanilla package no configurator loads '
          + 'and no spans ever export — no error, just silence.',
      tags: ['otel', 'adot', 'agentcore'],
      createdAt: clock.daysAgo(9),
    },
    {
      id: 'exp-mock-4',
      sessionId: 'sess-mock-custodian-sg-drift-000000001', boxId: 'box-mock-2',
      repo: 'aws-agentcore', initiativeId: 'p-security-baseline',
      kind: 'decision',
      title: 'Decided to allow-list the caller CIDR rather than fight the custodian',
      body: 'custodian-restrict-security-group-admin-ingress revokes 0.0.0.0/0 ingress within '
          + 'seconds, with no stack event and no drift. openListener: false plus an explicit '
          + 'allow-list CIDR is the shape that survives.',
      tags: ['security-groups', 'custodian'],
      createdAt: clock.daysAgo(2),
    },
    {
      id: 'exp-mock-5',
      sessionId: 'sess-mock-session-storage-cache-00000001', boxId: 'box-mock-3',
      repo: 'orgiq-portal', initiativeId: 'p-observability',
      kind: 'convention',
      title: 'Treat /mnt/workspace as a cache, never a durable store',
      body: 'Session storage is wiped on every runtime version update and after 14 days idle, so '
          + 'every image push resets it. Push work out through git or the command API before the '
          + 'session ends.',
      tags: ['devbox', 'session-storage'],
      createdAt: clock.daysAgo(20),
    },
  ];
}

/**
 * Questions a run put to a human.
 *
 * One `pending` (so the Work page's consult panel has something to render and
 * `POST /api/lab/consults/:id/answer` has something to answer), one already
 * `answered` (so the answered state is auditable without first answering one),
 * and one `expired` (the state nobody produces on purpose and everybody has to
 * render — a poller that crashed and left its question behind).
 *
 * The pending row's age is the load-bearing one: see the header note on
 * `expireStale`.
 */
function seedConsults(): LabConsult[] {
  return [
    {
      id: 'con-mock-1',
      sessionId: 'sess-mock-auth-cutover-order-000000000001', boxId: 'box-mock-2',
      repo: 'aws-agentcore', initiativeId: 'p-auth-migration',
      question: 'Cut tenants over smallest-first or riskiest-first? The runbook cannot be written until this is settled.',
      context: 'wi-auth-e2-s2 is blocked on it, and the decision is escalated to a release manager.',
      status: 'pending',
      answer: null, answeredBy: null,
      // Minutes, not hours — a pending consult stamped outside the 30-minute
      // window arrives already expired. See the header.
      createdAt: clock.hoursAgo(0.15),
      answeredAt: null,
    },
    {
      id: 'con-mock-2',
      sessionId: 'sess-mock-collector-oom-00000000000000001', boxId: 'box-mock-1',
      repo: 'aws-agentcore', initiativeId: 'p-observability',
      question: 'Is bounding the collector queue acceptable if it means dropping spans under burst?',
      context: 'wi-obs-e1-b5 — the collector OOMs under burst ingest with an unbounded queue.',
      status: 'answered',
      answer: 'Yes. Bound it and export the drop count as a metric — a dropped span you can see beats a collector you cannot restart.',
      answeredBy: 'p-004',
      createdAt: clock.hoursAgo(30),
      answeredAt: clock.hoursAgo(29),
    },
    {
      id: 'con-mock-3',
      sessionId: 'sess-mock-abandoned-poller-0000000000001', boxId: 'box-mock-3',
      repo: 'orgiq-portal', initiativeId: null,
      question: 'Should the terminal dock survive a tenant switch?',
      context: null,
      status: 'expired',
      answer: null, answeredBy: null,
      createdAt: clock.hoursAgo(52),
      answeredAt: null,
    },
  ];
}

/**
 * Fleet memory.
 *
 * `empty` — a brand-new fleet that has learned nothing yet. Declared
 *           explicitly: an undeclared scenario falls back to `default`, and
 *           "no memory for this repo yet" is the copy a recall with no hits
 *           renders — the one state a seeded store can never show.
 */
export const labExperiences = defineFixture<LabExperience>({
  key: 'lab-experiences',
  scenarios: {
    default: seedExperiences,
    empty: () => [],
  },
});

/** Human consults. `empty` is "nothing is waiting on a person right now". */
export const labConsults = defineFixture<LabConsult>({
  key: 'lab-consults',
  scenarios: {
    default: seedConsults,
    empty: () => [],
  },
});

/**
 * The next `exp-mock-N` / `con-mock-N` id, read off the live rows.
 *
 * A module counter is wrong in both directions across a reset — it keeps
 * climbing past ids nothing holds, and a counter reset with the fixture
 * re-mints an id the seed already owns. Only the `-mock-` family is scanned,
 * so nothing minted here can land on a seeded id.
 */
function nextId(prefix: string, ids: Iterable<string>): string {
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const id of ids) {
    const m = re.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${max + 1}`;
}

export function nextMockExperienceId(): string {
  return nextId('exp-mock', labExperiences.rows().map((e) => e.id));
}

export function nextMockConsultId(): string {
  return nextId('con-mock', labConsults.rows().map((c) => c.id));
}
