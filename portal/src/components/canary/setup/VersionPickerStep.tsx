// VersionPickerStep — Step 2 of the canary setup wizard.
// Shows the version history of the selected prompt and lets the user pick
// which version is A (baseline) and which is B (challenger).

import { useState } from 'react';
import {
  Button, Divider, Inline, InlineAlert, InlinePlaceholder, MetaLine, SectionLabel, SkeletonCard, Stack, T,
} from '@connorhoehn/ui-components/shared';
import { usePromptVersions } from '../usePromptLibrary.js';
import type { PromptLibraryEntry } from '../types.js';

export interface VersionPickerStepProps {
  promptId: string;
  promptName: string;
  selectedVersionA: string | null;
  selectedVersionB: string | null;
  onSelectA: (version: string) => void;
  onSelectB: (version: string) => void;
  onEditFromA: () => void;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function versionLabel(v: string): string {
  return v === 'DRAFT' ? 'Draft' : `Version ${v}`;
}

interface VersionRowProps {
  entry: PromptLibraryEntry;
  selected: boolean;
  onSelect: () => void;
  radioName: string;
  side: 'A' | 'B';
}

function VersionRow({ entry, selected, onSelect, radioName, side }: VersionRowProps): React.ReactElement {
  const [hovered, setHovered] = useState(false);

  const sideColor = side === 'A' ? '#3b82f6' : '#a855f7';

  return (
    // `as="label"` keeps the whole row a click target for its radio, which the
    // native <label> gave for free. The radio itself keeps ONE style prop:
    // `accentColor` is the A/B side colour, a runtime value Tailwind cannot
    // build a class from. RadioGroup cannot express this row — its
    // RadioOption.label is a plain string, and this row carries a version
    // label, an "(editable)" tag, a description and a date.
    <Inline
      as="label"
      gap="xs"
      align="start"
      wrap={false}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={[
        'px-3 py-2 cursor-pointer border-l-[3px]',
        hovered || selected ? 'bg-bg' : 'bg-surface',
      ].join(' ')}
      style={{ borderLeftColor: selected ? sideColor : 'transparent' }}
    >
      <input
        type="radio"
        name={radioName}
        checked={selected}
        onChange={onSelect}
        style={{ accentColor: sideColor }}
      />
      <Stack gap="none" className="flex-1 min-w-0">
        <Inline gap="xs" wrap={false}>
          <T size="sm" weight="semibold" tone="primary">
            {versionLabel(entry.version)}
          </T>
          {entry.isDraft && (
            <T size="xs" tone="tertiary" className="italic">
              (editable)
            </T>
          )}
        </Inline>
        {entry.description && (
          <MetaLine size="xs" className="truncate" items={[entry.description]} />
        )}
        <MetaLine size="xs" items={[fmtDate(entry.updatedAt)]} />
      </Stack>
    </Inline>
  );
}

export function VersionPickerStep({
  promptId,
  promptName,
  selectedVersionA,
  selectedVersionB,
  onSelectA,
  onSelectB,
  onEditFromA,
}: VersionPickerStepProps): React.ReactElement {
  const { versions, loading, error } = usePromptVersions(promptId);

  if (loading) {
    return (
      <Stack gap="sm">
        {[0, 1, 2].map((i) => <SkeletonCard key={i} />)}
      </Stack>
    );
  }

  if (error) {
    return <InlineAlert tone="error">{error}</InlineAlert>;
  }

  return (
    <Stack gap="none">
      <MetaLine
        tone="secondary"
        className="mb-5 leading-normal"
        items={[<>Pick the baseline (A) and challenger (B) versions for <strong>{promptName}</strong>.</>]}
      />

      <Inline gap="none" align="start" wrap={false}>
        {/* Left column — Baseline A */}
        <Stack gap="none" className="flex-1 min-w-0 px-4">
          <SectionLabel as="div" className="mb-2 text-[#3b82f6]">
            Baseline (A)
          </SectionLabel>
          {versions.length === 0 ? (
            <InlinePlaceholder align="center" className="mt-6">No versions found</InlinePlaceholder>
          ) : (
            <Stack gap="none" className="border border-border rounded-md overflow-hidden">
              {versions.map((v) => (
                <VersionRow
                  key={v.version}
                  entry={v}
                  selected={selectedVersionA === v.version}
                  onSelect={() => onSelectA(v.version)}
                  radioName="version-a"
                  side="A"
                />
              ))}
            </Stack>
          )}
        </Stack>

        {/* Divider */}
        <Divider className="self-stretch w-px" />

        {/* Right column — Challenger B */}
        <Stack gap="none" className="flex-1 min-w-0 px-4">
          <SectionLabel as="div" className="mb-2 text-[#a855f7]">
            Challenger (B)
          </SectionLabel>
          {versions.length === 0 ? (
            <InlinePlaceholder align="center" className="mt-6">No versions found</InlinePlaceholder>
          ) : (
            <Stack gap="none" className="border border-border rounded-md overflow-hidden">
              {versions.map((v) => (
                <VersionRow
                  key={v.version}
                  entry={v}
                  selected={selectedVersionB === v.version}
                  onSelect={() => onSelectB(v.version)}
                  radioName="version-b"
                  side="B"
                />
              ))}
            </Stack>
          )}
          {/* Edit from A option */}
          <Stack gap="none" className="mt-3 pt-3 border-t border-border">
            <Button
              variant="secondary"
              size="sm"
              onClick={onEditFromA}
              disabled={!selectedVersionA}
              title={selectedVersionA ? 'Open editor to create a new version based on A' : 'Select a baseline (A) version first'}
            >
              Edit from A → publish new version
            </Button>
            <MetaLine
              size="xs"
              className="mt-1.5 leading-snug"
              items={["Opens an editor pre-filled with A's template. The new version is published and automatically used as B."]}
            />
          </Stack>
        </Stack>
      </Inline>
    </Stack>
  );
}

