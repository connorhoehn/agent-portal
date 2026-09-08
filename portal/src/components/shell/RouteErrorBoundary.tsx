// One page's throw must cost one page, not the app. Twice in one day a
// single component error — a /api/health body without `mocks`, then a
// rules-of-hooks regression in one graph frame — took every route to a
// blank white screen with nothing to click. Every routed page renders
// inside this boundary: the shell, the rail and the breadcrumbs stay, the
// failing page shows the library's ErrorState with the message and a way
// to try again, and a route change resets it.

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorState } from '@connorhoehnslalom/ui-components/shared';

interface Props {
  /** Changes on navigation so a new route gets a clean boundary. */
  resetKey: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
  keyAtError: string | null;
}

export class RouteErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, keyAtError: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface it where a developer looks; the page already shows the user.
    console.error('[route] page render failed', error, info.componentStack);
    this.setState({ keyAtError: this.props.resetKey });
  }

  override componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null, keyAtError: null });
    }
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <ErrorState
          title="This page hit an error"
          body={this.state.error.message || 'Something in this page failed to render. The rest of the app is unaffected.'}
          actionLabel="Try again"
          onAction={() => this.setState({ error: null, keyAtError: null })}
        />
      );
    }
    return this.props.children;
  }
}
