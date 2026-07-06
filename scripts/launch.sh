#!/usr/bin/env bash
# Emberdeep offline launcher.
#
# Builds the self-contained production bundle (every asset is baked into dist/,
# so playing needs no internet) and serves it locally with vite preview.
# Single-player is fully offline; only PeerJS co-op and the one-time Kokoro
# voice-model download require a connection.
#
#   scripts/launch.sh          build + serve, print the play URL
#   scripts/launch.sh --kill   just stop a running server, don't relaunch
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT"

KILL_ONLY=false
[[ "${1:-}" == "--kill" ]] && KILL_ONLY=true

PORT=4173

# Stop any server this script previously started. Match the command string
# (vite preview), not the port, so it still works if the port ever changes.
if pkill -f "vite preview" 2>/dev/null; then
  echo "Stopped a running Emberdeep server."
  sleep 1  # let the port free up before we rebind it
fi

if $KILL_ONLY; then
  exit 0
fi

echo "Building Emberdeep (self-contained, offline-ready)..."
npm run build >/dev/null

echo
echo "  Emberdeep is ready. Open this in your browser:"
echo
echo "      http://localhost:${PORT}/"
echo
echo "  Same Wi-Fi? Any phone/tablet can play at the Network URL printed below."
echo "  Press Ctrl+C in this terminal to stop the game."
echo

# --host exposes it on the LAN so a phone on the same network can play too.
# --strictPort keeps the URL above accurate instead of silently hopping ports.
exec npm run preview -- --port "$PORT" --strictPort --host
