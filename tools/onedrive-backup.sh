#!/usr/bin/env bash
# OneDrive backup for winforge-web — invoked by the post-commit hook.
# Backs up ONLY git-tracked files (via `git archive`, so .gitignore is respected:
# node_modules, src-tauri/target, dist/ never get copied). Never fails the commit.
#
# Layout under  <OneDrive>\Backups\winforge-web\ :
#   <YYYY-MM-DD>\winforge-web-<YYYY-MM-DD>.zip   (one zip per day, overwritten in-day)
#   commit-history.pdf                            (full log, regenerated every commit)
set +e

log() { echo "[onedrive-backup] $*"; }

# Resolve repo root (the hook runs with CWD = repo root, but be explicit).
REPO_DIR="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -z "$REPO_DIR" ] && REPO_DIR="$(pwd)"

# 1. Detect OneDrive path: %OneDrive% -> %OneDriveConsumer% -> default.
ONEDRIVE_RAW="${OneDrive:-${OneDriveConsumer:-C:\\Users\\cntow\\OneDrive}}"
# Normalise backslashes to forward slashes; C:/... works in git-bash and Windows tools.
ONEDRIVE="$(printf '%s' "$ONEDRIVE_RAW" | tr '\\' '/')"

if [ ! -d "$ONEDRIVE" ]; then
  log "OneDrive not found at '$ONEDRIVE' — skipping backup (exit 0)."
  exit 0
fi

BASE="$ONEDRIVE/Backups/winforge-web"
DATE="$(date +%Y-%m-%d)"
DAY_DIR="$BASE/$DATE"
mkdir -p "$DAY_DIR" 2>/dev/null

# 2. Tracked-files snapshot for today (overwrite within the same day).
ZIP="$DAY_DIR/winforge-web-$DATE.zip"
if git -C "$REPO_DIR" archive --format=zip -o "$ZIP" HEAD 2>/dev/null; then
  SIZE="$(du -h "$ZIP" 2>/dev/null | cut -f1)"
  log "snapshot -> $ZIP ($SIZE)"
else
  log "git archive failed — skipping zip."
fi

# 3. Regenerate the top-level commit-history.pdf from the full git log.
PDF="$BASE/commit-history.pdf"
PYGEN="$REPO_DIR/tools/commit_history_pdf.py"
if command -v python >/dev/null 2>&1 && [ -f "$PYGEN" ]; then
  if python "$PYGEN" "$PDF" "$REPO_DIR" >/dev/null 2>&1; then
    log "history -> $PDF"
  else
    # Fallback: plain-text history if PDF generation fails (e.g. reportlab missing).
    TXT="$BASE/commit-history.txt"
    git -C "$REPO_DIR" log --pretty=format:'%h | %ad | %an | %s' --date=short > "$TXT" 2>/dev/null
    log "PDF generation failed; wrote text fallback -> $TXT"
  fi
else
  TXT="$BASE/commit-history.txt"
  git -C "$REPO_DIR" log --pretty=format:'%h | %ad | %an | %s' --date=short > "$TXT" 2>/dev/null
  log "python/generator unavailable; wrote text fallback -> $TXT"
fi

exit 0
