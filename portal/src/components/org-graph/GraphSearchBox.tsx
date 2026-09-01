// Find a person (name/title/department) or a skill and jump the graph to them.
// Without it, finding someone means eyeballing 56 nodes.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Input, Stack } from '@connorhoehnslalom/ui-components/shared';
import { OverlineLabel, SuggestionRow } from './graphOverlay';
import { searchGraph } from './graphInsights';
import type { GraphPerson } from './types';

export interface GraphSearchBoxProps {
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

  const { personMatches, skillMatches } = useMemo(() => searchGraph(people, q), [q, people]);
  const totalRows = personMatches.length + skillMatches.length;

  function pick(index: number) {
    if (index < personMatches.length) {
      const p = personMatches[index];
      if (!p) return;
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

  // SearchInput would be the obvious component here, but it forwards neither
  // onKeyDown nor the combobox ARIA attributes, so the arrow-key navigation
  // this box is FOR could not survive the swap. Input passes both through.
  return (
    <div ref={rootRef} className="relative">
      <Input
        type="search"
        role="combobox"
        aria-expanded={open && totalRows > 0}
        aria-label="Find a person or skill"
        placeholder="Find a person or skill…"
        value={q}
        className="w-[210px] rounded-full"
        onChange={(e) => { setQ(e.target.value); setOpen(true); setHighlight(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, totalRows - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
          else if (e.key === 'Enter' && totalRows > 0) { e.preventDefault(); pick(highlight); }
          else if (e.key === 'Escape') { setOpen(false); setQ(''); }
        }}
      />

      {open && totalRows > 0 && (
        <Stack
          gap="none"
          role="listbox"
          className="absolute left-0 top-[calc(100%+6px)] z-[120] max-h-[340px] w-[290px] overflow-y-auto rounded-lg border border-border bg-surface py-1 shadow-md"
        >
          {personMatches.map((p, i) => (
            <SuggestionRow
              key={p.id}
              active={highlight === i}
              onHighlight={() => setHighlight(i)}
              onPick={() => pick(i)}
              primary={p.name}
              secondary={`${p.title} · ${p.department}`}
            />
          ))}

          {skillMatches.length > 0 && (
            <div className="px-3 pb-1 pt-1.5">
              <OverlineLabel>Skills</OverlineLabel>
            </div>
          )}
          {skillMatches.map((s, j) => {
            const i = personMatches.length + j;
            return (
              <SuggestionRow
                key={s.skill}
                active={highlight === i}
                onHighlight={() => setHighlight(i)}
                onPick={() => pick(i)}
                primary={s.skill}
                secondary={`${s.personIds.length} people`}
              />
            );
          })}
        </Stack>
      )}
    </div>
  );
}
