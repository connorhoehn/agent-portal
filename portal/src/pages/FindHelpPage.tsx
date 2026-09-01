// Find Help — "who in the org can help me with X?"
//
// The SME's search, split off from Scores on purpose. Scores is the HR view:
// leaderboards, composites, cohort comparisons — leadership data behind
// ViewLeaderboard, which an SME doesn't hold (their nav item just 403'd).
// But the SME's actual question was never "rank my colleagues"; it is "I'm
// stuck on a domain, who can help?" — a lookup, not analytics.
//
// So this page runs on the ViewOrgChart tier every orgiq role already has
// (`GET /api/graph/help`), and shows EVIDENCE, not grades: matched skills,
// the documents they were derived from, the initiatives the person is on.
// No rank numbers anywhere — the deliberate design difference between this
// surface and /iq/scores.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  EmptyState,
  FilterChip,
  PageSection,
  SearchInput,
  SkeletonCard,
} from '@connorhoehnslalom/ui-components/shared';
import { ExpertCard } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../hooks/useFetch';

interface HelpDoc { id: string; title: string; source: string; sourceUri: string | null }
interface HelpPerson {
  id: string;
  name: string;
  title: string;
  department: string;
  matchedSkills: Array<{ name: string; strength: number }>;
  otherSkills: string[];
  contexts: string[];
  documents: HelpDoc[];
}
interface HelpResponse { query: string; people: HelpPerson[] }
interface SkillsGraph { domains: Array<{ id: string; name: string; skillCount: number }> }

export default function FindHelpPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [draft, setDraft] = useState(searchParams.get('q') ?? '');
  const query = searchParams.get('q') ?? '';

  // The URL is the state: a search someone found useful should be a link they
  // can send to the colleague who asked them the same question.
  useEffect(() => {
    const t = setTimeout(() => {
      const trimmed = draft.trim();
      if (trimmed === query) return;
      setSearchParams(trimmed ? { q: trimmed } : {}, { replace: true });
    }, 350);
    return () => clearTimeout(t);
  }, [draft, query, setSearchParams]);

  const { data, isLoading } = useFetch<HelpResponse>(
    query ? `/api/graph/help?q=${encodeURIComponent(query)}` : null,
  );
  // Domain chips come from the skills graph — already ViewOrgChart-tier. They
  // are the "what can I even ask?" affordance for a blank search box.
  const { data: skillsGraph } = useFetch<SkillsGraph>('/api/graph/skills-graph');
  const domains = useMemo(
    () => (skillsGraph?.domains ?? []).slice(0, 10),
    [skillsGraph],
  );

  const people = query ? data?.people ?? null : null;

  function ask(p: HelpPerson) {
    const skills = p.matchedSkills.map((s) => s.name).join(', ');
    const prompt = `I need help with ${query}. Is ${p.name} (${p.title}) the right person to ask — they show ${skills ? `evidence in ${skills}` : 'related experience'} — and how should I frame the question? If someone else is better placed, say who.`;
    navigate(`/iq/invoke?prompt=${encodeURIComponent(prompt)}`);
  }

  return (
    <PageSection
      title="Find help"
      description="Search a domain and get the people with real evidence behind it — what they've worked on, and where they spend their time."
    >
      <div className="flex flex-col gap-3 max-w-[560px]">
        <SearchInput
          value={draft}
          onChange={setDraft}
          onClear={() => setDraft('')}
          placeholder="Kubernetes, incident response, data modeling…"
        />
        {domains.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {domains.map((d) => (
              <FilterChip
                key={d.id}
                size="xs"
                active={query.toLowerCase() === d.name.toLowerCase()}
                onClick={() => setDraft(d.name)}
              >
                {d.name}
              </FilterChip>
            ))}
          </div>
        )}
      </div>

      {!query ? (
        <EmptyState
          title="What are you stuck on?"
          body="Type a technology, a domain, or a whole question — the search reads the org's skills and the documents behind them, not job titles."
        />
      ) : isLoading && !people ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true">
          {[0, 1, 2].map((i) => <SkeletonCard key={i} />)}
        </div>
      ) : people && people.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 items-stretch">
          {people.map((p) => (
            <ExpertCard
              key={p.id}
              name={p.name}
              title={p.title}
              subtitle={p.department}
              matchedSkills={p.matchedSkills}
              otherSkills={p.otherSkills}
              contexts={p.contexts}
              evidence={p.documents.map((d) => ({
                id: d.id,
                title: d.title,
                source: d.source,
                ...(d.sourceUri ? { href: d.sourceUri } : {}),
              }))}
              onAsk={() => ask(p)}
              askLabel="Draft an ask"
              onOpen={() => navigate(`/iq/explore?focus=${encodeURIComponent(p.id)}`)}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          title={`No evidence found for “${query}”`}
          body="Nobody's skills or documents match that phrasing. Try a broader term, or ask the org in chat — the supervisor searches the knowledge base too."
          actionLabel="Ask the org"
          onAction={() => navigate(`/iq/invoke?prompt=${encodeURIComponent(`Who in the org can help with ${query}?`)}`)}
        />
      )}
    </PageSection>
  );
}
