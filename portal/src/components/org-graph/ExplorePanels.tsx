// Critical-path panels for the Explore page:
//   GraphSearchBox   — find a person (name/title/department) or a skill and
//                      jump the graph to them. No more eyeballing 56 nodes.
//   PersonDetailCard — click a person → who they are: role, skills, influence,
//                      strongest connections (from /api/graph/people/:id).
//
// Both follow the ExplorePage idiom: inline styles + CSS variables.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import type { GraphPerson, GraphRelationship, GraphDepartment } from './types';

// ── GraphSearchBox ───────────────────────────────────────────────────────────

interface SkillMatch {
  skill: string;
  personIds: string[];
}

interface GraphSearchBoxProps {
  people: GraphPerson[];
  /** Single-person pick — select + focus + open detail. */
  onPickPerson: (id: string) => void;
  /** Skill pick — select everyone holding the skill. */
  onPickSkill: (skill: string, personIds: string[]) => void;
}

export function GraphSearchBox({ people, onPickPerson, onPickSkill }: GraphSearchBoxProps) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const { personMatches, skillMatches } = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (needle.length < 2) return { personMatches: [] as GraphPerson[], skillMatches: [] as SkillMatch[] };

    const persons = people
      .filter(p =>
        p.name.toLowerCase().includes(needle) ||
        p.title.toLowerCase().includes(needle) ||
        p.department.toLowerCase().includes(needle))
      .slice(0, 6);

    const bySkill = new Map<string, string[]>();
    for (const p of people) {
      for (const s of p.skills) {
        if (!s.toLowerCase().includes(needle)) continue;
        const arr = bySkill.get(s) ?? [];
        arr.push(p.id);
        bySkill.set(s, arr);
      }
    }
    const skills = [...bySkill.entries()]
      .map(([skill, personIds]) => ({ skill, personIds }))
      .sort((a, b) => b.personIds.length - a.personIds.length)
      .slice(0, 4);

    return { personMatches: persons, skillMatches: skills };
  }, [q, people]);

  const totalRows = personMatches.length + skillMatches.length;

  function pick(index: number) {
    if (index < personMatches.length) {
      const p = personMatches[index]!;
      onPickPerson(p.id);
    } else {
      const s = skillMatches[index - personMatches.length];
      if (!s) return;
      onPickSkill(s.skill, s.personIds);
    }
    setQ('');
    setOpen(false);
    setHighlight(0);
  }

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <input
        type="search"
        role="combobox"
        aria-expanded={open && totalRows > 0}
        aria-label="Find a person or skill"
        placeholder="Find a person or skill…"
        value={q}
        onChange={e => { setQ(e.target.value); setOpen(true); setHighlight(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(h + 1, totalRows - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)); }
          else if (e.key === 'Enter' && totalRows > 0) { e.preventDefault(); pick(highlight); }
          else if (e.key === 'Escape') { setOpen(false); setQ(''); }
        }}
        style={{
          width: 210, padding: '4px 10px', borderRadius: 9999, fontSize: 12,
          fontFamily: 'inherit',
          border: '1.5px solid var(--color-border)',
          background: 'var(--color-bg, #fff)',
          color: 'var(--color-text-primary)',
          outline: 'none',
        }}
      />
      {open && totalRows > 0 && (
        <div role="listbox" style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 120,
          width: 290, maxHeight: 340, overflowY: 'auto',
          background: 'var(--color-surface, #fff)',
          border: '1px solid var(--color-border, #e2e8f0)',
          borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
          padding: '4px 0',
        }}>
          {personMatches.map((p, i) => (
            <button
              key={p.id}
              role="option"
              aria-selected={highlight === i}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => pick(i)}
              style={searchRowStyle(highlight === i)}
            >
              <span style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
              <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {p.title} · {p.department}
              </span>
            </button>
          ))}
          {skillMatches.length > 0 && (
            <div style={{ padding: '5px 12px 3px', fontSize: 10, fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--color-text-tertiary)' }}>
              Skills
            </div>
          )}
          {skillMatches.map((s, j) => {
            const i = personMatches.length + j;
            return (
              <button
                key={s.skill}
                role="option"
                aria-selected={highlight === i}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => pick(i)}
                style={searchRowStyle(highlight === i)}
              >
                <span style={{ fontWeight: 600 }}>{s.skill}</span>
                <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{s.personIds.length} people</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function searchRowStyle(active: boolean): CSSProperties {
  return {
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1,
    width: '100%', padding: '6px 12px', border: 'none', textAlign: 'left',
    background: active ? 'var(--color-primary-subtle, #eef2ff)' : 'transparent',
    color: 'var(--color-text-primary)', fontSize: 12, cursor: 'pointer',
    fontFamily: 'inherit',
  };
}

// ── PersonDetailCard ─────────────────────────────────────────────────────────

interface ConnectionEntry {
  type: string;
  strength: number;
  otherPerson: { id: string; name: string; title: string } | null;
}

interface PersonDetailResponse {
  id: string;
  name: string;
  title: string;
  department: string;
  skills: string[];
  influenceScore: number;
  scoredAt: string | null;
  connections: ConnectionEntry[];
}

const CONNECTION_TYPE_LABELS: Record<string, string> = {
  collaborates: 'collaborates',
  mentors: 'mentors',
  reports_to: 'reports to',
  expert_in_common: 'shared expertise',
};

interface PersonDetailCardProps {
  personId: string;
  onClose: () => void;
  /** Click a connection → add that person to the graph selection. */
  onFocusPerson: (id: string) => void;
  /** "Ask agent" → open the chat pre-seeded with this person. */
  onAsk: (id: string) => void;
}

interface EvidenceResponse {
  documents: Array<{
    id: string;
    title: string;
    source: string;
    sourceUri: string | null;
    ingestedAt: string | null;
    mentionCount: number;
  }>;
}

export function PersonDetailCard({ personId, onClose, onFocusPerson, onAsk }: PersonDetailCardProps) {
  // Influence/scored-at are people-analytics numbers — the same data class the
  // ViewLeaderboard gate keeps behind /iq/scores. The graph roster endpoint
  // happens to carry them, but printing an influence figure on every person
  // card gave the whole org the HR read on each other; an SME looking for help
  // gets the person's skills, connections and evidence instead.
  const { session } = useSession();
  const showAnalytics =
    session?.role === 'org-leader' || session?.role === 'hr-admin' || session?.role === 'admin';
  const { data, isLoading, error } = useFetch<PersonDetailResponse>(
    `/api/graph/people/${encodeURIComponent(personId)}`,
  );
  const { data: evidence } = useFetch<EvidenceResponse>(
    `/api/graph/people/${encodeURIComponent(personId)}/evidence`,
  );
  const evidenceDocs = evidence?.documents ?? [];

  const topConnections = useMemo(() => {
    if (!data) return [] as ConnectionEntry[];
    return [...data.connections]
      .filter(c => c.otherPerson)
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 8);
  }, [data]);

  const maxStrength = Math.max(...topConnections.map(c => c.strength), 0.001);

  return (
    <div style={{
      position: 'absolute', top: 12, right: 12, zIndex: 60,
      width: 300, maxHeight: 'calc(100% - 24px)', overflowY: 'auto',
      background: 'var(--color-surface, #fff)',
      border: '1px solid var(--color-border, #e2e8f0)',
      borderRadius: 10, boxShadow: '0 8px 28px rgba(0,0,0,0.12)',
      padding: 14, fontSize: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {isLoading && <span style={{ color: 'var(--color-text-tertiary)' }}>Loading…</span>}
          {error && <span style={{ color: 'var(--color-error, #ef4444)' }}>Failed to load person</span>}
          {data && (
            <>
              <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--color-text-primary)' }}>{data.name}</div>
              <div style={{ color: 'var(--color-text-secondary)', marginTop: 2 }}>
                {data.title}{data.department ? ` · ${data.department}` : ''}
              </div>
            </>
          )}
        </div>
        <button onClick={onClose} aria-label="Close details" style={{
          border: 'none', background: 'transparent', cursor: 'pointer',
          color: 'var(--color-text-tertiary)', fontSize: 14, lineHeight: 1, padding: 2,
        }}>✕</button>
      </div>

      {data && (
        <>
          <div style={{ marginTop: 10, display: 'flex', gap: 14 }}>
            {showAnalytics && (
              <div>
                <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--color-text-tertiary)' }}>Influence</div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{data.influenceScore.toFixed(2)}</div>
              </div>
            )}
            <div>
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--color-text-tertiary)' }}>Connections</div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{data.connections.length}</div>
            </div>
            {showAnalytics && data.scoredAt && (
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--color-text-tertiary)' }}>Scored</div>
                <div style={{ fontWeight: 600, fontSize: 11, marginTop: 3 }}>{data.scoredAt.slice(0, 10)}</div>
              </div>
            )}
          </div>

          {data.skills.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--color-text-tertiary)', marginBottom: 5 }}>Skills</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {data.skills.map(s => (
                  <span key={s} style={{
                    padding: '2px 8px', borderRadius: 9999, fontSize: 11,
                    background: 'var(--color-primary-subtle, #eef2ff)',
                    color: 'var(--color-primary, #6366f1)', fontWeight: 500,
                  }}>{s}</span>
                ))}
              </div>
            </div>
          )}

          {topConnections.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--color-text-tertiary)', marginBottom: 5 }}>
                Strongest connections
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {topConnections.map((c, i) => (
                  <button
                    key={`${c.otherPerson!.id}-${c.type}-${i}`}
                    onClick={() => onFocusPerson(c.otherPerson!.id)}
                    title={`Add ${c.otherPerson!.name} to selection`}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      width: '100%', padding: '4px 6px', border: 'none', borderRadius: 6,
                      background: 'transparent', cursor: 'pointer', textAlign: 'left',
                      fontFamily: 'inherit', fontSize: 12, color: 'var(--color-text-primary)',
                    }}
                  >
                    <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      <span style={{ fontWeight: 600 }}>{c.otherPerson!.name}</span>
                      <span style={{ color: 'var(--color-text-tertiary)', fontSize: 11 }}> · {CONNECTION_TYPE_LABELS[c.type] ?? c.type}</span>
                    </span>
                    <span aria-hidden="true" style={{
                      width: 44, height: 4, borderRadius: 2, flexShrink: 0,
                      background: 'var(--color-border, #e2e8f0)', position: 'relative', overflow: 'hidden',
                    }}>
                      <span style={{
                        position: 'absolute', inset: 0, borderRadius: 2,
                        width: `${Math.round((c.strength / maxStrength) * 100)}%`,
                        background: 'var(--color-primary, #6366f1)',
                      }} />
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {evidenceDocs.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--color-text-tertiary)', marginBottom: 5 }}>
                Evidence · {evidenceDocs.length} documents
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {evidenceDocs.slice(0, 6).map(doc => (
                  <div key={doc.id} style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    <span style={{
                      flexShrink: 0, padding: '1px 6px', borderRadius: 4, fontSize: 9.5,
                      fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3,
                      background: 'var(--color-surface-hover, #f1f5f9)',
                      color: 'var(--color-text-secondary)',
                    }}>{doc.source || 'doc'}</span>
                    <span
                      title={doc.title}
                      style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 11.5 }}
                    >
                      {doc.title}
                    </span>
                    {doc.mentionCount > 1 && (
                      <span style={{ flexShrink: 0, fontSize: 10, color: 'var(--color-text-tertiary)' }}>×{doc.mentionCount}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <button
            onClick={() => onAsk(data.id)}
            style={{
              marginTop: 12, width: '100%', padding: '7px 0', borderRadius: 6,
              border: 'none', background: 'var(--color-primary, #6366f1)', color: '#fff',
              fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            Ask agent about {data.name.split(' ')[0]} →
          </button>
        </>
      )}
    </div>
  );
}

// ── Connection path finder ───────────────────────────────────────────────────

export interface PathHop {
  person: GraphPerson;
  /** Edge type that connects this person to the PREVIOUS hop (empty for hop 0). */
  viaType: string;
}

/**
 * BFS shortest path between two people over the full (unfiltered) edge set —
 * paths are allowed to cross relationship types the current view hides,
 * because "how are these two connected at all?" is the actual question.
 */
export function findConnectionPath(
  people: GraphPerson[],
  edges: GraphRelationship[],
  fromId: string,
  toId: string,
): PathHop[] | null {
  if (fromId === toId) return null;
  const byId = new Map(people.map(p => [p.id, p]));
  if (!byId.has(fromId) || !byId.has(toId)) return null;

  const adj = new Map<string, Array<{ other: string; type: string }>>();
  for (const e of edges) {
    (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push({ other: e.target, type: e.type });
    (adj.get(e.target) ?? adj.set(e.target, []).get(e.target)!).push({ other: e.source, type: e.type });
  }

  const prev = new Map<string, { from: string; type: string }>();
  const seen = new Set<string>([fromId]);
  let frontier = [fromId];
  let found = false;

  while (frontier.length > 0 && !found) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const { other, type } of adj.get(id) ?? []) {
        if (seen.has(other)) continue;
        seen.add(other);
        prev.set(other, { from: id, type });
        if (other === toId) { found = true; break; }
        next.push(other);
      }
      if (found) break;
    }
    frontier = next;
  }
  if (!found) return null;

  // Walk back from target to source.
  const hops: PathHop[] = [];
  let cursor = toId;
  while (cursor !== fromId) {
    const p = prev.get(cursor)!;
    hops.unshift({ person: byId.get(cursor)!, viaType: p.type });
    cursor = p.from;
  }
  hops.unshift({ person: byId.get(fromId)!, viaType: '' });
  return hops;
}

