#!/usr/bin/env bash
# Install the OpenEdit Premiere Pro panel (macOS).
#
#   ./install.sh          symlink this folder into the CEP extensions folder
#   ./install.sh --copy   copy instead (use when the repo may move)
#
# The panel is unsigned, so PlayerDebugMode is enabled for CSXS 9-13.
set -euo pipefail

BUNDLE_ID="com.openedit.premiere"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions"
DEST="$EXT_DIR/$BUNDLE_ID"
MODE="link"
[ "${1:-}" = "--copy" ] && MODE="copy"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "install.sh is for macOS. On Windows run install.ps1 in PowerShell." >&2
  exit 1
fi

mkdir -p "$EXT_DIR"
if [ -L "$DEST" ] || [ -e "$DEST" ]; then
  echo "Removing previous install at: $DEST"
  rm -rf "$DEST"
fi

if [ "$MODE" = "copy" ]; then
  mkdir -p "$DEST"
  # Only what the panel needs at runtime.
  for item in CSXS host lib index.html panel.js package.json .debug; do
    cp -R "$SRC/$item" "$DEST/"
  done
  echo "Copied panel to: $DEST"
else
  ln -s "$SRC" "$DEST"
  echo "Linked panel: $DEST -> $SRC"
fi

for v in 9 10 11 12 13; do
  defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1
done
echo "Enabled PlayerDebugMode for CSXS 9-13 (needed for unsigned extensions)."

# Create the shared token now so the MCP server and the panel agree from the start.
TOKEN_DIR="$HOME/.openedit"
TOKEN_FILE="$TOKEN_DIR/token"
if [ ! -s "$TOKEN_FILE" ]; then
  mkdir -p "$TOKEN_DIR"
  chmod 700 "$TOKEN_DIR"
  (umask 077 && od -An -N16 -tx1 /dev/urandom | tr -d ' \n' > "$TOKEN_FILE")
  chmod 600 "$TOKEN_FILE"
  echo "Created token file: $TOKEN_FILE"
fi

cat <<MSG

Next steps:
  1. Quit Premiere Pro completely and start it again (CEP reads PlayerDebugMode at launch).
  2. Open a project, then Window > Extensions > OpenEdit.
  3. The panel should say "Listening on 127.0.0.1:47821".
  4. Check from a terminal:  curl -s http://127.0.0.1:47821/health
  Remote debugging of the panel: http://localhost:8099 (Chrome).
MSG
