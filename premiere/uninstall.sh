#!/usr/bin/env bash
# Remove the OpenEdit Premiere Pro panel (macOS).
#
#   ./uninstall.sh               remove the panel only
#   ./uninstall.sh --debug-off   also turn PlayerDebugMode off again (CSXS 9-13)
#
# ~/.openedit/token is left alone: the MCP server uses it too.
set -euo pipefail

DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.openedit.premiere"
if [ -L "$DEST" ] || [ -e "$DEST" ]; then
  rm -rf "$DEST"
  echo "Removed: $DEST"
else
  echo "Not installed: $DEST"
fi

if [ "${1:-}" = "--debug-off" ]; then
  for v in 9 10 11 12 13; do
    defaults delete "com.adobe.CSXS.$v" PlayerDebugMode 2>/dev/null || true
  done
  echo "PlayerDebugMode removed for CSXS 9-13 (other unsigned panels will stop loading too)."
fi
echo "Restart Premiere Pro to finish."
