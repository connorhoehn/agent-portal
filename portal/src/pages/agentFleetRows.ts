// The fleet as a list, built from the same two reads the diagram draws from.
//
// WHY THIS EXISTS. The Architecture page positions agents from a static
// catalog of six ids (`AGENTS` in AgentFlowPage.tsx) because an autolayout
// collapses to one layer when trace data is sparse. Drawing from a catalog is
// fine; *counting* from one is not. `ListAgentRuntimes` filters by nothing —
// not by tenant, not by framework — so the control plane returns every
// runtime in the account: the eight Strands agents plus devbox. The page
// rendered the six it had coordinates for and wrote "online / 6" underneath,
// so the two assessment agents were absent from the one page whose subject is
// the fleet, and the denominator agreed with the omission instead of
// contradicting it.
//
// These helpers take whatever the server actually returned and answer two
// questions the diagram cannot: what is the whole fleet, and which part of it
// the diagram is not showing.

export interface FleetRow {
  /** The id as the server spells it — a runtime id keeps its suffix. */
  id: string;
  /** The stable key the diagram and the topology overlay agree on. */
  key: string;
  /** Display name: the catalog's, the server's, else the id. */
  name: string;
  status: 'healthy' | 'degraded' | 'offline' | 'deploying' | 'unknown';
  protocol: string | null;
  model: string | null;
  tools: string[];
  invocationCount: number;
  errorCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
  /** False when the static diagram has no coordinates for this agent. */
  onDiagram: boolean;
}

/** What a caller must give us per agent. Mirrors AgentFlowPage's AgentSummary. */
export interface FleetSummaryLike {
  id: string;
  /** Widened on purpose: the caller's summary carries whatever the control
   *  plane sent, and an unrecognised label must read `unknown` here rather
   *  than be asserted into one of the four we know. */
  status?: string;
  protocol?: string;
  model?: string;
  tools?: string[];
  invocationCount: number;
  errorCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

/**
 * Build the list. `summaries` is keyed by canonical key (the diagram's
 * spelling); `display` maps those keys to the catalog's friendly names, and
 * its key set is exactly what the diagram can draw.
 */
export function fleetRows(
  summaries: Map<string, FleetSummaryLike>,
  display: Map<string, string>,
): FleetRow[] {
  const rows: FleetRow[] = [];
  for (const [key, s] of summaries) {
    rows.push({
      id: s.id,
      key,
      name: display.get(key) ?? prettyName(key),
      status: normalizeStatus(s.status),
      protocol: s.protocol ?? null,
      model: s.model ?? null,
      tools: s.tools ?? [],
      invocationCount: s.invocationCount,
      errorCount: s.errorCount,
      p50Ms: s.p50Ms,
      p95Ms: s.p95Ms,
      onDiagram: display.has(key),
    });
  }
  // Busiest first, because the reason to open this list is usually traffic.
  // Ties fall back to the name so the order is total and the table does not
  // reshuffle between polls when every agent is idle at zero.
  rows.sort((a, b) => b.invocationCount - a.invocationCount || a.name.localeCompare(b.name));
  return rows;
}

const KNOWN_STATUSES = new Set(['healthy', 'degraded', 'offline', 'deploying']);

/** Anything the fleet page has no tone for reads `unknown`, never `healthy`. */
function normalizeStatus(raw: string | undefined): FleetRow['status'] {
  return raw && KNOWN_STATUSES.has(raw) ? (raw as FleetRow['status']) : 'unknown';
}

/**
 * `orgiq-assessment-scorer` -> `Assessment Scorer`. Only ever reached for an
 * agent the catalog has never heard of, which is exactly the case this whole
 * module exists to stop hiding.
 */
export function prettyName(key: string): string {
  const stripped = key.replace(/^orgiq[-_]/, '');
  if (!stripped) return key;
  return stripped
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** How many agents the server returned that the diagram cannot place. */
export function offDiagramCount(rows: FleetRow[]): number {
  return rows.filter((r) => !r.onDiagram).length;
}

/**
 * The header's fleet line. The denominator is the fleet the server reported,
 * never the diagram's catalog — that swap is the defect this file is named
 * after. Returns null when the fleet read failed, so the caller shows an
 * admission rather than a number.
 */
export function onlineLabel(rows: FleetRow[], failed: boolean): string | null {
  if (failed) return null;
  const online = rows.filter((r) => r.status === 'healthy' || r.status === 'deploying').length;
  return `${online}/${rows.length}`;
}

/** Substring match over the fields a reader can see. Empty query is identity. */
export function filterFleet(rows: FleetRow[], query: string): FleetRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) =>
    r.name.toLowerCase().includes(q)
    || r.id.toLowerCase().includes(q)
    || (r.model ?? '').toLowerCase().includes(q)
    || r.tools.some((t) => t.toLowerCase().includes(q)),
  );
}