const PATH_TYPE_LABELS: Record<string, string> = {
  collaborates: 'collaborates with',
  mentors: 'mentors',
  reports_to: 'reports to',
  expert_in_common: 'shares expertise with',
};

interface ConnectionPathStripProps {
  path: PathHop[];
  /** Select every person on the path so the graph shows the corridor. */
  onHighlightPath: (ids: string[]) => void;
}

export function ConnectionPathStrip({ path, onHighlightPath }: ConnectionPathStripProps) {
  const intermediates = path.length - 2;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      padding: '6px 12px', fontSize: 12,
      background: 'var(--color-primary-subtle, #eef2ff)',
      borderBottom: '1px solid var(--color-border)',
    }}>
      <span style={{ fontWeight: 600, color: 'var(--color-primary, #6366f1)', whiteSpace: 'nowrap' }}>
        {intermediates === 0 ? 'Directly connected' : `Connected via ${intermediates} ${intermediates === 1 ? 'person' : 'people'}`}
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', minWidth: 0 }}>
        {path.map((hop, i) => (
          <span key={hop.person.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            {i > 0 && (
              <span style={{ color: 'var(--color-text-tertiary)', fontSize: 10, whiteSpace: 'nowrap' }}>
                —{PATH_TYPE_LABELS[hop.viaType] ?? hop.viaType}→
              </span>
            )}
            <span style={{ fontWeight: i === 0 || i === path.length - 1 ? 700 : 500, whiteSpace: 'nowrap' }}>
              {hop.person.name}
            </span>
          </span>
        ))}
      </span>
      {intermediates > 0 && (
        <button
          onClick={() => onHighlightPath(path.map(h => h.person.id))}
          style={{
            marginLeft: 'auto', padding: '3px 10px', borderRadius: 9999, border: 'none',
            background: 'var(--color-primary, #6366f1)', color: '#fff',
            fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
          }}
        >
          Show path on graph
        </button>
      )}
    </div>
  );
}

