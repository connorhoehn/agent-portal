import { Link } from 'react-router';
import { PersonDetailCard, type PersonDetailCardProps } from '@connorhoehnslalom/ui-components';
import { Avatar, Button, Chip, EmptyState, Inline, InlineAlert, LoadingState, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import { useSession } from '../../lib/auth';
import portraits from '../../lib/demoPortraits.json';
import { demoPublicProfiles } from './demoPublicProfiles';

/** Everyday people lookup shows what the person shares about their work.
 * HR retains the separate inferred-specialty and relationship analysis. */
export function DirectoryPersonCard(props: Omit<PersonDetailCardProps, 'person'> & {
  person: (NonNullable<PersonDetailCardProps['person']> & { avatarUrl?: string | null }) | null | undefined;
}) {
  const { session } = useSession();
  if (session?.role === 'hr-admin') return <PersonDetailCard {...props} showInfluence />;
  const { person, loading, error, onAsk, askLabel, onClose, className, 'data-testid': testId } = props;
  const persona = person && portraits.personas.find(entry => entry.subjectId === person.id && entry.name === person.name);
  const profile = person ? demoPublicProfiles[person.id] : undefined;
  return <Stack gap="lg" className={className ?? 'p-4'} data-testid={testId ?? 'directory-person-card'}>
    {loading ? <LoadingState label="Loading profile…" /> : error ? <InlineAlert tone="error">{error}</InlineAlert> : !person ? <EmptyState title="Profile unavailable" /> : <>
      <Inline gap="md" align="start" justify="between">
        <Inline gap="sm" align="center">
          <Avatar name={person.name} src={person.avatarUrl ?? undefined} size={44} />
          <Stack gap="xs">
            <T size="base" weight="semibold">{person.name}</T>
            <T size="sm" tone="secondary" wrap>{[person.title, person.department].filter(Boolean).join(' · ')}</T>
          </Stack>
        </Inline>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </Inline>
      {persona && <T size="sm" tone="secondary" wrap>{persona.biography}</T>}
      <T size="xs" tone="tertiary">Self-disclosed profile</T>
      <Stack gap="sm">
        <T size="sm" weight="semibold">Skills</T>
        {profile?.skills.length ? <Inline gap="xs" wrap>{profile.skills.map(skill => <Chip size="xs" tone="neutral" key={skill}>{skill}</Chip>)}</Inline> : <T size="sm" tone="secondary">No skills shared yet.</T>}
      </Stack>
      <Stack gap="sm">
        <T size="sm" weight="semibold">Credentials</T>
        {profile?.credentials.length ? profile.credentials.map(credential => <Stack gap="xs" key={credential.title}>
          <T size="sm" weight="medium" wrap>{credential.title}</T>
          <T size="xs" tone="secondary">{credential.issuer} · {credential.year}</T>
        </Stack>) : <T size="sm" tone="secondary">No credentials shared yet.</T>}
      </Stack>
      {!!profile?.learning.length && <Stack gap="sm">
        <T size="sm" weight="semibold">Completed learning</T>
        {profile.learning.map(course => <Stack gap="xs" key={course.title}>
          <T size="sm" wrap>{course.title}</T><T size="xs" tone="secondary">{course.provider} · {course.year}</T>
        </Stack>)}
      </Stack>}
      {!!profile?.projects.length && <Stack gap="sm">
        <T size="sm" weight="semibold">Recent projects</T>
        {profile.projects.map(project => <Stack gap="xs" key={project.id}>
          <Link to={`/iq/projects/${encodeURIComponent(project.id)}`} className="text-sm font-medium text-primary hover:underline">{project.name}</Link>
          <T size="xs" tone="secondary">{project.role}</T><T size="sm" tone="secondary" wrap>{project.contribution}</T>
        </Stack>)}
      </Stack>}
      <Button size="sm" variant="secondary" onClick={() => onAsk(person.id)}>{askLabel?.(person) ?? `Discuss ${person.name.split(' ')[0]}'s work`}</Button>
    </>}
  </Stack>;
}
