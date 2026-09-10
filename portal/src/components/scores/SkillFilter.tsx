import { useEffect, useMemo, useReducer, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { Button, EmptyState, FilterChip, Inline, Input, Stack } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { filterSkillSuggestions } from './scoresFormat';
import { initialSkillComboboxState, skillComboboxReducer } from './skillComboboxState';

interface SkillSummary {
  id: string;
  name: string;
  mentionCount: number;
}

interface Props {
  selectedSkill: string;
  onChange: (skill: string) => void;
}

// A free-text combobox, not a search box plus a permanent row of the top 10
// skill chips — that chip row was one of six stacked blocks pushing the
// leaderboard below the fold (DEFECTS.md #3).
//
// This is deliberately NOT built on the library's `InlinePopover`/
// `PersonHoverCard`: both open on bare focus and unconditionally move focus
// into the panel + trap Tab there for as long as they're open (see
// `docs/ui-components-queue.md`'s "non-modal, non-trapping hover/pin
// disclosure" row) — exactly the shape DEFECTS.md org-leader #10 found here:
// Tab onto the search box opened a `role=dialog` reading `No skills match
// ""`, stole focus into its own Clear button, and from then on Tab and
// Escape did nothing and only the first typed character reached the input.
// The suggestion list below is a plain, non-focusable, absolutely
// positioned panel instead (same gap as the prompt-variable `Combobox` row
// already queued for `capabilities/prompts/VarCombobox.tsx`) — the input
// never loses focus, ArrowDown/ArrowUp only move `aria-activedescendant`,
// Enter picks the highlight, Escape closes without clearing the query, and
// Tab is never intercepted. `skillComboboxState.ts` holds the actual
// open/query/highlight transitions so they're unit-tested without mounting
// this component.
export function SkillFilter({ selectedSkill, onChange }: Props) {
  const { data: skills } = useFetch<SkillSummary[]>('/api/scores/skills');
  const [state, dispatch] = useReducer(skillComboboxReducer, initialSkillComboboxState);
  const { query, open, activeIndex } = state;
  const containerRef = useRef<HTMLDivElement>(null);

  const suggestions = useMemo(
    () => filterSkillSuggestions(skills ?? [], query, 8),
    [skills, query],
  );
  // Only render the panel once there is something real to show: either
  // suggestions, or an actual miss on a non-empty query. This is what keeps
  // an empty query from ever rendering `No skills match ""`, even if `open`
  // flips true (via ArrowDown) before /api/scores/skills has resolved.
  const showPanel = open && (suggestions.length > 0 || query.length > 0);

  function pick(name: string) {
    onChange(name);
    dispatch({ type: 'select' });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        dispatch({ type: 'arrow-down', count: suggestions.length });
        break;
      case 'ArrowUp':
        if (!open) return;
        e.preventDefault();
        dispatch({ type: 'arrow-up', count: suggestions.length });
        break;
      case 'Enter':
        if (open && activeIndex >= 0 && suggestions[activeIndex]) {
          e.preventDefault();
          pick(suggestions[activeIndex].name);
        }
        break;
      case 'Escape':
        if (open) {
          // Close only — never call blur/preventDefault beyond stopping the
          // event from bubbling to a page-level Escape handler; focus was
          // never moved off this input, so there is nothing to restore.
          e.stopPropagation();
          dispatch({ type: 'close' });
        }
        break;
      // No 'Tab' case: default browser behavior moves focus to the next
      // control, exactly the "Tab moves on" rule this combobox must satisfy.
    }
  }

  // Outside click closes the panel without touching focus (Escape above is
  // the keyboard equivalent).
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) dispatch({ type: 'close' });
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  return (
    <Inline align="center" gap="xs">
      <Stack ref={containerRef} gap="none" className="relative w-[180px]">
        <Input
          value={query}
          onChange={(e) => dispatch({ type: 'type', value: e.target.value })}
          onKeyDown={handleKeyDown}
          placeholder="Search skill…"
          aria-label="Search skills"
          size="sm"
          role="combobox"
          aria-expanded={showPanel}
          aria-controls="skill-filter-listbox"
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? `skill-option-${activeIndex}` : undefined}
          // `suffix` must never flip between `undefined` and an element: the
          // library's `Input` renders a bare `<input>` at the root when there
          // is no prefix/suffix, but switches to a wrapping `<div><input/>
          // <span>{suffix}</span></div>` the instant either is non-null
          // (`Input-*.js`: `!_ && !v ? <input> : <div>…</div>`). That is a
          // root *element type* change at this JSX position — clearing vs.
          // typing the first character used to toggle `suffix` from
          // `undefined` to a `<Button>`, so React tore down the whole
          // subtree and mounted a brand-new `<input>` DOM node on the very
          // keystroke that typed into it, dropping focus to `<body>` and
          // losing every keystroke after the first (DEFECTS.md org-leader
          // #10, second half). The suffix button is now always mounted —
          // only its visibility/hit-testing/focusability change with
          // `query` — so the wrapper shape, and the `<input>` node inside
          // it, never change.
          suffix={
            <Button
              variant="ghost"
              size="sm"
              disabled={!query}
              tabIndex={query ? undefined : -1}
              aria-hidden={query ? undefined : true}
              className={`!p-0 !border-0 !bg-transparent h-auto ${query ? '' : 'invisible pointer-events-none'}`}
              onClick={() => dispatch({ type: 'clear' })}
              aria-label="Clear skill search"
            >
              ✕
            </Button>
          }
        />
        {showPanel && (
          <Stack gap="none" className="absolute inset-x-0 top-full z-50 mt-1 rounded-lg border border-border bg-surface p-1.5 shadow-lg">
            {suggestions.length === 0 ? (
              <EmptyState
                title={`No skills match "${query}"`}
                actionLabel="Clear search"
                onAction={() => dispatch({ type: 'clear' })}
              />
            ) : (
              <Stack as="ul" gap="none" id="skill-filter-listbox" role="listbox" aria-label="Skill suggestions" className="m-0 list-none gap-0.5 p-0">
                {suggestions.map((s, i) => (
                  <Inline
                    as="li"
                    gap="none"
                    key={s.id}
                    id={`skill-option-${i}`}
                    role="option"
                    aria-selected={i === activeIndex}
                    // mousedown (not click/onClick), with preventDefault, so
                    // picking a suggestion never blurs the input first — the
                    // input must never lose focus while this is open.
                    onMouseDown={(e) => { e.preventDefault(); pick(s.name); }}
                    className={`cursor-pointer select-none rounded px-2 py-1 text-[12px] ${
                      i === activeIndex ? 'bg-primary-soft text-primary' : s.name === selectedSkill ? 'font-semibold text-text-primary' : 'text-text-primary'
                    }`}
                  >
                    {s.name}
                  </Inline>
                ))}
              </Stack>
            )}
          </Stack>
        )}
      </Stack>
      {selectedSkill && (
        <FilterChip active onClick={() => onChange('')}>
          Ranked by: {selectedSkill} ✕
        </FilterChip>
      )}
    </Inline>
  );
}
