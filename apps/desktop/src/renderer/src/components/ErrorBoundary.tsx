import { Component, type ErrorInfo, type ReactNode } from 'react';

// Safety net for the React tree (the gag-trophy crash report, 2026-11-25):
// an exception while rendering a component used to unmount the whole app
// and leave an empty window. A boundary catches it, logs it, and shows what
// went wrong in place of the part that failed, with a way to try again.
//
// `resetKey`: when it changes, a boundary that caught an error tries its
// children again (e.g. the viewport, once the next render brings new
// meshes).

interface Props {
  /** What failed, for the message ("The 3D view", "ScadStudio"). */
  label: string;
  children: ReactNode;
  resetKey?: unknown;
  /** Extra action next to "Try again" (the top-level boundary offers Reload). */
  onReload?: () => void;
}

interface State {
  error: Error | null;
  resetKey: unknown;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.resetKey) return { resetKey: props.resetKey, error: null };
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[scadstudio] ${this.props.label} crashed`, error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          height: '100%',
          boxSizing: 'border-box',
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          justifyContent: 'center',
          alignItems: 'flex-start',
          background: '#1e1e1e',
          color: '#ddd',
          font: '13px system-ui, sans-serif',
        }}
      >
        <strong style={{ fontSize: 15 }}>{this.props.label} hit an error and stopped.</strong>
        <span>The rest of ScadStudio is still running, and your file on disk is unchanged.</span>
        <code style={{ whiteSpace: 'pre-wrap', color: '#f48771', maxWidth: '100%', overflowWrap: 'anywhere' }}>{error.message}</code>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => this.setState({ error: null })}>Try again</button>
          {this.props.onReload && <button onClick={this.props.onReload}>Reload window</button>}
        </div>
      </div>
    );
  }
}
