#!/usr/bin/env bash
# OpenEdit - DaVinci Resolve bridge installer (macOS / Linux).
#
#   resolve/install.sh                 check everything, offer to install the menu script
#   resolve/install.sh --menu-script   also install "OpenEdit Status" without asking
#   resolve/install.sh --no-menu-script
#
# Nothing here modifies Resolve projects or preferences.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE="$HERE/openedit_bridge.py"
MENU_MODE="ask"
for a in "$@"; do
  case "$a" in
    --menu-script) MENU_MODE="yes" ;;
    --no-menu-script) MENU_MODE="no" ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
  esac
done

ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$*"; }
fail() { printf '  \033[31mfail\033[0m  %s\n' "$*"; }

case "$(uname -s)" in
  Darwin)
    APP="/Applications/DaVinci Resolve/DaVinci Resolve.app"
    API="/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting"
    LIB="$APP/Contents/Libraries/Fusion/fusionscript.so"
    RPY="$APP/Contents/Applications/ResolvePython"
    SCRIPTS_DIR="$HOME/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility"
    ;;
  Linux)
    APP="/opt/resolve"
    API="/opt/resolve/Developer/Scripting"
    LIB="/opt/resolve/libs/Fusion/fusionscript.so"
    RPY="/opt/resolve/bin/ResolvePython"
    SCRIPTS_DIR="$HOME/.local/share/DaVinciResolve/Fusion/Scripts/Utility"
    ;;
  *) echo "Unsupported OS; on Windows use install.ps1"; exit 1 ;;
esac
API="${RESOLVE_SCRIPT_API:-$API}"
LIB="${RESOLVE_SCRIPT_LIB:-$LIB}"

echo "OpenEdit - DaVinci Resolve bridge setup"
echo
echo "1. DaVinci Resolve"
if [ -e "$APP" ]; then ok "found $APP"; else fail "DaVinci Resolve not found at $APP"; fi
if [ -f "$LIB" ]; then ok "fusionscript: $LIB"; else fail "fusionscript not found ($LIB). Set RESOLVE_SCRIPT_LIB."; fi
if [ -d "$API/Modules" ]; then ok "scripting modules: $API/Modules"; else warn "scripting modules folder missing ($API/Modules); the bridge can load fusionscript directly"; fi

echo
echo "2. Python that can load fusionscript"
CANDIDATES=()
[ -n "${OPENEDIT_RESOLVE_PYTHON:-}" ] && CANDIDATES+=("$OPENEDIT_RESOLVE_PYTHON")
for p in python3 python3.12 python3.11 python3.10 python3.9 python3.8; do
  command -v "$p" >/dev/null 2>&1 && CANDIDATES+=("$(command -v "$p")")
done
[ -x "$RPY" ] && CANDIDATES+=("$RPY")
CHOSEN=""
for py in "${CANDIDATES[@]+"${CANDIDATES[@]}"}"; do
  if out="$(RESOLVE_SCRIPT_API="$API" RESOLVE_SCRIPT_LIB="$LIB" "$py" -c '
import sys
sys.path.insert(0, sys.argv[1])
import openedit_bridge as ob
ob.load_script_module()
print("%d.%d" % sys.version_info[:2])
' "$HERE" 2>&1)"; then
    ok "$py (Python $(echo "$out" | tail -1)) loads fusionscript"
    CHOSEN="$py"; break
  else
    warn "$py cannot load fusionscript: $(echo "$out" | tail -1 | cut -c1-160)"
  fi
done
if [ -z "$CHOSEN" ]; then
  fail "no compatible Python found. Install python3.11 (or use Resolve 21.1+ which bundles ResolvePython)"
  CHOSEN="python3"
fi
DEFAULT_PY="$(command -v python3 2>/dev/null || true)"
if [ "$CHOSEN" != "$DEFAULT_PY" ]; then
  echo
  echo "   The OpenEdit MCP server runs 'python3' by default. Tell it to use this one instead:"
  echo "     export OPENEDIT_RESOLVE_PYTHON=\"$CHOSEN\""
  echo "   (or add it to the \"env\" of the openedit MCP server in your Claude Code config)"
fi

echo
echo "3. Allow external scripting (required, one time)"
echo "   In DaVinci Resolve: Preferences > System > General >"
echo "     'External scripting using'  ->  Local"
echo "   then restart Resolve. (Free and Studio both support Local.)"

echo
echo "4. Connection check"
if "$CHOSEN" "$BRIDGE" --doctor; then
  ok "bridge connected to Resolve"
else
  warn "not connected yet - start Resolve, open a project, and enable external scripting (step 3)"
fi

echo
echo "5. Resolve menu script (Workspace > Scripts > OpenEdit Status)"
install_menu() {
  mkdir -p "$SCRIPTS_DIR"
  local dest="$SCRIPTS_DIR/OpenEdit Status.py"
  "$CHOSEN" - "$HERE/scripts/OpenEdit Status.py" "$dest" "$BRIDGE" "$CHOSEN" <<'PY'
import sys
src, dest, bridge, py = sys.argv[1:5]
text = open(src, encoding="utf-8").read()
text = text.replace("__OPENEDIT_BRIDGE__", bridge).replace("__OPENEDIT_PYTHON__", py)
open(dest, "w", encoding="utf-8").write(text)
PY
  ok "installed $dest"
}
case "$MENU_MODE" in
  yes) install_menu ;;
  no) echo "   skipped" ;;
  ask)
    if [ -t 0 ]; then
      read -r -p "   Install it now? [y/N] " ans
      case "$ans" in y|Y|yes) install_menu ;; *) echo "   skipped (re-run with --menu-script)";; esac
    else
      echo "   skipped (non-interactive; re-run with --menu-script)"
    fi
    ;;
esac
echo
echo "Done."
