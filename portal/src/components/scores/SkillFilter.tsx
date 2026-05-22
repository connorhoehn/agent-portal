import { useState, useEffect } from 'react';
import { FilterChip } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';

interface SkillSummary {
  id: string;
  name: string;
  mentionCount: number;
}

interface Props {
  selectedSkill: string;
  onChange: (skill: string) => void;
}

export function SkillFilter({ selectedSkill, onChange }: Props) {
  const { data: skills } = useFetch<SkillSummary[]>('/api/scores/skills');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const topSkills = (skills ?? []).slice(0, 10);

  // Autocomplete suggestions when user is typing
  const suggestions = query.length > 0
    ? (skills ?? []).filter(s => s.name.toLowerCase().includes(query.toLowerCase())).slice(0, 8)
    : [];

  // Reset active index when suggestions change
  useEffect(() => { setActiveIndex(-1); }, [suggestions.length]);

  // Open listbox when there are suggestions
  useEffect(() => {
    setOpen(suggestions.length > 0);
  }, [suggestions.length]);

  function handleSelect(name: string) {
    onChange(name);
    setQuery('');
    setOpen(false);
    setActiveIndex(-1);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || suggestions.length === 0) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex(i => Math.min(i + 1, suggestions.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex(i => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (activeIndex >= 0) {
          handleSelect(suggestions[activeIndex].name);
        }
        break;
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        setActiveIndex(-1);
        break;
    }
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        fontSize: 11,
        textTransform: 'uppercase',
        color: 'var(--color-text-tertiary)',
        letterSpacing: '0.05em',
        marginBottom: 6,
      }}>
        Ranked by skill:
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <FilterChip
          active={selectedSkill === ''}
          onClick={() => handleSelect('')}
        >
          All skills
        </FilterChip>

        {topSkills.map(skill => (
          <FilterChip
            key={skill.id}
            active={selectedSkill === skill.name}
            onClick={() => handleSelect(skill.name)}
          >
            {skill.name}
          </FilterChip>
        ))}

        {/* Free-text autocomplete */}
        <div style={{ position: 'relative' }}>
          <input
            type="text"
            role="combobox"
            aria-expanded={open && suggestions.length > 0}
            aria-controls="skill-filter-listbox"
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? `skill-option-${activeIndex}` : undefined}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search skill…"
            aria-label="Search skills"
            style={{
              padding: '4px 8px',
              fontSize: 11,
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--color-surface)',
              color: 'var(--color-text-primary)',
              outline: 'none',
              width: 110,
            }}
          />
          {open && suggestions.length > 0 && (
            <ul
              id="skill-filter-listbox"
              role="listbox"
              aria-label="Skill suggestions"
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                zIndex: 100,
                marginTop: 2,
                background: 'var(--color-surface)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                minWidth: 160,
                listStyle: 'none',
                margin: '2px 0 0',
                padding: 0,
              }}
            >
              {suggestions.map((s, i) => (
                <li
                  key={s.id}
                  id={`skill-option-${i}`}
                  role="option"
                  aria-selected={i === activeIndex}
                  onClick={() => handleSelect(s.name)}
                  onMouseEnter={() => setActiveIndex(i)}
                  style={{
                    padding: '6px 10px',
                    fontSize: 12,
                    cursor: 'pointer',
                    color: 'var(--color-text-primary)',
                    background: i === activeIndex ? 'var(--color-surface-hover)' : 'transparent',
                  }}
                >
                  {s.name}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