// ── Department focus chips ───────────────────────────────────────────────────

interface DepartmentChipsProps {
  departments: GraphDepartment[];
  people: GraphPerson[];
  activeDepartment: string | null;
  onToggle: (name: string | null, memberIds: string[]) => void;
}

export function DepartmentChips({ departments, people, activeDepartment, onToggle }: DepartmentChipsProps) {
  const counts = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const p of people) {
      const arr = m.get(p.department) ?? [];
      arr.push(p.id);
      m.set(p.department, arr);
    }
    return m;
  }, [people]);

  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
      {departments.map(d => {
        const members = counts.get(d.name) ?? [];
        if (members.length === 0) return null;
        const active = activeDepartment === d.name;
        return (
          <button
            key={d.id}
            onClick={() => onToggle(active ? null : d.name, members)}
            title={`${d.name} — ${members.length} people`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '2px 9px', borderRadius: 9999, fontSize: 11, fontFamily: 'inherit',
              border: active ? `1.5px solid ${d.color}` : '1.5px solid var(--color-border)',
              background: active ? 'var(--color-primary-subtle, #eef2ff)' : 'transparent',
              color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
              fontWeight: active ? 600 : 400,
              cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: d.color, flexShrink: 0 }} />
            {d.name}
            <span style={{ color: 'var(--color-text-tertiary)', fontSize: 10 }}>{members.length}</span>
          </button>
        );
      })}
    </span>
  );
}

