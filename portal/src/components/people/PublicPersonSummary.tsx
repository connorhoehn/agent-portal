import { Link } from 'react-router';
import { Chip, Inline, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import { demoPublicProfiles } from './demoPublicProfiles';

/** Compact version of the everyday directory card. The demo cast's existing
 * self-disclosures are fixture data, not inferred graph evidence or an API. */
export function PublicPersonSummary({ personId, projectLinks = true }: { personId: string; projectLinks?: boolean }) {
  const profile = demoPublicProfiles[personId];
  return <Stack gap="sm" data-testid="public-person-summary">
    <T size="xs" tone="tertiary">Self-disclosed profile</T>
    {!profile ? <T size="sm" tone="secondary" wrap>No skills or credentials shared yet.</T> : <>
      {!!profile.skills.length && <Inline gap="xs" wrap>
        {profile.skills.map(skill => <Chip key={skill} size="xs" tone="neutral">{skill}</Chip>)}
      </Inline>}
      {!!profile.credentials.length && <Stack gap="xs">
        <T size="xs" weight="semibold">Credentials</T>
        {profile.credentials.map(credential => <Stack key={credential.title} gap="none">
          <T size="sm" wrap>{credential.title}</T>
          <T size="xs" tone="secondary">{credential.issuer} · {credential.year}</T>
        </Stack>)}
      </Stack>}
      {!!profile.learning.length && <Stack gap="xs">
        <T size="xs" weight="semibold">Completed learning</T>
        {profile.learning.map(course => <Stack key={course.title} gap="none">
          <T size="sm" wrap>{course.title}</T>
          <T size="xs" tone="secondary">{course.provider} · {course.year}</T>
        </Stack>)}
      </Stack>}
      {!!profile.projects.length && <Stack gap="xs">
        <T size="xs" weight="semibold">Recent projects</T>
        {profile.projects.map(project => <Stack key={project.id} gap="none">
          {projectLinks
            ? <Link to={`/iq/projects/${encodeURIComponent(project.id)}`} className="text-sm font-medium text-primary hover:underline">{project.name}</Link>
            : <T size="sm" weight="medium" wrap>{project.name}</T>}
          <T size="xs" tone="secondary" wrap>{project.role}</T>
        </Stack>)}
      </Stack>}
    </>}
  </Stack>;
}
