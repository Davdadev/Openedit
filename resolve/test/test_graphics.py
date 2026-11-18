"""Graphics commands of the OpenEdit Resolve bridge (editable Fusion Text+ titles), against the fake Resolve.

    python3 -m unittest discover -s resolve/test -v
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import openedit_bridge as ob  # noqa: E402
from fake_resolve import FakeResolve  # noqa: E402


def call(bridge, cmd, args=None):
    return bridge.handle({"id": "g", "cmd": cmd, "args": args or {}})


SPEC = {
    "tool": "TextPlus",
    "inputs": {
        "StyledText": "Maya Okafor\nHead of Product",
        "Font": "Open Sans",
        "Style": "Bold",
        "Size": 0.036,
        "Center": [0.09, 0.17],
        "HorizontalLeftCenterRight": -1,
        "Red1": 1, "Green1": 1, "Blue1": 1, "Alpha1": 1,
        "Enabled2": 1, "Opacity2": 0.86,
    },
    "keys": {"Opacity1": [[0, 0], [15, 1], [139, 1], [150, 0]], "Opacity2": [[0, 0], [15, 0.86], [139, 0.86], [150, 0]]},
    "durationFrames": 150,
}


class FusionTitleTest(unittest.TestCase):
    def test_timecode(self):
        self.assertEqual(ob.frames_to_timecode(90000, 25), "01:00:00:00")
        self.assertEqual(ob.frames_to_timecode(90000 + 25 * 61 + 7, 25), "01:01:01:07")
        self.assertEqual(ob.frames_to_timecode(30, 29.97), "00:00:01:00")

    def test_inserts_editable_text_plus_with_keys(self):
        resolve = FakeResolve.from_env()
        bridge = ob.ResolveBridge(lambda: resolve)
        r = call(bridge, "addFusionTitle", {"at": 4.0, "track": 3, "duration": 5, "spec": SPEC, "settingPath": "/tmp/x.setting"})
        self.assertTrue(r["ok"], r.get("error"))
        res = r["result"]
        tl = resolve.project.GetCurrentTimeline()
        self.assertEqual(res["timecode"], ob.frames_to_timecode(tl.GetStartFrame() + 4 * 25, 25))
        item = tl.fusion_titles[0]
        self.assertEqual(item.track, 3)
        self.assertEqual(item.start, tl.GetStartFrame() + 100)
        self.assertEqual(tl.GetTrackCount("video"), 3)
        tool = item.comp.FindTool("Template")
        self.assertEqual(tool.inputs["StyledText"], "Maya Okafor\nHead of Product")
        self.assertEqual(tool.inputs["Center"], {1: 0.09, 2: 0.17})
        self.assertNotIn("Opacity1", tool.inputs)
        self.assertEqual(tool.modifiers["Opacity1"], "BezierSpline")
        self.assertEqual(tool.keys["Opacity1"], [(0, 0), (15, 1), (139, 1), (150, 0)])
        self.assertEqual(res["notes"], [])
        # 11 static inputs (Opacity2 is keyed instead) + 2 keyed inputs.
        self.assertEqual(res["inputs"], 13)

    def test_unknown_title_errors_cleanly(self):
        resolve = FakeResolve.from_env()
        bridge = ob.ResolveBridge(lambda: resolve)
        r = call(bridge, "addFusionTitle", {"at": 0, "spec": SPEC, "name": "Nope"})
        self.assertFalse(r["ok"])
        self.assertIn("did not insert", r["error"])


if __name__ == "__main__":
    unittest.main()