// ── Department insight strip ─────────────────────────────────────────────────
//
// Shown while a department chip is active: headcount, the department's top
// skills, and bus-factor risk — skills held by RARE_THRESHOLD or fewer people
// org-wide, where at least one holder sits in this department.

const RARE_THRESHOLD = 2;

interface DepartmentInsightStripProps {
  department: string;
  people: GraphPerson[];
  /** Click an at-risk holder → focus them (select + detail). */
  onFocusPerson: (id: string) => void;
}

export function DepartmentInsightStrip({ department, people, onFocusPerson }: DepartmentInsightStripProps) {
  const { members, topSkills, atRisk } = useMemo(() => {
    const members = people.filter(p => p.department === department);

    const deptSkillCount = new Map<string, number>();
    for (const p of members) {
      for (const s of p.skills) deptSkillCount.set(s, (deptSkillCount.get(s) ?? 0) + 1);
    }
    const topSkills = [...deptSkillCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);

    // Org-wide holder map → single-holder skills owned by this department.
    const orgHolders = new Map<string, GraphPerson[]>();
    for (const p of people) {
      for (const s of p.skills) {
        const arr = orgHolders.get(s) ?? [];
        arr.push(p);
        orgHolders.set(s, arr);
      }
    }
    const atRisk = [...orgHolders.entries()]
      .filter(([, holders]) =>
        holders.length <= RARE_THRESHOLD &&
        holders.some(h => h.department === department))
      .map(([skill, holders]) => ({
        skill,
        holder: holders.find(h => h.department === department)!,
        holderCount: holders.length,
      }))
      .sort((a, b) => a.holderCount - b.holderCount)
      .slice(0, 8);

    return { members, topSkills, atRisk };
  }, [department, people]);

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
      padding: '6px 12px', fontSize: 12,
      background: 'var(--color-primary-subtle, #eef2ff)',
      borderBottom: '1px solid var(--color-border)',
    }}>
      <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
        {department} · {members.length} people
      </span>
      {topSkills.length > 0 && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', color: 'var(--color-text-secondary)' }}>
          <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--color-text-tertiary)' }}>Top skills</span>
          {topSkills.map(([skill, n]) => (
            <span key={skill} style={{ whiteSpace: 'nowrap' }}>
              {skill} <span style={{ color: 'var(--color-text-tertiary)', fontSize: 10 }}>({n})</span>
            </span>
          ))}
        </span>
      )}
      {atRisk.length > 0 && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
          <span style={{
            fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 700,
            color: 'var(--color-warning, #d97706)', whiteSpace: 'nowrap',
          }}>⚠ rare skills</span>
          {atRisk.map(({ skill, holder, holderCount }) => (
            <button
              key={skill}
              onClick={() => onFocusPerson(holder.id)}
              title={`${skill} — only ${holderCount} ${holderCount === 1 ? 'person' : 'people'} org-wide. Click to focus ${holder.name}.`}
              style={{
                padding: '1px 8px', borderRadius: 9999, fontSize: 11, fontFamily: 'inherit',
                border: '1px solid var(--color-warning, #d97706)',
                background: 'transparent', color: 'var(--color-warning, #b45309)',
                cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              {skill} · {holder.name.split(' ')[0]}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}
