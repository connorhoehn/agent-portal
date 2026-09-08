// Drafted stories — the last thing the baseline produces, made visible.
//
// Nothing here pushes to Jira: the push command is shown to copy and run by
// hand, exactly as the improvement plan shows its drafting command. `status`
// describes the FILE, not the team — "blocked" means a question is still
// open in it, never a judgement on anyone.

import {
  CodeBlock, Card, Chip, EmptyState, Inline, LoadingState, MetaLine, SectionLabel, Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../../hooks/useFetch';
import { dimensionLabel, needsInputSentence, pushCommandFor, statusMeta, type Story, type StoriesResponse } from '../assessmentFormat';
import { fmtDate } from '../types';

function StatusChip({ status }: { status: Story['status'] }) {
  const meta = statusMeta(status);
  return <Chip tone={meta.chipTone} uppercase size="xs" title={meta.meaning}>{meta.label}</Chip>;
}

function NextStep({ story, teamId }: { story: Story; teamId: string }) {
  if (story.status === 'pushed') {
    return (
      <Stack gap="none" className="text-sm text-text-secondary">
        Pushed as <strong className="font-semibold text-text-primary">{story.jira_key}</strong>. Any further change to
        the ticket happens in Jira rather than here.
      </Stack>
    );
  }
  if (story.status === 'blocked') {
    return (
      <Stack gap="xs">
        <Stack gap="none" className="text-sm text-text-secondary">{needsInputSentence(story)}</Stack>
        <Stack gap="none" className="text-sm text-text-secondary">
          Fill those in inside the story file, then it can be pushed. The push refuses while anything is still
          marked as needing input.
        </Stack>
      </Stack>
    );
  }
  return (
    <Stack gap="xs">
      <Stack gap="none" className="text-sm text-text-secondary">
        Copy this command and run it from the repo root. Nothing is pushed from this page.
      </Stack>
      <CodeBlock code={pushCommandFor(teamId, story.filename)} language="bash" />
    </Stack>
  );
}

function StoryCard({ story, teamId }: { story: Story; teamId: string }) {
  const dimension = dimensionLabel(story);
  return (
    <Card padding="md" className={`border-l-4 ${
      story.status === 'pushed' ? 'border-l-success' : story.status === 'blocked' ? 'border-l-warning' : 'border-l-info'
    }`}>
      <Inline justify="between" align="start" wrap gap="sm">
        <Stack gap="none" className="min-w-0">
          <SectionLabel>{dimension ?? 'Not tied to a dimension'}</SectionLabel>
          <strong className="mt-0.5 block text-base font-bold leading-tight text-text-primary">{story.title}</strong>
        </Stack>
        <Inline gap="sm" align="center" className="shrink-0">
          {story.jira_key && <Chip size="xs" mono>{story.jira_key}</Chip>}
          <StatusChip status={story.status} />
        </Inline>
      </Inline>
      <Inline gap="sm" wrap align="center" className="mt-2 text-xs text-text-secondary">
        <span>Drafted {fmtDate(story.created_at)}</span>
        <MetaLine size="xs" items={[story.path ?? story.filename]} />
      </Inline>
      <Stack gap="none" className="mt-3"><NextStep teamId={teamId} story={story} /></Stack>
    </Card>
  );
}

export function StoriesPanel({ teamId }: { teamId: string }) {
  const { data, isLoading, error } = useFetch<StoriesResponse>(
    `/api/assessment/teams/${encodeURIComponent(teamId)}/stories`,
  );

  if (isLoading) return <LoadingState label="Loading drafted stories…" />;
  if (error || !data) {
    return (
      <EmptyState
        title="No drafted stories on this environment yet"
        body="The assessment API here does not list stories yet. The scorecard and improvement plan are unaffected — this panel will fill in once the stories endpoint is available."
      />
    );
  }

  const stories = data.stories ?? [];

  return (
    <Stack gap="lg">
      <Stack gap="xs">
        <SectionLabel>Drafted stories</SectionLabel>
        <Stack gap="none" className="max-w-4xl text-lg font-semibold leading-snug text-text-primary">
          {stories.length === 0
            ? 'Nothing has been drafted for this team yet.'
            : `${stories.length} ${stories.length === 1 ? 'story has' : 'stories have'} been drafted from this team's improvement plan.`}
        </Stack>
        <Stack gap="none" className="max-w-4xl text-xs leading-relaxed text-text-tertiary">
          Each story was written from one plan entry and is reviewed before it goes anywhere. Pushing one to Jira is
          a command a person runs from the repo root — nothing on this page creates a ticket.
        </Stack>
      </Stack>

      {stories.length === 0 ? (
        <EmptyState
          title="No story has been drafted for this team yet"
          body="A story is always written from one entry in this team's improvement plan — open the Improvement Plan tab and use its Draft story action."
        />
      ) : (
        <Stack gap="sm">
          {/* `filename` is the identity the wire guarantees; `path` is not
              always present (the card falls back to filename for it too), and
              an undefined key was the "missing key" error on every scorecard. */}
          {stories.map((story) => <StoryCard teamId={teamId} key={story.filename} story={story} />)}
        </Stack>
      )}
    </Stack>
  );
}
