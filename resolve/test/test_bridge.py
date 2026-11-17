"""Unit tests for the OpenEdit Resolve bridge, run against a fake Resolve.

    python3 -m unittest discover -s resolve/test -v
    python3 resolve/test/test_bridge.py
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
RESOLVE_DIR = os.path.dirname(HERE)
BRIDGE = os.path.join(RESOLVE_DIR, "openedit_bridge.py")
sys.path.insert(0, RESOLVE_DIR)
sys.path.insert(0, HERE)

import openedit_bridge as ob  # noqa: E402
from fake_resolve import FakeResolve, FakeProject, FakeTimeline  # noqa: E402


def make_bridge(resolve=None):
    resolve = resolve or FakeResolve.from_env()
    return ob.ResolveBridge(lambda: resolve), resolve


def call(bridge, cmd, args=None):
    return bridge.handle({"id": "t", "cmd": cmd, "args": args or {}})


class TempDirTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="openedit-test-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def touch(self, name):
        path = os.path.join(self.tmp, name)
        with open(path, "wb") as fh:
            fh.write(b"x")
        return path


class FrameMathTest(unittest.TestCase):
    def test_parse_fps(self):
        self.assertEqual(ob.parse_fps("25"), 25.0)
        self.assertEqual(ob.parse_fps(24), 24.0)
        self.assertAlmostEqual(ob.parse_fps("23.976"), 24000 / 1001, places=9)
        self.assertAlmostEqual(ob.parse_fps("29.97 DF"), 30000 / 1001, places=9)
        self.assertAlmostEqual(ob.parse_fps(59.94), 60000 / 1001, places=9)
        self.assertEqual(ob.parse_fps("", default=30.0), 30.0)
        with self.assertRaises(ob.BridgeError):
            ob.parse_fps("nope")

    def test_sec_frame_roundtrip(self):
        self.assertEqual(ob.sec_to_frame(1.0, 25), 25)
        self.assertEqual(ob.sec_to_frame(0.02, 25), 1)
        self.assertEqual(ob.sec_to_frame(0.019, 25), 0)  # 0.475 frames -> 0
        self.assertEqual(ob.sec_to_frame(0.5, 1), 1)     # half rounds up, not to even
        self.assertEqual(ob.frame_to_sec(90, 30), 3.0)
        ntsc = ob.parse_fps("29.97")
        self.assertEqual(ob.sec_to_frame(ob.frame_to_sec(107892, ntsc), ntsc), 107892)

    def test_range_inclusive_end(self):
        os.environ.pop("OPENEDIT_RESOLVE_END_EXCLUSIVE", None)
        self.assertEqual(ob.range_to_source_frames(0, 1, 25), (0, 24, 25))
        self.assertEqual(ob.range_to_source_frames(2.0, 2.5, 30), (60, 74, 15))
        self.assertIsNone(ob.range_to_source_frames(1.0, 1.01, 25))  # < 1 frame
        self.assertEqual(ob.range_to_source_frames(5, 100, 25, max_frames=150), (125, 149, 25))

    def test_range_exclusive_override(self):
        os.environ["OPENEDIT_RESOLVE_END_EXCLUSIVE"] = "1"
        try:
            self.assertEqual(ob.range_to_source_frames(0, 1, 25), (0, 25, 25))
        finally:
            del os.environ["OPENEDIT_RESOLVE_END_EXCLUSIVE"]

    def test_marker_colors(self):
        self.assertEqual(ob.marker_color("red"), "Red")
        self.assertEqual(ob.marker_color("GREEN"), "Green")
        self.assertEqual(ob.marker_color("orange"), "Sand")
        self.assertEqual(ob.marker_color("white"), "Cream")
        self.assertEqual(ob.marker_color(None), "Blue")
        self.assertEqual(ob.marker_color("magenta"), "Blue")
        valid = {"Blue", "Cyan", "Green", "Yellow", "Red", "Pink", "Purple", "Fuchsia", "Rose",
                 "Lavender", "Sky", "Mint", "Lemon", "Sand", "Cocoa", "Cream"}
        for c in ob.MARKER_COLORS.values():
            self.assertIn(c, valid)
        for k, v in ob.MARKER_COLORS.items():
            self.assertEqual(ob.RESOLVE_TO_OPENEDIT_COLOR[v], k)

    def test_srt_roundtrip(self):
        self.assertEqual(ob.srt_timestamp(3725.5), "01:02:05,500")
        d = tempfile.mkdtemp()
        try:
            p = ob.write_srt([{"start": 0, "end": 1.25, "text": "Hi"},
                              {"start": 2, "end": 3, "text": "there"}], os.path.join(d, "c.srt"))
            cues = ob._parse_srt(p)
            self.assertEqual(len(cues), 2)
            self.assertAlmostEqual(cues[0]["end"], 1.25)
            self.assertEqual(cues[1]["text"], "there")
        finally:
            shutil.rmtree(d)


class CompatTest(unittest.TestCase):
    def test_legacy_get_setting(self):
        class Legacy(object):
            def GetSetting(self, key=None):
                data = {"timelineFrameRate": "23.976"}
                return data if key is None else data.get(key)
        self.assertEqual(ob.get_settings(Legacy(), "timelineFrameRate"), "23.976")

    def test_legacy_clip_property(self):
        class Legacy(object):
            def GetClipProperty(self, key=None):
                if key is None:
                    return None
                return {"File Path": "/a.mov", "FPS": "25"}.get(key, "")
        self.assertEqual(ob.clip_props(Legacy())["File Path"], "/a.mov")

    def test_legacy_set_property(self):
        class Legacy(object):
            def __init__(self):
                self.p = {}

            def SetProperty(self, k, v):
                self.p[k] = v
                return True
        it = Legacy()
        self.assertTrue(ob.set_item_props(it, {"ZoomX": 1.2}))
        self.assertEqual(it.p, {"ZoomX": 1.2})


class CommandTest(TempDirTest):
    def test_ping_and_unknown(self):
        bridge, _ = make_bridge()
        self.assertEqual(call(bridge, "ping"), {"id": "t", "ok": True, "result": "pong"})
        r = call(bridge, "frobnicate")
        self.assertFalse(r["ok"])
        self.assertTrue(r["error"].startswith("unsupported:"))

    def test_status(self):
        bridge, _ = make_bridge()
        r = call(bridge, "status")["result"]
        self.assertEqual(r["host"], "resolve")
        self.assertTrue(r["connected"])
        self.assertEqual(r["project"], "Demo")
        self.assertEqual(r["sequence"], "Main")

    def test_status_not_connected_is_ok(self):
        def boom():
            raise ob.BridgeError("Could not connect")
        r = ob.ResolveBridge(boom).handle({"id": "s", "cmd": "status", "args": {}})
        self.assertTrue(r["ok"])
        self.assertFalse(r["result"]["connected"])
        r = ob.ResolveBridge(boom).handle({"id": "s", "cmd": "getTimeline", "args": {}})
        self.assertEqual(r, {"id": "s", "ok": False, "error": "Could not connect"})

    def test_get_timeline_converts_frames_relative_to_start(self):
        bridge, _ = make_bridge()
        r = call(bridge, "getTimeline")
        self.assertTrue(r["ok"], r)
        tl = r["result"]
        self.assertEqual(tl["name"], "Main")
        self.assertEqual(tl["fps"], 25.0)
        self.assertEqual((tl["width"], tl["height"]), (1920, 1080))
        self.assertEqual((tl["videoTracks"], tl["audioTracks"]), (1, 1))
        self.assertEqual(tl["duration"], 10.0)
        v = [c for c in tl["clips"] if c["kind"] == "video"][0]
        self.assertEqual((v["start"], v["end"]), (0.0, 10.0))
        self.assertEqual((v["sourceIn"], v["sourceOut"]), (2.0, 12.0))
        self.assertEqual(v["path"], "/media/interview.mov")
        self.assertEqual(v["track"], 1)
        self.assertEqual(tl["markers"], [{"time": 5.0, "name": "Intro", "color": "red", "comment": "hello"}])

    def test_apply_cut_plan_falls_back_to_timeline_import(self):
        src = self.touch("talk.mp4")
        xml = self.touch("talk.xml")
        bridge, resolve = make_bridge()
        pool = resolve.project.media_pool
        pool.fail_append = True
        plan = {"source": src, "duration": 20.0, "keep": [{"start": 0.0, "end": 2.0}], "cuts": []}
        r = call(bridge, "applyCutPlan", {"plan": plan, "sequenceName": "Edit", "xmlPath": xml})
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["result"]["sequence"], "Edit")
        self.assertEqual(r["result"]["method"], "importTimeline")
        self.assertIn("warning", r["result"])
        self.assertEqual(pool.imported_timelines[0][0], xml)
        self.assertEqual(pool.imported_timelines[0][1]["timelineName"], "Edit")
        # The empty timeline made before the failed append is gone; only the imported one has the name.
        names = [t.name for t in resolve.project.timelines]
        self.assertEqual(names.count("Edit"), 1)
        self.assertEqual(resolve.project.current.name, "Edit")

    def test_apply_cut_plan_without_xml_reports_append_failure(self):
        src = self.touch("talk.mp4")
        bridge, resolve = make_bridge()
        resolve.project.media_pool.fail_append = True
        plan = {"source": src, "duration": 20.0, "keep": [{"start": 0.0, "end": 2.0}], "cuts": []}
        r = call(bridge, "applyCutPlan", {"plan": plan})
        self.assertFalse(r["ok"])
        self.assertIn("AppendToTimeline added nothing", r["error"])

    def test_get_source_media(self):
        bridge, _ = make_bridge()
        self.assertEqual(call(bridge, "getSourceMedia")["result"], ["/media/interview.mov"])

    def test_apply_cut_plan_builds_clip_infos(self):
        src = self.touch("talk.mp4")
        bridge, resolve = make_bridge()
        project = resolve.project
        original = project.current
        plan = {"source": src, "duration": 20.0,
                "keep": [{"start": 0.0, "end": 1.0}, {"start": 2.5, "end": 4.0},
                         {"start": 5.0, "end": 5.01}, {"start": 10.0, "end": 12.0}],
                "cuts": []}
        r = call(bridge, "applyCutPlan", {"plan": plan, "sequenceName": "Edit - jump cuts"})
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["result"]["sequence"], "Edit - jump cuts")
        self.assertNotIn("warning", r["result"])
        calls = project.media_pool.append_calls
        self.assertEqual(len(calls), 1)
        frames = [(c["startFrame"], c["endFrame"]) for c in calls[0]]
        self.assertEqual(frames, [(0, 24), (63, 99), (250, 299)])  # 5.0-5.01 dropped
        for c in calls[0]:
            self.assertEqual(set(c), {"mediaPoolItem", "startFrame", "endFrame"})
            self.assertEqual(c["mediaPoolItem"].path, os.path.abspath(src))
        # New timeline is current, original untouched, source imported into OpenEdit bin.
        self.assertIsNot(project.current, original)
        self.assertEqual(len(original.tracks["video"][0]), 1)
        bins = [f.GetName() for f in project.media_pool.root.subfolders]
        self.assertEqual(bins, ["OpenEdit"])
        tl = call(bridge, "getTimeline")["result"]
        vids = [c for c in tl["clips"] if c["kind"] == "video"]
        self.assertEqual([(c["start"], c["end"]) for c in vids], [(0.0, 1.0), (1.0, 2.48), (2.48, 4.48)])

    def test_apply_cut_plan_uses_source_fps_and_unique_name(self):
        src = self.touch("talk.mov")
        bridge, resolve = make_bridge()
        resolve.project.media_pool.default_media_fps = "23.976"
        plan = {"source": src, "duration": 10, "keep": [{"start": 1.0, "end": 2.0}], "cuts": []}
        r1 = call(bridge, "applyCutPlan", {"plan": plan, "sequenceName": "Cut"})
        r2 = call(bridge, "applyCutPlan", {"plan": plan, "sequenceName": "Cut"})
        self.assertEqual(r1["result"]["sequence"], "Cut")
        self.assertEqual(r2["result"]["sequence"], "Cut (2)")
        info = resolve.project.media_pool.append_calls[0][0]
        self.assertEqual((info["startFrame"], info["endFrame"]), (24, 47))  # 23.976 fps
        # Second plan reused the already-imported media pool item.
        self.assertEqual(len(resolve.project.media_pool.root.subfolders[0].clips), 1)

    def test_apply_cut_plan_errors(self):
        bridge, _ = make_bridge()
        r = call(bridge, "applyCutPlan", {"plan": {"source": "/nope.mp4", "keep": [{"start": 0, "end": 1}]}})
        self.assertFalse(r["ok"])
        self.assertIn("not found", r["error"])
        r = call(bridge, "applyCutPlan", {})
        self.assertFalse(r["ok"])

    def test_add_markers(self):
        bridge, resolve = make_bridge()
        r = call(bridge, "addMarkers", {"markers": [
            {"time": 1.0, "name": "A", "color": "green", "comment": "c"},
            {"time": 5.0, "name": "B", "color": "orange", "duration": 2.0},  # frame 125 taken
            {"time": 7.0, "name": "C"},
        ]})
        self.assertEqual(r["result"], 3)
        m = resolve.project.current.markers
        self.assertEqual(m[25], {"color": "Green", "name": "A", "note": "c", "duration": 1})
        self.assertEqual(m[126]["color"], "Sand")
        self.assertEqual(m[126]["duration"], 50)
        self.assertEqual(m[175]["color"], "Blue")

    def test_import_media(self):
        a, b = self.touch("a.mp4"), self.touch("b.wav")
        bridge, resolve = make_bridge()
        self.assertEqual(call(bridge, "importMedia", {"paths": [a, b]})["result"], 2)
        self.assertEqual(call(bridge, "importMedia", {"paths": [a]})["result"], 1)  # no duplicate
        bin_ = resolve.project.media_pool.root.subfolders[0]
        self.assertEqual(len(bin_.clips), 2)
        self.assertFalse(call(bridge, "importMedia", {"paths": ["/missing.mov"]})["ok"])

    def test_place_clips_adds_tracks(self):
        broll, music = self.touch("broll.mp4"), self.touch("music.wav")
        bridge, resolve = make_bridge()
        r = call(bridge, "placeClips", {"clips": [
            {"path": broll, "at": 2.0, "track": 3, "sourceIn": 1.0, "sourceOut": 3.0},
            {"path": music, "at": 0.0, "track": 2, "gainDb": -12},
        ]})
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["result"], 2)
        tl = resolve.project.current
        self.assertEqual(tl.GetTrackCount("video"), 3)
        self.assertEqual(tl.GetTrackCount("audio"), 2)
        v_info, a_info = [c[0] for c in resolve.project.media_pool.append_calls]
        self.assertEqual(v_info["recordFrame"], 90050)
        self.assertEqual((v_info["startFrame"], v_info["endFrame"]), (25, 74))
        self.assertEqual((v_info["trackIndex"], v_info["mediaType"]), (3, 1))
        self.assertEqual((a_info["trackIndex"], a_info["mediaType"]), (2, 2))
        self.assertEqual(tl.tracks["audio"][1][0].properties["AudioVolume"], -12.0)

    def test_add_captions_subtitle_track(self):
        srt = os.path.join(self.tmp, "c.srt")
        cues = [{"start": 0, "end": 1, "text": "Hello"}, {"start": 1, "end": 2, "text": "World"}]
        ob.write_srt(cues, srt)
        bridge, resolve = make_bridge()
        r = call(bridge, "addCaptions", {"cues": cues, "srtPath": srt})["result"]
        self.assertEqual(r, {"added": 2, "file": os.path.abspath(srt), "method": "subtitleTrack"})
        self.assertEqual(resolve.project.current.GetTrackCount("subtitle"), 1)

    def test_add_captions_falls_back_to_markers(self):
        bridge, resolve = make_bridge()
        tl = resolve.project.current
        tl.AddTrack = lambda *a: False  # e.g. Resolve refuses subtitle tracks
        cues = [{"start": 1, "end": 2, "text": "Hello"}, {"start": 3, "end": 4, "text": "World"}]
        r = call(bridge, "addCaptions", {"cues": cues, "srtPath": ""})["result"]
        self.assertEqual(r["method"], "markers")
        self.assertEqual(r["added"], 2)
        self.assertTrue(os.path.exists(r["file"]))
        self.assertEqual(tl.markers[25]["note"], "Hello")
        self.assertEqual(tl.markers[25]["color"], "Cream")

    def test_add_zooms_static_on_contained_clips(self):
        src = self.touch("talk.mp4")
        bridge, resolve = make_bridge()
        plan = {"source": src, "duration": 20, "cuts": [],
                "keep": [{"start": 0, "end": 2}, {"start": 3, "end": 5}, {"start": 6, "end": 8}]}
        call(bridge, "applyCutPlan", {"plan": plan})
        # timeline: [0,2) [2,4) [4,6)
        r = call(bridge, "addZooms", {"zooms": [{"start": 1.9, "end": 4.1, "scale": 115},
                                                {"start": 4.5, "end": 5.5, "scale": 130}]})
        self.assertEqual(r["result"], 1)
        items = resolve.project.current.GetItemListInTrack("video", 1)
        self.assertEqual([it.properties["ZoomX"] for it in items], [1.0, 1.15, 1.0])
        self.assertEqual(items[1].properties["ZoomY"], 1.15)

    def test_render(self):
        bridge, resolve = make_bridge()
        out = os.path.join(self.tmp, "out", "final.mp4")
        r = call(bridge, "render", {"output": out})
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["result"], {"output": out})
        self.assertTrue(os.path.exists(out))
        s = resolve.project.jobs  # job deleted after completion
        self.assertEqual(s, {})
        self.assertEqual(resolve.project.render_settings["CustomName"], "final")
        self.assertFalse(call(bridge, "render", {"output": out, "preset": "Nope"})["ok"])

    def test_exceptions_become_json(self):
        bridge, resolve = make_bridge()
        resolve.project.GetCurrentTimeline = lambda: 1 / 0
        r = call(bridge, "getTimeline")
        self.assertFalse(r["ok"])
        self.assertIn("ZeroDivisionError", r["error"])


class ProtocolTest(TempDirTest):
    def run_bridge(self, stdin, *argv, **env_extra):
        env = dict(os.environ, **env_extra)
        proc = subprocess.run([sys.executable, BRIDGE] + list(argv), input=stdin,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              universal_newlines=True, env=env, timeout=60)
        return proc

    def test_ping_subprocess_without_resolve(self):
        proc = self.run_bridge('{"id":"abc","cmd":"ping","args":{}}\n')
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = proc.stdout.splitlines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(json.loads(lines[0]), {"id": "abc", "ok": True, "result": "pong"})

    def test_invalid_json(self):
        proc = self.run_bridge("not json\n")
        r = json.loads(proc.stdout.strip())
        self.assertFalse(r["ok"])
        self.assertIn("invalid JSON", r["error"])

    def test_fake_env_get_timeline(self):
        proc = self.run_bridge('{"id":"1","cmd":"getTimeline","args":{}}\n', OPENEDIT_RESOLVE_FAKE="1")
        r = json.loads(proc.stdout.strip())
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["result"]["name"], "Main")

    def test_fake_env_apply_cut_plan(self):
        src = self.touch("a.mp4")
        req = {"id": "x", "cmd": "applyCutPlan",
               "args": {"plan": {"source": src, "duration": 5, "keep": [{"start": 0, "end": 1}], "cuts": []}}}
        proc = self.run_bridge(json.dumps(req) + "\n", OPENEDIT_RESOLVE_FAKE="1")
        r = json.loads(proc.stdout.strip())
        self.assertEqual(r["id"], "x")
        self.assertEqual(r["result"]["sequence"], "OpenEdit - a")

    def test_serve_mode(self):
        reqs = "\n".join(json.dumps({"id": str(i), "cmd": c, "args": {}})
                         for i, c in enumerate(["ping", "status", "bogus", "getSourceMedia"])) + "\n"
        proc = self.run_bridge(reqs, "--serve", OPENEDIT_RESOLVE_FAKE="1")
        out = [json.loads(l) for l in proc.stdout.splitlines()]
        self.assertEqual([o["id"] for o in out], ["0", "1", "2", "3"])
        self.assertEqual(out[0]["result"], "pong")
        self.assertTrue(out[1]["result"]["connected"])
        self.assertFalse(out[2]["ok"])
        self.assertEqual(out[3]["result"], ["/media/interview.mov"])

    def test_stray_stdout_does_not_corrupt_protocol(self):
        # Anything printed by command code goes to stderr, never stdout.
        code = ("import sys; sys.path.insert(0, %r); import openedit_bridge as ob;"
                "ob.COMMANDS['ping'] = lambda self, a: (print('noise'), 'pong')[1];"
                "sys.exit(ob.main([]))" % RESOLVE_DIR)
        proc = subprocess.run([sys.executable, "-c", code], input='{"id":"n","cmd":"ping","args":{}}\n',
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        self.assertEqual(proc.stdout.splitlines(), ['{"id": "n", "ok": true, "result": "pong"}'])
        self.assertIn("noise", proc.stderr)

    def test_cli_cmd(self):
        proc = self.run_bridge("", "--cmd", "ping")
        self.assertEqual(json.loads(proc.stdout)["result"], "pong")


if __name__ == "__main__":
    unittest.main()
