import { Select } from '@connorhoehnslalom/ui-components/shared';
import { usePromptVersions } from '../../../components/canary/usePromptLibrary.js';

/** DRAFT plus every published version of one prompt. */
export function VersionSelect({
  promptId,
  value,
  onChange,
}: {
  promptId: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const { versions } = usePromptVersions(promptId);
  const options = [
    { value: 'DRAFT', label: 'DRAFT' },
    ...versions
      .filter(v => v.version !== 'DRAFT' && !v.isDraft)
      .map(v => ({ value: v.version, label: `v${v.version}` })),
  ];

  return (
    <Select
      options={options}
      value={value}
      onChange={e => onChange(e.target.value)}
      size="sm"
      aria-label="Prompt version"
      className="min-w-[90px] font-semibold"
    />
  );
}
