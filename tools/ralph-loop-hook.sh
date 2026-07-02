#!/usr/bin/env bash
# Stop hook that self-continues the winforge-web parity Ralph loop.
#
# ARM (start looping):   touch  <repo>/.ralph-loop-active   (and reset the counter)
# DISARM (stop looping): rm     <repo>/.ralph-loop-active
#
# Safety:
#   * Inert unless the marker file exists (disarmed by default) — other sessions unaffected.
#   * Iteration cap per arming (MAX_ITER) — auto-disarms when hit.
#   * Auto-disarms when no stubs remain (parity complete).
# Reads the Stop-hook JSON on stdin; emits {"decision":"block","reason":...} to continue.
set +e

REPO="C:/Users/cntow/Documents/GitHub/winforge-web"
MARKER="$REPO/.ralph-loop-active"
COUNTER="$REPO/.ralph-loop-count"
MAX_ITER=25

# Disarmed → allow the normal stop.
[ -f "$MARKER" ] || exit 0

# Iteration cap (per arming).
n=$(cat "$COUNTER" 2>/dev/null | tr -dc '0-9'); [ -z "$n" ] && n=0
n=$((n + 1))
if [ "$n" -gt "$MAX_ITER" ]; then
  rm -f "$MARKER" "$COUNTER"
  echo "{\"systemMessage\":\"Ralph loop reached its ${MAX_ITER}-iteration cap and disarmed. Re-arm with: touch ${MARKER}\"}"
  exit 0
fi

# Refresh the worklist and count remaining stubs.
node "$REPO/tools/gen-parity.mjs" >/dev/null 2>&1
stubs=$(grep -c '^- ⬜' "$REPO/docs/PARITY.md" 2>/dev/null | tr -dc '0-9'); [ -z "$stubs" ] && stubs=0
if [ "$stubs" -le 0 ]; then
  rm -f "$MARKER" "$COUNTER"
  echo '{"systemMessage":"Ralph loop: no stubs remain — WinForge parity complete. Loop disarmed."}'
  exit 0
fi

echo "$n" > "$COUNTER"

reason="Continue the winforge-web parity Ralph loop — iteration ${n}/${MAX_ITER}, ${stubs} stub modules left. Steps: (1) pick the single highest-value stub in docs/PARITY.md (prefer high feature_count in docs/feature-coverage.md and most-used modules); (2) read its WinForge source at WinForge/Pages/<Name>Module.xaml and .xaml.cs (read-only) for the exact feature set; (3) implement it as a REAL interactive module (src/modules/), with sub-tabs via ModuleTabs where WinForge uses them, and a Rust backend command for native operations; wire any external tool through the winget→choco→bundled resolver; register it and add EN + 粵語 i18n keys (keep en.ts/zh-Hant.ts in sync); (4) keep tsc --noEmit, vite build, and (when Rust changed) tauri build green; (5) screenshot-verify the module in the built app via the lowlevel-computer-use MCP and fix visual bugs; (6) stage ONLY the files you touched (git add <paths> — never -A, the tree is shared with the reactor agent) and push with: git push origin HEAD:main (the OneDrive post-commit backup runs automatically). Then stop — this hook will continue you to the next module. To stop the loop, delete ${MARKER}."

# Escape to JSON safely (prefer jq; fall back to a python one-liner).
if command -v jq >/dev/null 2>&1; then
  jq -cn --arg r "$reason" '{decision:"block", reason:$r}'
else
  python -c 'import json,sys; print(json.dumps({"decision":"block","reason":sys.argv[1]}))' "$reason"
fi
exit 0
