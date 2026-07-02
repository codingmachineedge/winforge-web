#!/usr/bin/env bash
# Install winforge-web git hooks. Any agent/clone can run this to (re)install.
#   bash tools/install-hooks.sh
set -e
REPO_DIR="$(git rev-parse --show-toplevel)"
HOOK="$REPO_DIR/.git/hooks/post-commit"
cat > "$HOOK" <<'EOF'
#!/usr/bin/env bash
# AUTO-INSTALLED by tools/install-hooks.sh — backs up to OneDrive after every commit.
# Runs in background-safe, never fails the commit.
REPO_DIR="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -z "$REPO_DIR" ] && REPO_DIR="$(pwd)"
bash "$REPO_DIR/tools/onedrive-backup.sh" || true
exit 0
EOF
chmod +x "$HOOK"
echo "Installed post-commit hook -> $HOOK"
