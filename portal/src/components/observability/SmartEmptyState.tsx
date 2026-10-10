// Researcher-friendly empty state. Renders a centered card with a title,
// optional detail, and 0-3 actions the user can take to make data appear.
// Each action can be a copy-paste shell command (`code`) and/or an in-app
// link (`href`).
//
// Visually consistent across observability pages: same max width, same
// padding, same spacing. Use this in place of generic "no data yet" copy.
//
// …UNLESS THE EMPTY IS A LIE. Every advice this component gives — "run the
// harness", "seed the calibration cases" — is advice about a system that is
// working and simply has nothing in it yet. When the server has told us it
// could NOT read (`degraded: true` on the wire, unwrapped by useFetch), that
// advice is wrong twice over: it blames the reader for an absence they did not
// cause, and it hides a broken query behind a chore. So this component is also
// the gate for the opposite treatment. Pass `degraded` and it renders
// `UnavailableNotice` instead — solid danger border, the server's own error
// line, a retry — leaving the dashed neutral card to mean exactly one thing:
// we looked, and there is genuinely nothing here.

import type { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router';
import {
  Card, CodeBlock, Inline, Link, MetaLine, Stack, T,
} from '@connorhoehnslalom/ui-components/shared';

import { UnavailableNotice } from '../UnavailableNotice';

export interface SmartEmptyAction {
  label: string;
  detail?: string;
  code?: string;
  href?: string;
}

export interface SmartEmptyStateProps {
  title: string;
  detail?: string;
  actions?: SmartEmptyAction[];
  // Optional override slot — researchers sometimes need extra context (e.g. a
  // chart that already explains the empty state).
  children?: ReactNode;
  /**
   * The server's own error line when this region's read was `degraded` — i.e.
   * the emptiness below is not a reading of the world. `null`/absent is the
   * healthy path and renders the ordinary empty state.
   */
  degraded?: string | null;
  /**
   * What could not be read, as a noun phrase — "the cost chart", "the tool
   * error list". Defaults to the region's own title lower-cased, which is
   * usually a "No …" sentence and reads badly, so pass it.
   */
  degradedWhat?: string;
  /** Where the data comes from, so the reader knows where to go look. */
  degradedSource?: string;
  onRetry?: () => void;
}

export function SmartEmptyState({
  title,
  detail,
  actions = [],
  children,
  degraded,
  degradedWhat,
  degradedSource,
  onRetry,
}: SmartEmptyStateProps) {
  if (degraded) {
    return (
      <UnavailableNotice
        error={degraded}
        what={degradedWhat ?? title.replace(/^No /i, 'the ')}
        source={degradedSource}
        onRetry={onRetry}
      />
    );
  }
  return (
    <Inline gap="none" justify="center" className="px-4 py-6">
      {/* Dashed border is load-bearing: it is what distinguishes "we looked and
          there is nothing" from UnavailableNotice's solid danger border. */}
      <Card className="max-w-[560px] w-full px-5.5 py-5 border-dashed">
        <Stack gap="none" className="gap-2.5">
          <T as="div" size="sm" weight="semibold">{title}</T>
          {detail && <MetaLine tone="secondary" className="leading-normal" items={[detail]} />}
          {actions.length > 0 && (
            <Stack gap="none" className="gap-2.5 mt-1">
              {actions.map((a, i) => (
                <ActionRow key={i} action={a} />
              ))}
            </Stack>
          )}
          {children && <Stack gap="none" className="mt-1">{children}</Stack>}
        </Stack>
      </Card>
    </Inline>
  );
}

function ActionRow({ action }: { action: SmartEmptyAction }) {
  const labelNode = action.href ? (
    action.href.startsWith('/') ? (
      <RouterLink to={action.href} className="text-primary no-underline hover:underline">
        {action.label}
      </RouterLink>
    ) : (
      // The library Link forces rel="noopener noreferrer"; the raw anchor this
      // replaces set only rel="noreferrer".
      <Link href={action.href} external>
        {action.label}
      </Link>
    )
  ) : (
    <T weight="semibold">{action.label}</T>
  );

  return (
    <Stack gap="none" className="gap-1">
      <Inline gap="xs" align="baseline" wrap={false}>
        <T tone="tertiary" className="font-mono">›</T>
        {labelNode}
      </Inline>
      {action.detail && (
        <MetaLine size="xs" className="pl-3.5" items={[action.detail]} />
      )}
      {action.code && (
        // CodeBlock owns the copy affordance, so the clipboard write, the
        // "✓ copied" flag and the timeout that reset it are all gone — along
        // with the cleanup effect that existed only to clear that timer.
        <CodeBlock
          className="ml-3.5"
          language="bash"
          code={action.code}
          copyButton
          ariaLabel={`Command for ${action.label}`}
        />
      )}
    </Stack>
  );
}


export default SmartEmptyState;
