import { useState } from 'react';
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

const PRIMARY_COLOR = 'var(--color-primary, #6366f1)';
const PRIMARY_SOFT  = 'var(--color-primary-soft, #eef2ff)';

function chipStyle(active: boolean): React.CSSProperties {
  return {
    padding: '4px 10px',
    fontSize: 11,
    fontWeight: active ? 600 : 400,
    border: `1px solid ${active ? PRIMARY_COLOR : 'var(--color-border)'}`,
    background: active ? PRIMARY_SOFT : 'var(--color-surface)',
    color: active ? PRIMARY_COLOR : 'var(--color-text-secondary)',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
  };
}

export function SkillFilter({ selectedSkill, onChange }: Props) {
  const { data: skills } = useFetch<SkillSummary[]>('/api/scores/skills');
  const [query, setQuery] = useState('');

  const topSkills = (skills ?? []).slice(0, 10);

  // Autocomplete suggestions when user is typing
  const suggestions = query.length > 0
    ? (skills ?? []).filter(s => s.name.toLowerCase().includes(query.toLowerCase())).slice(0, 8)
    : [];

  function handleSelect(name: string) {
    onChange(name);
    setQuery('');
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
        <button
          onClick={() => handleSelect('')}
          style={chipStyle(selectedSkill === '')}
        >
          All skills
        </button>

        {topSkills.map(skill => (
          <button
            key={skill.id}
            onClick={() => handleSelect(skill.name)}
            style={chipStyle(selectedSkill === skill.name)}
          >
            {skill.name}
          </button>
        ))}

        {/* Free-text autocomplete */}
        <div style={{ position: 'relative' }}>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search skill…"
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
          {suggestions.length > 0 && (
            <div style={{
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
            }}>
              {suggestions.map(s => (
                <div
                  key={s.id}
                  onClick={() => handleSelect(s.name)}
                  style={{
                    padding: '6px 10px',
                    fontSize: 12,
                    cursor: 'pointer',
                    color: 'var(--color-text-primary)',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'var(--color-surface-hover)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
                >
                  {s.name}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
