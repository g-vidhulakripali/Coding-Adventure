import { Component, type ReactNode } from 'react';

/** Shows what went wrong instead of an empty page. Saved projects are not touched. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="workspace__status" role="alert">
        <h2>Something went wrong in the app</h2>
        <p>{error.message}</p>
        <p>Your saved projects are still there.</p>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => {
            window.location.hash = '#/';
            this.setState({ error: null });
          }}
        >
          Back to start
        </button>
      </div>
    );
  }
}
