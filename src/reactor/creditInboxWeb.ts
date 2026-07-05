// 網頁根額度檔 · Web-root grants file for externally-awarded power-generation credits.
//
// An outside process can drop ONE JSON file next to the served app instead of touching any
// app internals. In this repo that is `public/power-credits.json` (git-ignored, machine-local);
// vite serves everything in `public/` at the site root, so the app polls it read-only at
//
//   GET /power-credits.json
//   format  {
//     "grants":       [ { "id": "<unique-string>", "credits": <positive number> } ],  // and/or
//     "totalCredits": <cumulative number>       // monotonic counter; deltas granted once
//   }
//
// Unknown extra fields are ignored. Delivery is exactly-once either way: grant ids go through
// the ledger's applied-id set, a cumulative total through the 'webroot' channel high-water mark
// (see powerCredits.ts). The file is never modified by the app — writers may keep appending
// grants or bumping the total in place. A 404 simply means no grants file is deployed.

import type { PowerCreditLedger } from './powerCredits';

const POLL_MS = 5000;
export const WEB_INBOX_URL = '/power-credits.json';
const CHANNEL = 'webroot';

/** Start polling the web-root grants file into `ledger`. Returns a stop function. */
export function startWebCreditInboxPoll(ledger: PowerCreditLedger): () => void {
  if (typeof window === 'undefined' || typeof fetch === 'undefined') return () => {};
  let stopped = false;
  let timer: number | undefined;

  const poll = async (): Promise<void> => {
    try {
      const res = await fetch(WEB_INBOX_URL, { cache: 'no-store' });
      if (res.ok) ledger.ingestInboxPayload((await res.json()) as unknown, CHANNEL);
    } catch {
      /* offline / malformed — try again next poll */
    } finally {
      if (!stopped) timer = window.setTimeout(() => void poll(), POLL_MS);
    }
  };

  void poll();
  return () => {
    stopped = true;
    if (timer !== undefined) window.clearTimeout(timer);
  };
}
