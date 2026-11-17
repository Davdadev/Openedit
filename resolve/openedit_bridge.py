#!/usr/bin/env python3
"""OpenEdit <-> DaVinci Resolve bridge.

Talks to a running DaVinci Resolve through its external Python scripting API
(DaVinciResolveScript / fusionscript). Standard library only, Python 3.8+.

Wire protocol (see docs/PROTOCOL.md):

    stdin : one JSON request line   {"id": "...", "cmd": "...", "args": {...}}
    stdout: one JSON response line  {"id": "...", "ok": true, "result": ...}
                                    {"id": "...", "ok": false, "error": "..."}
    stderr: logs

Modes:
    openedit_bridge.py                      one request in, one response out
    openedit_bridge.py --serve              newline-delimited JSON loop until EOF
    openedit_bridge.py --cmd status [--args '{"k":1}']   convenience for humans
    openedit_bridge.py --doctor             human-readable environment report

Environment:
    RESOLVE_SCRIPT_API        Resolve "Developer/Scripting" folder (Modules/ is appended)
    RESOLVE_SCRIPT_LIB        full path to fusionscript.so / fusionscript.dll
    OPENEDIT_RESOLVE_PYTHON   interpreter to fall back to when fusionscript cannot
                              load into the current Python (also used by the Node side)
    OPENEDIT_RESOLVE_FAKE=1   use the in-repo fake Resolve (resolve/test/fake_resolve.py)
    OPENEDIT_RESOLVE_END_EXCLUSIVE=1   treat AppendToTimeline endFrame as exclusive
                              (default: inclusive, which is what Resolve does)
"""

from __future__ import annotations

import glob
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time

BRIDGE_VERSION = "0.1.0"
BIN_NAME = "OpenEdit"
HERE = os.path.dirname(os.path.abspath(__file__))

EXTERNAL_SCRIPTING_HINT = (
    "Make sure DaVinci Resolve is running with a project open, and that "
    "Preferences > System > General > 'External scripting using' is set to 'Local' "
    "(restart Resolve after changing it)."
)

# OpenEdit marker colors -> Resolve marker color names. Resolve has no orange or
# white marker; Sand and Cream are the closest.
MARKER_COLORS = {
    "red": "Red",
    "green": "Green",
    "blue": "Blue",
    "yellow": "Yellow",
    "purple": "Purple",
    "orange": "Sand",
    "white": "Cream",
}
DEFAULT_MARKER_COLOR = "Blue"
RESOLVE_TO_OPENEDIT_COLOR = {
    "Red": "red", "Rose": "red", "Pink": "red",
    "Green": "green", "Mint": "green",
    "Blue": "blue", "Cyan": "blue", "Sky": "blue",
    "Yellow": "yellow", "Lemon": "yellow",
    "Purple": "purple", "Fuchsia": "purple", "Lavender": "purple",
    "Sand": "orange", "Cocoa": "orange",
    "Cream": "white",
}

# Nominal NTSC rates as reported by Resolve -> exact rational rate.
NTSC_RATES = {
    23.976: 24000.0 / 1001.0,
    29.97: 30000.0 / 1001.0,
    47.952: 48000.0 / 1001.0,
    59.94: 60000.0 / 1001.0,
    119.88: 120000.0 / 1001.0,
}


class BridgeError(Exception):
    pass


def log(*parts):
    print("[openedit-resolve]", *parts, file=sys.stderr)
    sys.stderr.flush()


# --------------------------------------------------------------------------
# Pure helpers (unit tested)
# --------------------------------------------------------------------------

def parse_fps(value, default=None):
    """Parse a Resolve frame-rate value ('23.976', 25, '29.97 DF') to an exact float."""
    if value is None or value == "":
        if default is None:
            raise BridgeError("frame rate unavailable")
        return default
    try:
        if isinstance(value, (int, float)):
            f = float(value)
        else:
            f = float(str(value).strip().split()[0])
    except (ValueError, IndexError):
        if default is None:
            raise BridgeError("could not parse frame rate %r" % (value,))
        return default
    if f <= 0:
        if default is None:
            raise BridgeError("invalid frame rate %r" % (value,))
        return default
    for nominal, exact in NTSC_RATES.items():
        if abs(f - nominal) < 0.0015:
            return exact
    return f


def sec_to_frame(seconds, fps):
    """Seconds -> nearest whole frame."""
    return int(math.floor(float(seconds) * fps + 0.5 + 1e-9))


def frame_to_sec(frame, fps):
    return round(float(frame) / fps, 6)


def end_frame_inclusive():
    return os.environ.get("OPENEDIT_RESOLVE_END_EXCLUSIVE", "") not in ("1", "true", "yes")


def range_to_source_frames(start, end, fps, max_frames=None):
    """Map a [start, end) seconds range to (startFrame, endFrame, frameCount) for Resolve.

    endFrame follows Resolve's AppendToTimeline semantics: by default it is the
    LAST frame included (inclusive), so a 1s range at 25fps from 0 is (0, 24, 25).
    Returns None when the range is shorter than one frame.
    """
    sf = max(0, sec_to_frame(start, fps))
    ef_excl = sec_to_frame(end, fps)
    if max_frames is not None and max_frames > 0:
        ef_excl = min(ef_excl, int(max_frames))
    count = ef_excl - sf
    if count < 1:
        return None
    ef = ef_excl - 1 if end_frame_inclusive() else ef_excl
    return sf, ef, count


