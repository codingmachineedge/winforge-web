import { Component, useState, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '../state/toasts';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional context label surfaced in the toast + fallback (e.g. "Reactor"). */
  label?: string;
  /** Called when the user hits Retry, after the boundary resets. */
  onReset?(): void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * React class error boundary. Catches render/lifecycle errors in its subtree, shows an
 * in-pane fallback card, and fires a single `toast('error', …)` per crash. Wrap the
 * volatile panes (module detail, reactor view) so one module blowing up never blanks
 * the whole app.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // One toast per crash (getDerivedStateFromError already stored the error).
    const detail = this.props.label ? `${this.props.label}: ${error.message}` : error.message;
    toast.error(detail, { detail: info.componentStack?.trim() || undefined });
    // Surface to the console for dev tooling / Tauri logs as well.
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  private handleReset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render(): ReactNode {
    if (this.state.error) {
      return <ErrorFallback error={this.state.error} label={this.props.label} onRetry={this.handleReset} />;
    }
    return this.props.children;
  }
}

// Class components can't use hooks, so the fallback (which needs useTranslation and
// local UI state) lives in this function component rendered by the boundary.
function ErrorFallback({
  error,
  label,
  onRetry,
}: {
  error: Error;
  label?: string;
  onRetry(): void;
}): JSX.Element {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const stack = error.stack || String(error);

  const copyStack = (): void => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(stack).then(
        () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        },
        () => {
          /* clipboard denied — ignore, the stack is still visible in <details> */
        },
      );
    }
  };

  return (
    <div className="panel" role="alert" style={{ borderColor: 'var(--danger)', maxWidth: 760 }}>
      <h3 style={{ color: 'var(--danger)', marginTop: 0 }}>
        {t('shellfb.somethingWentWrong')}
        {label ? ` — ${label}` : ''}
      </h3>
      <p style={{ color: 'var(--text-secondary)', marginTop: 4, wordBreak: 'break-word' }}>
        {error.message || t('shellfb.unknownError')}
      </p>
      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: 'pointer', color: 'var(--text-tertiary)', fontSize: 12.5 }}>
          {t('shellfb.showDetails')}
        </summary>
        <pre
          style={{
            marginTop: 8,
            padding: '10px 12px',
            background: '#0e0e11',
            border: '1px solid var(--stroke)',
            borderRadius: 'var(--radius)',
            color: '#d6d6de',
            fontSize: 11.5,
            lineHeight: 1.45,
            overflow: 'auto',
            maxHeight: 260,
            whiteSpace: 'pre-wrap',
          }}
        >
          {stack}
        </pre>
      </details>
      <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        <button type="button" className="btn" onClick={onRetry}>
          {t('shellfb.retry')}
        </button>
        <button type="button" className="btn secondary" onClick={copyStack}>
          {copied ? t('shellfb.copied') : t('shellfb.copyDetails')}
        </button>
      </div>
    </div>
  );
}
