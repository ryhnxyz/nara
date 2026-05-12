#!/usr/bin/env bash
# Installs naracli + agentx-cli globally for production deployment.
# After running, enable USE_GLOBAL_NARACLI=1 and USE_GLOBAL_AGENTXCLI=1 in .env
# to skip per-invocation `npx` bootstrap overhead.

set -euo pipefail

echo "→ Installing naracli globally..."
npm i -g naracli

echo "→ Installing agentx-cli globally..."
npm i -g agentx-cli

echo
echo "✓ Installed. Versions:"
naracli --version || echo "naracli not in PATH — check npm global prefix"
agentx-cli --version 2>/dev/null || agentx --version 2>/dev/null || echo "agentx-cli not in PATH"
echo
echo "Next: set these in .env:"
echo "  USE_GLOBAL_NARACLI=1"
echo "  USE_GLOBAL_AGENTXCLI=1"
