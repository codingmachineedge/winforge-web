// 桌面額度收件匣 · Desktop (Tauri) inbox for externally-awarded power-generation credits.
//
// An outside process on the machine awards credits by writing ONE JSON file — it needs to know
// nothing about this app beyond the path and shape:
//
//   path    %LOCALAPPDATA%\WinForge\power-credits\inbox.json
//   format  { "grants": [ { "id": "<unique-string>", "credits": <positive number> } ] }
//
// Delivery contract:
//   • Writers create or overwrite the file (create the folder if needed). Appending new entries
//     to an existing file also works — ids make every grant apply at most once.
//   • The app polls every POLL_MS, atomically CLAIMS the file (Rename-Item to a unique temp name,
//     so a concurrent writer never has its fresh file half-consumed), ingests it into the
//     persisted ledger (powerCredits.ts), then deletes the claimed copy.
//   • Double delivery is harmless (id ledger); a malformed file is claimed and discarded.
//
// Browser builds never call this (no filesystem) — same-origin scripts use the localStorage
// inbox key or window.winforgeGrantPowerCredits() instead; see powerCredits.ts.

import { isTauri, runPowershell } from '../tauri/bridge';
import type { PowerCreditLedger } from './powerCredits';

const POLL_MS = 5000;

// Claim-then-read in one PowerShell round-trip. Rename-Item within a directory is atomic on NTFS,
// so a writer replacing the file mid-poll either wins entirely (picked up next poll) or loses the
// race entirely (we consume the previous file). Prints nothing when there is no inbox.
const CLAIM_SCRIPT = [
  "$inbox = Join-Path $env:LOCALAPPDATA 'WinForge\\power-credits\\inbox.json'",
  'if (Test-Path -LiteralPath $inbox) {',
  "  $claim = Join-Path $env:LOCALAPPDATA ('WinForge\\power-credits\\inbox.' + [guid]::NewGuid().ToString('N') + '.claimed')",
  '  Rename-Item -LiteralPath $inbox -NewName (Split-Path -Leaf $claim) -ErrorAction Stop',
  '  Get-Content -LiteralPath $claim -Raw',
  '  Remove-Item -LiteralPath $claim -Force -ErrorAction SilentlyContinue',
  '}',
].join('\n');

/**
 * Start polling the desktop inbox file into `ledger`. No-op outside the Tauri shell.
 * Returns a stop function.
 */
export function startDesktopCreditInboxPoll(ledger: PowerCreditLedger): () => void {
  if (!isTauri()) return () => {};
  let stopped = false;
  let timer: number | undefined;

  const poll = async (): Promise<void> => {
    try {
      const res = await runPowershell(CLAIM_SCRIPT);
      const text = res.stdout.trim();
      if (text) ledger.ingestInboxPayload(JSON.parse(text) as unknown);
    } catch {
      /* transient backend/parse failure — try again next poll */
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
