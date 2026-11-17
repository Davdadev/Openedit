#!/usr/bin/env python3
"""OpenEdit Status - DaVinci Resolve menu script (Workspace > Scripts > OpenEdit Status).

Shows whether the OpenEdit bridge can reach this Resolve instance from OUTSIDE
(the way Claude Code / the OpenEdit MCP server does). install.sh / install.ps1
fill in the two paths below.
"""

import json
import os
import subprocess
import sys

BRIDGE = r"__OPENEDIT_BRIDGE__"
PYTHON = r"__OPENEDIT_PYTHON__"


def _inside_info():
    lines = []
    try:
        r = resolve  # noqa: F821 - provided by Resolve
        lines.append("Resolve: %s %s" % (r.GetProductName(), r.GetVersionString()))
        project = r.GetProjectManager().GetCurrentProject()
        lines.append("Project: %s" % (project.GetName() if project else "(none)"))
        tl = project.GetCurrentTimeline() if project else None
        lines.append("Timeline: %s" % (tl.GetName() if tl else "(none)"))
    except Exception as exc:  # noqa: BLE001
        lines.append("Resolve info unavailable: %s" % exc)
    return lines


def _external_check():
    if BRIDGE.startswith("__") or not os.path.isfile(BRIDGE):
        return False, ["Bridge script not found (%s). Re-run resolve/install.sh." % BRIDGE]
    py = PYTHON if not PYTHON.startswith("__") else ("python" if os.name == "nt" else "python3")
    env = dict(os.environ)
    for k in ("PYTHONHOME", "PYTHONPATH"):  # don't leak Resolve's embedded python setup
        env.pop(k, None)
    try:
        proc = subprocess.run([py, BRIDGE, "--cmd", "status"], stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, universal_newlines=True, timeout=30, env=env)
        resp = json.loads(proc.stdout.strip().splitlines()[-1])
    except Exception as exc:  # noqa: BLE001
        return False, ["Could not run bridge with %s: %s" % (py, exc)]
    res = resp.get("result") or {}
    if resp.get("ok") and res.get("connected"):
        return True, ["External connection: OK", "Bridge python: %s" % py]
    return False, ["External connection: FAILED",
                   str(res.get("detail") or resp.get("error") or "unknown error"),
                   "Fix: Preferences > System > General > External scripting using: Local, then restart Resolve."]


def main():
    ok, ext = _external_check()
    lines = ["OpenEdit bridge status", ""] + _inside_info() + [""] + ext
    text = "\n".join(lines)
    print(text)
    try:
        ui = fusion.UIManager  # noqa: F821 - provided by Resolve
        disp = bmd.UIDispatcher(ui)  # noqa: F821
        win = disp.AddWindow(
            {"ID": "OpenEditStatus", "WindowTitle": "OpenEdit", "Geometry": [200, 200, 520, 260]},
            ui.VGroup([ui.TextEdit({"ID": "Text", "Text": text, "ReadOnly": True}),
                       ui.Button({"ID": "Close", "Text": "Close"})]))

        def _close(ev):
            disp.ExitLoop()

        win.On.OpenEditStatus.Close = _close
        win.On.Close.Clicked = _close
        win.Show()
        disp.RunLoop()
        win.Hide()
    except Exception:  # noqa: BLE001 - UIManager isn't available everywhere; console output above
        pass


main()
