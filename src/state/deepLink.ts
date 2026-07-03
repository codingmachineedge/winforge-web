// winforge:// deep link handling (feature #34).
//
// The Rust side (src-tauri/src/lib.rs) listens for opened winforge:// URLs and
// re-emits them to the webview as a plain "deep-link" event carrying the URL
// string. We listen here via @tauri-apps/api/event (already a dependency — no new
// npm package). Outside Tauri this is a no-op.
import { listen } from '@tauri-apps/api/event';

/** Event name emitted by the Rust backend. Must match `handle.emit("deep-link", ...)`. */
const DEEP_LINK_EVENT = 'deep-link';

/** True when running inside the Tauri desktop shell (same guard as bridge.ts). */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Parse a winforge:// deep link into a module tag, or return null if it is not a
 * valid winforge module link.
 *
 * Accepted forms (all case-insensitive on the scheme):
 *   winforge://module/<tag>
 *   winforge://module/module.xxx     (dotted tag form)
 *   winforge://<tag>                 (bare tag, no "module" host)
 *
 * The extracted tag must match [a-z0-9_.-]+ (lowercase). A trailing slash and
 * query/hash are tolerated and stripped. Anything else yields null.
 */
export function parseDeepLink(url: string): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();

  // Match scheme case-insensitively; require the winforge:// prefix.
  const m = /^winforge:\/\/(.*)$/i.exec(trimmed);
  if (!m || m[1] === undefined) return null;

  // Strip any query string or fragment, then trailing slashes.
  let rest = m[1];
  const cut = rest.search(/[?#]/);
  if (cut !== -1) rest = rest.slice(0, cut);
  rest = rest.replace(/\/+$/, '');
  if (rest === '') return null;

  const segments = rest.split('/').filter((s) => s.length > 0);
  const first = segments[0];
  if (first === undefined) return null;

  let tag: string;
  if (first.toLowerCase() === 'module') {
    // winforge://module/<tag> — the tag is the next segment.
    const second = segments[1];
    if (second === undefined) return null;
    tag = second;
  } else {
    // Bare form winforge://<tag>. Reject anything with further path segments to
    // avoid ambiguity (e.g. winforge://foo/bar).
    if (segments.length > 1) return null;
    tag = first;
  }

  const lower = tag.toLowerCase();
  return /^[a-z0-9_.-]+$/.test(lower) ? lower : null;
}

/**
 * Start listening for winforge:// deep links. Calls `onModule(tag)` for each valid
 * `winforge://module/<tag>` (or accepted variant) received. No-op outside Tauri.
 *
 * Returns a promise that resolves once the listener is registered (or immediately
 * when not in Tauri).
 */
export async function initDeepLinks(onModule: (tag: string) => void): Promise<void> {
  if (!isTauri()) return;
  await listen<string>(DEEP_LINK_EVENT, (event) => {
    const tag = parseDeepLink(event.payload);
    if (tag) onModule(tag);
  });
}
