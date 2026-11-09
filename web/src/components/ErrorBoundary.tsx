import { Component, type ErrorInfo, type ReactNode } from 'react';
import { BrandMark } from './Brand.tsx';

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('[Botons] the page failed to render', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="boot crash" role="alert">
        <BrandMark size={48} />
        <h1>Something went wrong on this page</h1>
        <p className="muted">Your Botons are fine; this is only the web page. Reloading usually fixes it.</p>
        <pre className="code crash-detail">{error.message}</pre>
        <div>
          <button className="btn primary" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
