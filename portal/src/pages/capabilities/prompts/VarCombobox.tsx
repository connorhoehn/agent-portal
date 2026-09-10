import { useEffect, useRef, useState } from 'react';
import { Inline, Input, Stack } from '@connorhoehnslalom/ui-components/shared';

const MAX_SUGGESTIONS = 8;

/**
 * Searchable autocomplete that still accepts free text.
 *
 * Deliberately not a `<Select>`: a prompt variable may legitimately be a name
 * that is not in the org graph, so the options are suggestions rather than a
 * closed set. Keyboard: ↓ opens, ↑/↓ move, Enter accepts the highlight, Esc
 * closes without changing the value.
 *
 * WANTED IN ui-components: a `Combobox` (open list of suggestions over a free
 * text field). `Select` is closed-set and `SearchInput` has no suggestion
 * list, so this is the one control here with no library equivalent.
 */
export function VarCombobox({
  value,
  onChange,
  options,
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder: string;
  autoFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = value
    ? options.filter(o => o.toLowerCase().includes(value.toLowerCase())).slice(0, MAX_SUGGESTIONS)
    : options.slice(0, MAX_SUGGESTIONS);

  function pick(v: string): void {
    onChange(v);
    setOpen(false);
    setHighlighted(0);
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        setOpen(true);
        setHighlighted(0);
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'ArrowDown') {
      setHighlighted(h => Math.min(h + 1, filtered.length - 1));
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      setHighlighted(h => Math.max(h - 1, 0));
      e.preventDefault();
    } else if (e.key === 'Enter' && filtered[highlighted] !== undefined) {
      pick(filtered[highlighted]);
      e.preventDefault();
    }
  }

  useEffect(() => {
    if (!open) return;
    function handleOutside(e: MouseEvent): void {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [open]);

  return (
    // Raw div, not `Stack`/`Inline`: this needs a real DOM ref for the
    // outside-click check below. That ref gap is CLOSED (2.233.0); what keeps
    // this file local is the missing `Combobox` — an open suggestion list over
    // a still-editable free-text field.
    // Stack takes a ref as of 2.233.0, so this wrapper is no longer raw.
    <Stack ref={containerRef} gap="none" className="relative">
      <Input
          autoFocus={autoFocus}
        value={value}
        onChange={e => { onChange(e.target.value); setOpen(true); setHighlighted(0); }}
        onFocus={() => { setOpen(true); setHighlighted(0); }}
        onKeyDown={handleKey}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        className="w-full"
      />
      {open && filtered.length > 0 && (
        <Stack
          as="ul"
          gap="none"
          role="listbox"
          className="absolute inset-x-0 top-full z-50 m-0 max-h-52 list-none overflow-y-auto rounded-b border border-t-0 border-border bg-surface p-0 shadow-lg"
        >
          {filtered.map((item, i) => (
            <Inline
              as="li"
              gap="none"
              key={item}
              role="option"
              aria-selected={i === highlighted}
              onMouseDown={() => pick(item)}
              onMouseEnter={() => setHighlighted(i)}
              className={`cursor-pointer select-none px-2.5 py-[7px] text-[12px] ${
                i === highlighted ? 'bg-[var(--color-primary-soft)] text-[var(--color-optimize)]' : 'text-text-primary'
              }`}
            >
              {item}
            </Inline>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
