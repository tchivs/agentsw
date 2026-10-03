#!/usr/bin/env bash
#
# Builds the sandbox the README demo GIF is recorded in.
#
# `AGENTSW_HOME` moves the whole layout — the store and every agent directory —
# under one throwaway root, so the recording can never touch the real
# ~/.config/agentsw or anyone's agent configs. The nine agent directories are
# created empty because that is exactly what `detect()` looks at, and the store
# is seeded with providers already saved, so the demo shows a switch rather than
# onboarding. Every credential in it is a placeholder.
#
#   scripts/demo-setup.sh [/tmp/asw-demo]
#
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sandbox="${1:-/tmp/asw-demo}"

if [ ! -f "$root/dist/index.js" ]; then
  echo "dist/index.js is missing — run: npm run build" >&2
  exit 1
fi

rm -rf "$sandbox"
mkdir -p \
  "$sandbox/.claude" \
  "$sandbox/.codex" \
  "$sandbox/.omp/agent" \
  "$sandbox/.pi/agent" \
  "$sandbox/.prime/agent" \
  "$sandbox/.config/opencode" \
  "$sandbox/.hermes" \
  "$sandbox/.workbuddy" \
  "$sandbox/.dsh" \
  "$sandbox/.config/agentsw" \
  "$sandbox/bin"

# `asw` is a shim onto the built CLI, so the recording can type the real binary
# name without anything being installed globally.
cat > "$sandbox/bin/asw" <<EOF
#!/bin/sh
exec node "$root/dist/index.js" "\$@"
EOF
chmod +x "$sandbox/bin/asw"

cat > "$sandbox/.config/agentsw/config.json" <<'JSON'
{
  "version": 1,
  "language": "en",
  "active": "myproxy",
  "providers": {
    "myproxy": {
      "id": "myproxy",
      "name": "myproxy",
      "protocol": "openai",
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "sk-demo-placeholder-not-a-real-key",
      "openaiApi": "responses",
      "defaultModel": "glm-5.3-flash",
      "models": [
        {
          "id": "glm-5.3-flash",
          "name": "GLM-5.3 Flash",
          "contextWindow": 200000,
          "maxOutput": 128000,
          "reasoning": true,
          "reasoningEfforts": ["low", "medium", "high"],
          "imageInput": false
        },
        {
          "id": "deepseek-v4.1-flash",
          "name": "DeepSeek V4.1 Flash",
          "contextWindow": 160000,
          "maxOutput": 65536,
          "reasoning": true,
          "imageInput": false
        }
      ]
    },
    "myproxy-anthropic": {
      "id": "myproxy-anthropic",
      "name": "myproxy (anthropic)",
      "protocol": "anthropic",
      "baseUrl": "https://api.example.com",
      "apiKey": "sk-demo-placeholder-not-a-real-key",
      "defaultModel": "claude-sonnet-5",
      "smallModel": "claude-haiku-4-5",
      "models": [
        {
          "id": "claude-sonnet-5",
          "name": "Claude Sonnet 5",
          "contextWindow": 200000,
          "maxOutput": 64000,
          "reasoning": true,
          "imageInput": true
        },
        {
          "id": "claude-haiku-4-5",
          "name": "Claude Haiku 4.5",
          "contextWindow": 200000,
          "maxOutput": 32000,
          "imageInput": true
        }
      ]
    }
  }
}
JSON
chmod 600 "$sandbox/.config/agentsw/config.json"

echo "demo sandbox ready: $sandbox"
