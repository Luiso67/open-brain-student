#!/bin/bash
# Connects Claude Desktop to your open-brain-mcp function.
#
# 1. Makes a new random access key (never shown on screen).
# 2. Adds an "open-brain" server to Claude Desktop's config, keeping every
#    other setting in that file. A backup is saved next to it first.
# 3. Prints the key's SHA-256 fingerprint. That goes into Supabase as the
#    MCP_ACCESS_KEY_SHA256 secret. The fingerprint cannot be used to log in,
#    so it is safe to see and copy. Run again any time to rotate the key.
set -euo pipefail

PROJECT_REF="vmdrvujkzlvpuzzttfxg"
URL="https://${PROJECT_REF}.supabase.co/functions/v1/open-brain-mcp"
CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"

read -rp "Press Enter to create your Open Brain access key and connect Claude: " _
KEY=$(openssl rand -hex 32)

mkdir -p "$(dirname "$CONFIG")"
if [[ -f "$CONFIG" ]]; then
  cp "$CONFIG" "$CONFIG.backup-$(date +%Y%m%d-%H%M%S)"
fi

MCP_KEY="$KEY" MCP_URL="$URL" python3 - "$CONFIG" <<'PY'
import json, os, sys
path = sys.argv[1]
try:
    with open(path) as f:
        cfg = json.load(f)
except FileNotFoundError:
    cfg = {}
cfg.setdefault("mcpServers", {})["open-brain"] = {
    "command": "npx",
    "args": ["-y", "mcp-remote", os.environ["MCP_URL"],
             "--header", "Authorization: Bearer " + os.environ["MCP_KEY"]],
}
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(cfg, f, indent=2)
os.chmod(tmp, 0o600)
os.replace(tmp, path)
PY

FINGERPRINT=$(printf '%s' "$KEY" | shasum -a 256 | cut -c1-64)
unset KEY

echo "Claude Desktop is set up."
echo "Fingerprint for the MCP_ACCESS_KEY_SHA256 secret in Supabase:"
echo "$FINGERPRINT"