def marker_color(color):
    if not color:
        return DEFAULT_MARKER_COLOR
    return MARKER_COLORS.get(str(color).lower(), DEFAULT_MARKER_COLOR)


def norm_path(p):
    if not p:
        return ""
    return os.path.normcase(os.path.realpath(os.path.abspath(os.path.expanduser(str(p)))))


def srt_timestamp(seconds):
    ms = int(round(max(0.0, float(seconds)) * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return "%02d:%02d:%02d,%03d" % (h, m, s, ms)


def write_srt(cues, path):
    lines = []
    for i, cue in enumerate(cues, 1):
        lines.append(str(i))
        lines.append("%s --> %s" % (srt_timestamp(cue["start"]), srt_timestamp(cue["end"])))
        lines.append(str(cue.get("text", "")).strip())
        lines.append("")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    return path


# --------------------------------------------------------------------------
# Locating and loading DaVinciResolveScript / fusionscript
# --------------------------------------------------------------------------

def default_paths():
    """(scripting API dir, fusionscript lib path, bundled ResolvePython) for this OS."""
    if sys.platform.startswith("darwin"):
        api = "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting"
        app = "/Applications/DaVinci Resolve/DaVinci Resolve.app"
        lib = app + "/Contents/Libraries/Fusion/fusionscript.so"
        py = app + "/Contents/Applications/ResolvePython"
    elif sys.platform.startswith("win") or sys.platform.startswith("cygwin"):
        programdata = os.environ.get("PROGRAMDATA", r"C:\ProgramData")
        api = os.path.join(programdata, "Blackmagic Design", "DaVinci Resolve", "Support", "Developer", "Scripting")
        base = r"C:\Program Files\Blackmagic Design\DaVinci Resolve"
        lib = os.path.join(base, "fusionscript.dll")
        py = os.path.join(base, "ResolvePython", "ResolvePython.exe")
    else:
        api = "/opt/resolve/Developer/Scripting"
        lib = "/opt/resolve/libs/Fusion/fusionscript.so"
        py = "/opt/resolve/bin/ResolvePython"
    return api, lib, py


def script_paths():
    api_default, lib_default, _ = default_paths()
    api = os.environ.get("RESOLVE_SCRIPT_API") or api_default
    lib = os.environ.get("RESOLVE_SCRIPT_LIB") or lib_default
    return api, lib


def _load_extension(name, path):
    import importlib.machinery
    import importlib.util
    loader = importlib.machinery.ExtensionFileLoader(name, path)
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


_SCRIPT_MODULE = None


def load_script_module():
    """Return the fusionscript module (what DaVinciResolveScript re-exports), cached.

    Raises BridgeError with an actionable message on failure.
    """
    global _SCRIPT_MODULE
    if _SCRIPT_MODULE is None:
        _SCRIPT_MODULE = _load_script_module_uncached()
    return _SCRIPT_MODULE


def _load_script_module_uncached():
    api, lib = script_paths()
    modules_dir = os.path.join(api, "Modules")
    # Export so DaVinciResolveScript.py (if used) finds the same library.
    os.environ.setdefault("RESOLVE_SCRIPT_LIB", lib)
    errors = []

    # 1) Resolve's own bundled python, or any env where it already works.
    try:
        import DaVinciResolveScript as dvr  # type: ignore
        return dvr
    except Exception as exc:  # noqa: BLE001 - we report everything
        errors.append("import DaVinciResolveScript: %s" % exc)

    # 2) The official Modules folder.
    if os.path.isdir(modules_dir) and modules_dir not in sys.path:
        sys.path.append(modules_dir)
        try:
            import DaVinciResolveScript as dvr  # type: ignore
            return dvr
        except Exception as exc:  # noqa: BLE001
            errors.append("Modules/DaVinciResolveScript: %s" % exc)

    # 3) Load fusionscript directly.
    if os.path.isfile(lib):
        try:
            return _load_extension("fusionscript", lib)
        except Exception as exc:  # noqa: BLE001
            errors.append("fusionscript (%s): %s" % (lib, exc))
            raise BridgeError(incompatible_python_message(lib, exc))
    raise BridgeError(
        "DaVinci Resolve scripting library not found (looked for %s). Is DaVinci Resolve installed? "
        "Set RESOLVE_SCRIPT_LIB to the full path of fusionscript%s and RESOLVE_SCRIPT_API to the "
        "Developer/Scripting folder. Details: %s"
        % (lib, ".dll" if os.name == "nt" else ".so", "; ".join(errors))
    )


def incompatible_python_message(lib, exc):
    alts = [p for p in candidate_pythons() if p != sys.executable]
    suggestion = alts[0] if alts else "python3.11"
    return (
        "fusionscript could not be loaded into this Python (%s %s, %s): %s. "
        "Resolve's scripting library only supports some Python versions/architectures. "
        "Point OpenEdit at a compatible interpreter, e.g. OPENEDIT_RESOLVE_PYTHON=\"%s\" "
        "(Resolve 21.1+ ships one: %s)."
        % (sys.executable, ".".join(map(str, sys.version_info[:3])), _arch(), exc, suggestion,
           default_paths()[2])
    )


def _arch():
    import platform
    return platform.machine() or "unknown-arch"


def candidate_pythons():
    """Interpreters that may load fusionscript, best first."""
    out = []
    env = os.environ.get("OPENEDIT_RESOLVE_PYTHON")
    if env:
        out.append(env)
    bundled = default_paths()[2]
    if os.path.isfile(bundled):
        out.append(bundled)
    for name in ("python3.12", "python3.11", "python3.10", "python3.9", "python3.8"):
        found = shutil.which(name)
        if found:
            out.append(found)
    seen, uniq = set(), []
    for p in out:
        if p not in seen:
            seen.add(p)
            uniq.append(p)
    return uniq


def connect_resolve():
    """Return a live `resolve` object or raise BridgeError."""
    if os.environ.get("OPENEDIT_RESOLVE_FAKE") in ("1", "true", "yes"):
        sys.path.insert(0, os.path.join(HERE, "test"))
        import fake_resolve  # type: ignore
        return fake_resolve.FakeResolve.from_env()
    dvr = load_script_module()
    resolve = dvr.scriptapp("Resolve")
    if resolve is None:
        raise BridgeError("Could not connect to DaVinci Resolve. " + EXTERNAL_SCRIPTING_HINT)
    return resolve


# --------------------------------------------------------------------------
# API compatibility shims (Resolve 18 -> 21 renamed several calls)
# --------------------------------------------------------------------------

def _has(obj, name):
    try:
        return callable(getattr(obj, name, None))
    except Exception:  # noqa: BLE001
        return False


def get_settings(obj, key=None):
    """Project/Timeline settings dict (GetSettings in 21+, GetSetting() before)."""
    settings = None
    for name in ("GetSettings", "GetSetting"):
        if _has(obj, name):
            try:
                settings = getattr(obj, name)()
            except TypeError:
                settings = None
            if isinstance(settings, dict) and settings:
                break
            settings = None
    if key is None:
        return settings or {}
    if settings and key in settings:
        return settings[key]
    if _has(obj, "GetSetting"):
        try:
            return obj.GetSetting(key)
        except Exception:  # noqa: BLE001
            return None
    return None


def clip_props(mpi):
    """All clip properties of a MediaPoolItem as a dict."""
    if mpi is None:
        return {}
    try:
        props = mpi.GetClipProperty()
        if isinstance(props, dict):
            return props
    except Exception:  # noqa: BLE001
        pass
    out = {}
    for key in ("File Path", "FPS", "Type", "Frames", "Resolution", "Clip Name"):
        try:
            out[key] = mpi.GetClipProperty(key)
        except Exception:  # noqa: BLE001
            pass
    return out


def set_item_props(item, props):
    if _has(item, "SetProperties"):
        try:
            if item.SetProperties(props):
                return True
        except Exception:  # noqa: BLE001
            pass
    ok = True
    for k, v in props.items():
        try:
            ok = bool(item.SetProperty(k, v)) and ok
        except Exception:  # noqa: BLE001
            ok = False
    return ok


def _int(v, default=0):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


# --------------------------------------------------------------------------
# The bridge
# --------------------------------------------------------------------------

class ResolveBridge(object):
    def __init__(self, resolve_factory=connect_resolve):
        self._factory = resolve_factory
        self._resolve = None

    # ---- plumbing ---------------------------------------------------------

    @property
    def resolve(self):
        if self._resolve is None:
            self._resolve = self._factory()
        return self._resolve

    def project(self):
        pm = self.resolve.GetProjectManager()
        project = pm.GetCurrentProject() if pm else None
        if project is None:
            raise BridgeError("No project is open in DaVinci Resolve.")
        return project

    def timeline(self, project=None):
        project = project or self.project()
        tl = project.GetCurrentTimeline()
        if tl is None:
            raise BridgeError("No active timeline in DaVinci Resolve. Open a timeline on the Edit page.")
        return tl

    def timeline_fps(self, tl, project=None):
        fps = get_settings(tl, "timelineFrameRate")
        if not fps and project is not None:
            fps = get_settings(project, "timelineFrameRate")
        return parse_fps(fps, default=24.0)

    def handle(self, request):
        """Dispatch one request dict -> response dict. Never raises."""
        rid = request.get("id") if isinstance(request, dict) else None
        try:
            if not isinstance(request, dict):
                raise BridgeError("request must be a JSON object")
            cmd = request.get("cmd")
            args = request.get("args") or {}
            if not isinstance(args, dict):
                raise BridgeError("args must be an object")
            fn = COMMANDS.get(cmd)
            if fn is None:
                raise BridgeError("unsupported: unknown command %r" % (cmd,))
            result = fn(self, args)
            return {"id": rid, "ok": True, "result": result}
        except BridgeError as exc:
            return {"id": rid, "ok": False, "error": str(exc)}
        except Exception as exc:  # noqa: BLE001 - every failure becomes JSON
            import traceback
            traceback.print_exc(file=sys.stderr)
            return {"id": rid, "ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}

    # ---- media pool helpers ----------------------------------------------

    def _walk_folders(self, folder):
        yield folder
        for sub in folder.GetSubFolderList() or []:
            for f in self._walk_folders(sub):
                yield f

    def find_media_item(self, media_pool, path):
        target = norm_path(path)
        for folder in self._walk_folders(media_pool.GetRootFolder()):
            for clip in folder.GetClipList() or []:
                fp = clip_props(clip).get("File Path")
                if fp and norm_path(fp) == target:
                    return clip
        return None

    def openedit_bin(self, media_pool):
        root = media_pool.GetRootFolder()
        for sub in root.GetSubFolderList() or []:
            if sub.GetName() == BIN_NAME:
                return sub
        folder = media_pool.AddSubFolder(root, BIN_NAME)
        if folder is None:
            raise BridgeError("could not create media pool bin %r" % BIN_NAME)
        return folder

    def import_into_bin(self, media_pool, paths):
        if not paths:
            return []
        previous = media_pool.GetCurrentFolder() if _has(media_pool, "GetCurrentFolder") else None
        media_pool.SetCurrentFolder(self.openedit_bin(media_pool))
        try:
            items = None
            try:
                items = media_pool.ImportMedia([{"FilePath": p} for p in paths])
            except Exception:  # noqa: BLE001
                items = None
            if not items:
                items = media_pool.ImportMedia(list(paths))
            return list(items or [])
        finally:
            if previous is not None:
                try:
                    media_pool.SetCurrentFolder(previous)
                except Exception:  # noqa: BLE001
                    pass

    def ensure_media_item(self, media_pool, path):
        if not path:
            raise BridgeError("missing media path")
        if not os.path.exists(path):
            raise BridgeError("media file not found: %s" % path)
        item = self.find_media_item(media_pool, path)
        if item is not None:
            return item
        imported = self.import_into_bin(media_pool, [os.path.abspath(path)])
        if not imported:
            raise BridgeError("DaVinci Resolve could not import %s" % path)
        return imported[0]

    @staticmethod
    def media_fps(mpi, fallback):
        return parse_fps(clip_props(mpi).get("FPS"), default=fallback)

    @staticmethod
    def media_kind(mpi):
        t = str(clip_props(mpi).get("Type", "")).lower()
        if "video" in t or "still" in t or "image" in t or "timeline" in t:
            return "video"
        if "audio" in t:
            return "audio"
        return "video"

    # ---- commands ---------------------------------------------------------

    def cmd_ping(self, args):
        return "pong"

    def cmd_status(self, args):
        status = {"host": "resolve", "connected": False}
        try:
            resolve = self.resolve
        except Exception as exc:  # noqa: BLE001 - status never fails
            status["detail"] = str(exc)
            return status
        status["connected"] = True
        try:
            product = resolve.GetProductName() if _has(resolve, "GetProductName") else "DaVinci Resolve"
            status["version"] = "%s %s" % (product, resolve.GetVersionString())
        except Exception:  # noqa: BLE001
            pass
        pm = resolve.GetProjectManager()
        project = pm.GetCurrentProject() if pm else None
        if project is None:
            status["detail"] = "No project open"
            return status
        status["project"] = project.GetName()
        tl = project.GetCurrentTimeline()
        if tl is not None:
            status["sequence"] = tl.GetName()
        else:
            status["detail"] = "No active timeline"
        return status

    def cmd_getTimeline(self, args):
        project = self.project()
        tl = self.timeline(project)
        fps = self.timeline_fps(tl, project)
        tl_start = tl.GetStartFrame()
        tl_end = tl.GetEndFrame()
        width = _int(get_settings(tl, "timelineResolutionWidth"), 0) or None
        height = _int(get_settings(tl, "timelineResolutionHeight"), 0) or None
        clips = []
        max_end = tl_start
        counts = {}
        for kind in ("video", "audio"):
            n = tl.GetTrackCount(kind) or 0
            counts[kind] = n
            for idx in range(1, n + 1):
                for item in tl.GetItemListInTrack(kind, idx) or []:
                    clip = self._describe_item(item, kind, idx, tl_start, fps)
                    clips.append(clip)
                    max_end = max(max_end, item.GetEnd())
        markers = []
        for frame, info in sorted((tl.GetMarkers() or {}).items(), key=lambda kv: float(kv[0])):
            m = {
                "time": frame_to_sec(float(frame), fps),
                "name": info.get("name", ""),
                "color": RESOLVE_TO_OPENEDIT_COLOR.get(info.get("color"), "blue"),
            }
            dur = _int(info.get("duration"), 0)
            if dur > 1:
                m["duration"] = frame_to_sec(dur, fps)
            if info.get("note"):
                m["comment"] = info.get("note")
            markers.append(m)
        end_frame = max(tl_end, max_end)
        info = {
            "name": tl.GetName(),
            "duration": frame_to_sec(max(0, end_frame - tl_start), fps),
            "fps": round(fps, 6),
            "videoTracks": counts["video"],
            "audioTracks": counts["audio"],
            "clips": clips,
            "markers": markers,
        }
        if width:
            info["width"] = width
        if height:
            info["height"] = height
        return info

    def _describe_item(self, item, kind, track, tl_start, fps):
        mpi = None
        try:
            mpi = item.GetMediaPoolItem()
        except Exception:  # noqa: BLE001
            pass
        props = clip_props(mpi)
        clip = {
            "name": item.GetName() or props.get("Clip Name") or "",
            "track": track,
            "kind": kind,
            "start": frame_to_sec(item.GetStart() - tl_start, fps),
            "end": frame_to_sec(item.GetEnd() - tl_start, fps),
        }
        path = props.get("File Path")
        if path:
            clip["path"] = path
        src_in = src_out = None
        if _has(item, "GetSourceStartTime"):
            try:
                src_in, src_out = item.GetSourceStartTime(), item.GetSourceEndTime()
            except Exception:  # noqa: BLE001
                src_in = src_out = None
        if src_in is None or src_out is None:
            sfps = parse_fps(props.get("FPS"), default=fps)
            try:
                src_in = item.GetSourceStartFrame() / sfps
                src_out = item.GetSourceEndFrame() / sfps
            except Exception:  # noqa: BLE001
                left = item.GetLeftOffset() if _has(item, "GetLeftOffset") else 0
                src_in = left / fps
                src_out = (left + item.GetDuration()) / fps
        clip["sourceIn"] = round(float(src_in), 6)
        clip["sourceOut"] = round(float(src_out), 6)
        return clip

    def cmd_getSourceMedia(self, args):
        tl = self.timeline()
        seen, video, audio = set(), [], []
        for kind, bucket in (("video", video), ("audio", audio)):
            for idx in range(1, (tl.GetTrackCount(kind) or 0) + 1):
                for item in tl.GetItemListInTrack(kind, idx) or []:
                    try:
                        mpi = item.GetMediaPoolItem()
                    except Exception:  # noqa: BLE001
                        mpi = None
                    path = clip_props(mpi).get("File Path")
                    if path and path not in seen:
                        seen.add(path)
                        bucket.append(path)
        return video + audio

    def build_cut_clip_infos(self, mpi, keep, source_fps, max_frames=None):
        """Clip infos for MediaPool.AppendToTimeline from a list of keep ranges."""
        infos = []
        for rng in keep:
            mapped = range_to_source_frames(rng["start"], rng["end"], source_fps, max_frames)
            if mapped is None:
                continue
            sf, ef, count = mapped
            infos.append({"mediaPoolItem": mpi, "startFrame": sf, "endFrame": ef, "_frames": count})
        return infos

    def cmd_applyCutPlan(self, args):
        plan = args.get("plan")
        if not isinstance(plan, dict):
            raise BridgeError("args.plan is required")
        keep = plan.get("keep") or []
        if not keep:
            raise BridgeError("cut plan has no keep ranges")
        project = self.project()
        media_pool = project.GetMediaPool()
        mpi = self.ensure_media_item(media_pool, plan.get("source"))
        props = clip_props(mpi)
        fallback_fps = parse_fps(get_settings(project, "timelineFrameRate"), default=24.0)
        source_fps = parse_fps(props.get("FPS"), default=fallback_fps)
        max_frames = _int(props.get("Frames"), 0) or None
        infos = self.build_cut_clip_infos(mpi, keep, source_fps, max_frames)
        if not infos:
            raise BridgeError("every keep range is shorter than one frame")

        base = args.get("sequenceName") or "OpenEdit - %s" % os.path.splitext(os.path.basename(plan["source"]))[0]
        name, tl = base, None
        existing = set()
        for i in range(1, (project.GetTimelineCount() or 0) + 1):
            t = project.GetTimelineByIndex(i)
            if t is not None:
                existing.add(t.GetName())
        n = 2
        while name in existing:
            name = "%s (%d)" % (base, n)
            n += 1
        tl = media_pool.CreateEmptyTimeline(name)
        if tl is None:
            raise BridgeError("could not create timeline %r" % name)
        project.SetCurrentTimeline(tl)

        append = [{k: v for k, v in info.items() if not k.startswith("_")} for info in infos]
        items = media_pool.AppendToTimeline(append) or []
        if not items:
            raise BridgeError("AppendToTimeline added nothing to %r (source fps %.3f)" % (name, source_fps))
        result = {"sequence": name, "clips": len(infos)}
        # Sanity-check endFrame semantics against what Resolve actually built.
        try:
            video_items = [it for it in items if self._is_video_item(it)] or items
            expected = sum(info["_frames"] for info in infos)
            tl_fps = self.timeline_fps(tl, project)
            built = sum(it.GetDuration() for it in video_items)
            expected_tl = expected * tl_fps / source_fps
            if abs(built - expected_tl) > len(infos) * 0.5 + 0.5:
                result["warning"] = (
                    "built %d timeline frames, expected ~%d; check endFrame semantics "
                    "(OPENEDIT_RESOLVE_END_EXCLUSIVE)" % (built, round(expected_tl)))
        except Exception:  # noqa: BLE001
            pass
        return result

    @staticmethod
    def _is_video_item(item):
        try:
            pos = item.GetPosition() if _has(item, "GetPosition") else None
            if isinstance(pos, dict) and pos.get("trackType"):
                return pos["trackType"] == "video"
        except Exception:  # noqa: BLE001
            pass
        return True

    def cmd_addMarkers(self, args):
        markers = args.get("markers") or []
        project = self.project()
        tl = self.timeline(project)
        fps = self.timeline_fps(tl, project)
        existing = set(int(float(f)) for f in (tl.GetMarkers() or {}).keys())
        added = 0
        for m in markers:
            frame = max(0, sec_to_frame(m.get("time", 0), fps))
            dur = max(1, sec_to_frame(m.get("duration") or 0, fps))
            color = marker_color(m.get("color"))
            name = str(m.get("name") or "Marker")
            note = str(m.get("comment") or "")
            # Resolve allows one marker per frame; nudge forward if taken.
            for attempt in range(0, 5):
                f = frame + attempt
                if f in existing:
                    continue
                if tl.AddMarker(f, color, name, note, dur):
                    existing.add(f)
                    added += 1
                    break
        return added

    def cmd_importMedia(self, args):
        paths = [p for p in (args.get("paths") or []) if p]
        missing = [p for p in paths if not os.path.exists(p)]
        if missing:
            raise BridgeError("file(s) not found: %s" % ", ".join(missing))
        media_pool = self.project().GetMediaPool()
        bin_folder = self.openedit_bin(media_pool)
        in_bin = set(norm_path(clip_props(c).get("File Path")) for c in (bin_folder.GetClipList() or []))
        todo = [os.path.abspath(p) for p in paths if norm_path(p) not in in_bin]
        imported = self.import_into_bin(media_pool, todo)
        return len(imported) + (len(paths) - len(todo))

    def cmd_placeClips(self, args):
        clips = args.get("clips") or []
        project = self.project()
        media_pool = project.GetMediaPool()
        tl = self.timeline(project)
        tl_fps = self.timeline_fps(tl, project)
        tl_start = tl.GetStartFrame()
        placed, errors = 0, []
        for c in clips:
            try:
                mpi = self.ensure_media_item(media_pool, c.get("path"))
                kind = self.media_kind(mpi)
                track = max(1, int(c.get("track") or 1))
                while (tl.GetTrackCount(kind) or 0) < track:
                    ok = tl.AddTrack(kind, "stereo") if kind == "audio" else tl.AddTrack(kind)
                    if not ok:
                        raise BridgeError("could not add %s track %d" % (kind, track))
                props = clip_props(mpi)
                src_fps = parse_fps(props.get("FPS"), default=tl_fps)
                info = {
                    "mediaPoolItem": mpi,
                    "trackIndex": track,
                    "recordFrame": tl_start + sec_to_frame(c.get("at", 0), tl_fps),
                    "mediaType": 1 if kind == "video" else 2,
                }
                if c.get("sourceIn") is not None or c.get("sourceOut") is not None:
                    src_in = float(c.get("sourceIn") or 0)
                    max_frames = _int(props.get("Frames"), 0) or None
                    src_out = c.get("sourceOut")
                    if src_out is None:
                        src_out = (max_frames / src_fps) if max_frames else src_in + 3600.0
                    mapped = range_to_source_frames(src_in, float(src_out), src_fps, max_frames)
                    if mapped is None:
                        raise BridgeError("source range shorter than one frame")
                    info["startFrame"], info["endFrame"] = mapped[0], mapped[1]
                items = media_pool.AppendToTimeline([info]) or []
                if not items:
                    raise BridgeError("Resolve refused the placement (track occupied or unsupported)")
                if c.get("gainDb") is not None and kind == "audio":
                    for it in items:
                        set_item_props(it, {"AudioVolume": float(c["gainDb"])})
                placed += 1
            except BridgeError as exc:
                errors.append("%s: %s" % (c.get("path"), exc))
        if errors:
            log("placeClips errors:", "; ".join(errors))
            if placed == 0:
                raise BridgeError("no clips placed: " + "; ".join(errors))
        return placed

    def cmd_addCaptions(self, args):
        cues = args.get("cues") or []
        srt_path = args.get("srtPath")
        if not srt_path or not os.path.exists(srt_path):
            if not cues:
                raise BridgeError("no captions: srtPath missing and cues empty")
            srt_path = write_srt(cues, os.path.join(tempfile.mkdtemp(prefix="openedit-"), "captions.srt"))
        srt_path = os.path.abspath(srt_path)
        project = self.project()
        media_pool = project.GetMediaPool()
        tl = self.timeline(project)
        count = len(cues) or _count_srt_cues(srt_path)

        # Preferred: import the .srt into the media pool and append it; Resolve
        # places it on a subtitle track with the file's own timings.
        try:
            if (tl.GetTrackCount("subtitle") or 0) < 1:
                tl.AddTrack("subtitle")
            before = len(tl.GetItemListInTrack("subtitle", 1) or [])
            imported = self.import_into_bin(media_pool, [srt_path])
            if imported:
                items = media_pool.AppendToTimeline([{"mediaPoolItem": imported[0],
                                                     "recordFrame": tl.GetStartFrame()}])
                if not items:
                    items = media_pool.AppendToTimeline([imported[0]])
                after = len(tl.GetItemListInTrack("subtitle", 1) or [])
                if items or after > before:
                    return {"added": count, "file": srt_path, "method": "subtitleTrack"}
            log("subtitle import did not add items; falling back to markers")
        except Exception as exc:  # noqa: BLE001
            log("subtitle import failed (%s); falling back to markers" % exc)

        # Fallback: one cream marker per cue carrying the text.
        if not cues:
            cues = _parse_srt(srt_path)
        markers = [{"time": c["start"], "duration": max(0.0, c["end"] - c["start"]),
                    "name": str(c.get("text", ""))[:60], "comment": c.get("text", ""), "color": "white"}
                   for c in cues]
        added = self.cmd_addMarkers({"markers": markers})
        return {"added": added, "file": srt_path, "method": "markers"}

    def cmd_addZooms(self, args):
        """Static punch-ins: Resolve's scripting API cannot create keyframes, so each
        V1 clip that lies entirely inside a zoom range gets ZoomX/ZoomY set to the
        zoom's scale. Clips only partly covered are left untouched."""
        zooms = args.get("zooms") or []
        project = self.project()
        tl = self.timeline(project)
        fps = self.timeline_fps(tl, project)
        tl_start = tl.GetStartFrame()
        items = tl.GetItemListInTrack("video", 1) or []
        applied, touched, partial = 0, 0, 0
        for z in zooms:
            zs = tl_start + sec_to_frame(z["start"], fps)
            ze = tl_start + sec_to_frame(z["end"], fps)
            scale = float(z.get("scale") or 100) / 100.0
            hit = False
            for it in items:
                s, e = it.GetStart(), it.GetEnd()
                if s >= zs and e <= ze:
                    if set_item_props(it, {"ZoomX": scale, "ZoomY": scale}):
                        hit = True
                        touched += 1
                elif s < ze and e > zs:
                    partial += 1
            if hit:
                applied += 1
        log("addZooms: %d zoom(s) applied to %d clip(s); %d partial overlap(s) skipped "
            "(no keyframe API in Resolve scripting)" % (applied, touched, partial))
        return applied

    def cmd_render(self, args):
        output = args.get("output")
        if not output:
            raise BridgeError("args.output is required")
        output = os.path.abspath(os.path.expanduser(output))
        target_dir = os.path.dirname(output)
        base, ext = os.path.splitext(os.path.basename(output))
        ext = (ext or ".mp4").lstrip(".").lower()
        if not os.path.isdir(target_dir):
            os.makedirs(target_dir)
        project = self.project()
        self.timeline(project)  # render the current timeline; fail early if none

        preset = args.get("preset")
        if preset:
            if not project.LoadRenderPreset(preset):
                raise BridgeError("render preset %r not found" % preset)
        else:
            ok = False
            fmt = "mov" if ext == "mov" else "mp4"
            for codec in ("H264", "H264_VTB", "H264_NV", "H265"):
                try:
                    if project.SetCurrentRenderFormatAndCodec(fmt, codec):
                        ok = True
                        break
                except Exception:  # noqa: BLE001
                    pass
            if not ok and not project.LoadRenderPreset("H.264 Master"):
                raise BridgeError("could not select an H.264 render format")
        settings = {"SelectAllFrames": True, "TargetDir": target_dir, "CustomName": base,
                    "ExportVideo": True, "ExportAudio": True}
        if not project.SetRenderSettings(settings):
            raise BridgeError("SetRenderSettings failed for %s" % output)
        job = project.AddRenderJob()
        if not job:
            raise BridgeError("AddRenderJob failed (is the timeline empty?)")
        started = False
        try:
            started = project.StartRendering([job])
        except Exception:  # noqa: BLE001
            started = False
        if not started:
            started = project.StartRendering(job)
        if not started:
            raise BridgeError("StartRendering failed")
        timeout = float(args.get("timeoutSec") or 6 * 3600)
        t0 = time.time()
        while project.IsRenderingInProgress():
            if time.time() - t0 > timeout:
                project.StopRendering()
                raise BridgeError("render timed out after %ds" % timeout)
            time.sleep(1.0)
        status = project.GetRenderJobStatus(job) or {}
        state = str(status.get("JobStatus", ""))
        try:
            project.DeleteRenderJob(job)
        except Exception:  # noqa: BLE001
            pass
        if state and state != "Complete":
            raise BridgeError("render %s: %s" % (state.lower(), status.get("Error", "")))
        actual = output
        if not os.path.exists(actual):
            found = sorted(glob.glob(os.path.join(target_dir, glob.escape(base) + ".*")),
                           key=os.path.getmtime, reverse=True)
            if found:
                actual = found[0]
            else:
                raise BridgeError("render finished but no output found at %s" % output)
        return {"output": actual}


def _parse_srt(path):
    cues = []
    with open(path, "r", encoding="utf-8-sig") as fh:
        blocks = fh.read().replace("\r\n", "\n").strip().split("\n\n")
    for block in blocks:
        lines = [l for l in block.split("\n") if l.strip()]
        for i, line in enumerate(lines):
            if "-->" in line:
                a, b = [x.strip() for x in line.split("-->")[:2]]
                cues.append({"start": _srt_sec(a), "end": _srt_sec(b.split()[0]),
                             "text": " ".join(lines[i + 1:])})
                break
    return cues


def _srt_sec(ts):
    hms, _, ms = ts.replace(".", ",").partition(",")
    h, m, s = [int(x) for x in hms.split(":")]
    return h * 3600 + m * 60 + s + (int(ms or 0) / 1000.0)


def _count_srt_cues(path):
    try:
        return len(_parse_srt(path))
    except Exception:  # noqa: BLE001
        return 0


COMMANDS = {
    "ping": ResolveBridge.cmd_ping,
    "status": ResolveBridge.cmd_status,
    "getTimeline": ResolveBridge.cmd_getTimeline,
    "getSourceMedia": ResolveBridge.cmd_getSourceMedia,
    "applyCutPlan": ResolveBridge.cmd_applyCutPlan,
    "addMarkers": ResolveBridge.cmd_addMarkers,
    "importMedia": ResolveBridge.cmd_importMedia,
    "placeClips": ResolveBridge.cmd_placeClips,
    "addCaptions": ResolveBridge.cmd_addCaptions,
    "addZooms": ResolveBridge.cmd_addZooms,
    "render": ResolveBridge.cmd_render,
}


# --------------------------------------------------------------------------
# Process entry points
# --------------------------------------------------------------------------

def _protect_stdout():
    """Route fd 1 to stderr so stray prints (ours or fusionscript's C code) can't
    corrupt the protocol; return a text stream on the original stdout."""
    try:
        sys.stdout.flush()
        out_fd = os.dup(1)
        os.dup2(2, 1)
        out = os.fdopen(out_fd, "w", encoding="utf-8", newline="\n")
    except Exception:  # noqa: BLE001
        out = sys.stdout
    sys.stdout = sys.stderr
    return out


def _emit(out, response):
    out.write(json.dumps(response, ensure_ascii=False, default=str) + "\n")
    out.flush()


def _parse_line(line):
    try:
        return json.loads(line), None
    except ValueError as exc:
        return None, {"id": None, "ok": False, "error": "invalid JSON request: %s" % exc}


def _needs_relay(bridge, request):
    """True when fusionscript can't load here but another interpreter might."""
    if os.environ.get("OPENEDIT_RESOLVE_CHILD") or os.environ.get("OPENEDIT_RESOLVE_FAKE"):
        return None
    if not isinstance(request, dict) or request.get("cmd") == "ping":
        return None
    try:
        load_script_module()
        return None
    except BridgeError as exc:
        if "could not be loaded into this Python" not in str(exc):
            return None
    for py in candidate_pythons():
        if os.path.realpath(py) != os.path.realpath(sys.executable) and os.path.exists(py):
            return py
    return None


def _relay(python, line):
    env = dict(os.environ, OPENEDIT_RESOLVE_CHILD="1")
    log("relaying to compatible interpreter", python)
    proc = subprocess.run([python, os.path.abspath(__file__)], input=line.strip() + "\n",
                          stdout=subprocess.PIPE, stderr=None, universal_newlines=True, env=env)
    for out_line in proc.stdout.splitlines():
        if out_line.strip():
            return json.loads(out_line)
    raise BridgeError("relay interpreter %s returned no response (exit %s)" % (python, proc.returncode))


def handle_line(bridge, line):
    request, error = _parse_line(line)
    if error:
        return error
    py = _needs_relay(bridge, request)
    if py:
        try:
            return _relay(py, line)
        except Exception as exc:  # noqa: BLE001
            return {"id": request.get("id"), "ok": False, "error": str(exc)}
    return bridge.handle(request)


def serve(bridge, out):
    for line in sys.stdin:
        if not line.strip():
            continue
        _emit(out, handle_line(bridge, line))


def doctor():
    api, lib = script_paths()
    print("OpenEdit Resolve bridge %s" % BRIDGE_VERSION)
    print("python        : %s (%s, %s)" % (sys.executable, sys.version.split()[0], _arch()))
    print("scripting API : %s [%s]" % (api, "found" if os.path.isdir(api) else "MISSING"))
    print("fusionscript  : %s [%s]" % (lib, "found" if os.path.isfile(lib) else "MISSING"))
    print("ResolvePython : %s [%s]" % (default_paths()[2], "found" if os.path.isfile(default_paths()[2]) else "not found"))
    print("candidates    : %s" % (", ".join(candidate_pythons()) or "(none)"))
    code = 0
    try:
        load_script_module()
        print("load          : OK")
    except BridgeError as exc:
        print("load          : FAILED - %s" % exc)
        return 2
    status = ResolveBridge().cmd_status({})
    print("connection    : %s" % ("OK" if status.get("connected") else "NOT CONNECTED"))
    for k in ("version", "project", "sequence", "detail"):
        if status.get(k):
            print("  %-12s: %s" % (k, status[k]))
    if not status.get("connected"):
        code = 3
    return code


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--doctor" in argv:
        return doctor()
    out = _protect_stdout()
    bridge = ResolveBridge()
    if "--serve" in argv:
        serve(bridge, out)
        return 0
    if "--cmd" in argv:
        i = argv.index("--cmd")
        cmd = argv[i + 1] if i + 1 < len(argv) else ""
        args = {}
        if "--args" in argv:
            j = argv.index("--args")
            args = json.loads(argv[j + 1]) if j + 1 < len(argv) else {}
        line = json.dumps({"id": "cli", "cmd": cmd, "args": args})
    else:
        line = sys.stdin.readline()
        if not line.strip():
            _emit(out, {"id": None, "ok": False, "error": "empty request"})
            return 1
    _emit(out, handle_line(bridge, line))
    return 0


if __name__ == "__main__":
    sys.exit(main())
