import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useToasts, dismissToast, pauseToast, resumeToast, type Toast, type ToastKind } from '../state/toasts';
import '../styles/toasts.css';

// Glyphs from the Fluent/MDL2 icon font (see .glyph in global.css) per kind.
const ICON: Record<ToastKind, string> = {
  info: '', // Info
  success: '', // CheckMark
  warning: '', // Warning
  error: '', // ErrorBadge
};

// info/success are polite status updates; warning/error interrupt as alerts.
function roleFor(kind: ToastKind): 'status' | 'alert' {
  return kind === 'warning' || kind === 'error' ? 'alert' : 'status';
}

function ToastRow({ t: item, dismissLabel }: { t: Toast; dismissLabel: string }): JSX.Element {
  return (
    <div
      className={`toast toast-${item.kind}`}
      role={roleFor(item.kind)}
      aria-live={roleFor(item.kind) === 'alert' ? 'assertive' : 'polite'}
      onMouseEnter={() => pauseToast(item.id)}
      onMouseLeave={() => resumeToast(item.id)}
    >
      <span className="toast-icon glyph" aria-hidden="true">
        {ICON[item.kind]}
      </span>
      <div className="toast-body">
        <div className="toast-message">{item.message}</div>
        {item.detail ? <div className="toast-detail">{item.detail}</div> : null}
      </div>
      <button
        type="button"
        className="toast-close glyph"
        aria-label={dismissLabel}
        title={dismissLabel}
        onClick={() => dismissToast(item.id)}
      >
        {''}
      </button>
    </div>
  );
}

/**
 * Portal-rendered fixed stack of toasts (bottom-right). Mount once near the app root
 * (e.g. inside <App> after <main>). Reads the singleton store via useToasts().
 */
export function ToastHost(): JSX.Element | null {
  const toasts = useToasts();
  const { t } = useTranslation();
  const [mounted, setMounted] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);

  // Only render the portal in the browser (guards SSR / test / non-DOM envs).
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || typeof document === 'undefined') return null;

  const dismissLabel = t('shellfb.dismiss');

  return createPortal(
    <div className="toast-host" ref={hostRef} aria-live="polite" aria-relevant="additions">
      {toasts.map((item) => (
        <ToastRow key={item.id} t={item} dismissLabel={dismissLabel} />
      ))}
    </div>,
    document.body,
  );
}
