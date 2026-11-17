"""A small in-memory stand-in for DaVinci Resolve's scripting API.

Only models what openedit_bridge.py uses. Semantics mirror Resolve where known:
AppendToTimeline endFrame is INCLUSIVE, timeline markers are keyed by frame
offset from the timeline start, timeline items report absolute frames.
"""

import os


class FakeMediaPoolItem(object):
    def __init__(self, path, fps=25.0, frames=25 * 600, kind="Video + Audio"):
        self.path = path
        self.props = {
            "File Path": path,
            "Clip Name": os.path.basename(path),
            "FPS": fps,
            "Frames": str(frames),
            "Type": kind,
        }

    def GetClipProperty(self, key=None):
        if key is None:
            return dict(self.props)
        return self.props.get(key, "")

    def GetName(self):
        return self.props["Clip Name"]


class FakeFolder(object):
    def __init__(self, name):
        self.name = name
        self.clips = []
        self.subfolders = []

    def GetName(self):
        return self.name

    def GetClipList(self):
        return list(self.clips)

    def GetSubFolderList(self):
        return list(self.subfolders)


class FakeTimelineItem(object):
    def __init__(self, mpi, start, duration, src_start, src_end, track_type, track_index, src_fps):
        self.mpi = mpi
        self.start = start
        self.duration = duration
        self.src_start = src_start
        self.src_end = src_end
        self.track_type = track_type
        self.track_index = track_index
        self.src_fps = src_fps
        self.properties = {"ZoomX": 1.0, "ZoomY": 1.0, "AudioVolume": 0.0}

    def GetName(self):
        return self.mpi.GetName() if self.mpi else "Item"

    def GetStart(self, subframe=False):
        return self.start

    def GetEnd(self, subframe=False):
        return self.start + self.duration

    def GetDuration(self, subframe=False):
        return self.duration

    def GetSourceStartFrame(self):
        return self.src_start

    def GetSourceEndFrame(self):
        return self.src_end

    def GetSourceStartTime(self):
        return self.src_start / self.src_fps

    def GetSourceEndTime(self):
        return self.src_end / self.src_fps

    def GetLeftOffset(self, subframe=False):
        return self.src_start

    def GetMediaPoolItem(self):
        return self.mpi

    def GetPosition(self, subframe=False):
        return {"trackType": self.track_type, "trackIndex": self.track_index, "startFrame": self.start}

    def SetProperties(self, props):
        self.properties.update(props)
        return True

    def GetProperties(self):
        return dict(self.properties)


class FakeTimeline(object):
    def __init__(self, name, fps=25.0, start_frame=90000, width=1920, height=1080):
        self.name = name
        self.fps = fps
        self.start_frame = start_frame
        self.settings = {
            "timelineFrameRate": fps,
            "timelineResolutionWidth": str(width),
            "timelineResolutionHeight": str(height),
        }
        self.tracks = {"video": [[]], "audio": [[]], "subtitle": []}
        self.markers = {}

    def GetName(self):
        return self.name

    def GetSettings(self):
        return dict(self.settings)

    def GetStartFrame(self):
        return self.start_frame

    def GetEndFrame(self):
        end = self.start_frame
        for kind in ("video", "audio"):
            for track in self.tracks[kind]:
                for it in track:
                    end = max(end, it.GetEnd())
        return end

    def GetTrackCount(self, kind):
        return len(self.tracks.get(kind, []))

    def GetItemListInTrack(self, kind, index):
        tracks = self.tracks.get(kind, [])
        if 1 <= index <= len(tracks):
            return sorted(tracks[index - 1], key=lambda it: it.start)
        return None

    def AddTrack(self, kind, sub=None):
        self.tracks.setdefault(kind, []).append([])
        return True

    def AddMarker(self, frame, color, name, note, duration, custom=None):
        if frame in self.markers:
            return False
        self.markers[frame] = {"color": color, "name": name, "note": note, "duration": duration}
        return True

    def GetMarkers(self):
        return dict(self.markers)

    def track_end(self, kind, index):
        track = self.tracks[kind][index - 1]
        return max([self.start_frame] + [it.GetEnd() for it in track])


class FakeMediaPool(object):
    def __init__(self, project):
        self.project = project
        self.root = FakeFolder("Master")
        self.current = self.root
        self.append_calls = []
        self.default_media_fps = 25.0

    def GetRootFolder(self):
        return self.root

    def GetCurrentFolder(self):
        return self.current

    def SetCurrentFolder(self, folder):
        self.current = folder
        return True

    def AddSubFolder(self, parent, name):
        folder = FakeFolder(name)
        parent.subfolders.append(folder)
        return folder

    def ImportMedia(self, items):
        out = []
        for it in items:
            path = it["FilePath"] if isinstance(it, dict) else it
            if not os.path.exists(path):
                continue
            ext = os.path.splitext(path)[1].lower()
            kind = {".srt": "Subtitle", ".wav": "Audio", ".mp3": "Audio", ".png": "Still"}.get(ext, "Video + Audio")
            mpi = FakeMediaPoolItem(os.path.abspath(path), fps=self.default_media_fps, kind=kind)
            self.current.clips.append(mpi)
            out.append(mpi)
        return out

    def CreateEmptyTimeline(self, name):
        if any(t.name == name for t in self.project.timelines):
            return None
        tl = FakeTimeline(name, fps=self.project.fps, start_frame=86400 if self.project.fps == 24 else 90000)
        self.project.timelines.append(tl)
        return tl

    def AppendToTimeline(self, infos):
        tl = self.project.current
        if tl is None:
            return []
        self.append_calls.append(infos)
        created = []
        for info in infos:
            if not isinstance(info, dict):
                info = {"mediaPoolItem": info}
            mpi = info["mediaPoolItem"]
            kind = mpi.props["Type"]
            src_fps = float(mpi.props["FPS"])
            sf = int(info.get("startFrame", 0))
            ef = int(info.get("endFrame", int(mpi.props["Frames"]) - 1))  # inclusive
            frames = ef - sf + 1
            if frames < 1:
                return []
            tl_frames = int(round(frames * tl.fps / src_fps))
            if kind == "Subtitle":
                if not tl.tracks["subtitle"]:
                    return []
                rec = int(info.get("recordFrame", tl.start_frame))
                item = FakeTimelineItem(mpi, rec, 100, 0, 100, "subtitle", 1, src_fps)
                tl.tracks["subtitle"][0].append(item)
                created.append(item)
                continue
            media_type = info.get("mediaType")
            track = int(info.get("trackIndex", 1))
            kinds = []
            if media_type in (None, 1) and kind != "Audio":
                kinds.append("video")
            if media_type in (None, 2) and kind in ("Audio", "Video + Audio"):
                kinds.append("audio")
            for k in kinds:
                if track > len(tl.tracks[k]):
                    return []
                rec = int(info["recordFrame"]) if "recordFrame" in info else tl.track_end(k, track)
                item = FakeTimelineItem(mpi, rec, tl_frames, sf, ef + 1, k, track, src_fps)
                tl.tracks[k][track - 1].append(item)
                created.append(item)
        return created


class FakeProject(object):
    def __init__(self, name="Demo", fps=25.0):
        self.name = name
        self.fps = fps
        self.timelines = []
        self.current = None
        self.media_pool = FakeMediaPool(self)
        self.render_settings = {}
        self.render_format = None
        self.jobs = {}
        self.presets = {"H.264 Master"}

    def GetName(self):
        return self.name

    def GetSettings(self):
        return {"timelineFrameRate": self.fps}

    def GetMediaPool(self):
        return self.media_pool

    def GetCurrentTimeline(self):
        return self.current

    def SetCurrentTimeline(self, tl):
        self.current = tl
        return True

    def GetTimelineCount(self):
        return len(self.timelines)

    def GetTimelineByIndex(self, i):
        return self.timelines[i - 1]

    def LoadRenderPreset(self, name):
        return name in self.presets

    def SetCurrentRenderFormatAndCodec(self, fmt, codec):
        if codec == "H264":
            self.render_format = (fmt, codec)
            return True
        return False

    def SetRenderSettings(self, settings):
        self.render_settings.update(settings)
        return True

    def AddRenderJob(self):
        job = "job-%d" % (len(self.jobs) + 1)
        self.jobs[job] = dict(self.render_settings)
        return job

    def StartRendering(self, jobs, interactive=False):
        for job in jobs:
            s = self.jobs[job]
            ext = (self.render_format or ("mp4",))[0]
            with open(os.path.join(s["TargetDir"], s["CustomName"] + "." + ext), "wb") as fh:
                fh.write(b"fake")
        return True

    def IsRenderingInProgress(self):
        return False

    def GetRenderJobStatus(self, job):
        return {"JobStatus": "Complete", "CompletionPercentage": 100}

    def DeleteRenderJob(self, job):
        self.jobs.pop(job, None)
        return True

    def StopRendering(self):
        return True


class FakeProjectManager(object):
    def __init__(self, project):
        self.project = project

    def GetCurrentProject(self):
        return self.project


class FakeResolve(object):
    def __init__(self, project=None):
        self.project = project or FakeProject()
        self.pm = FakeProjectManager(self.project)

    def GetProjectManager(self):
        return self.pm

    def GetProductName(self):
        return "DaVinci Resolve (fake)"

    def GetVersionString(self):
        return "0.0.0"

    @classmethod
    def from_env(cls):
        """Seeded instance used by `OPENEDIT_RESOLVE_FAKE=1`: a 25fps timeline
        'Main' starting at 01:00:00:00 with one 10s clip on V1/A1 and a marker."""
        r = cls()
        p = r.project
        mpi = FakeMediaPoolItem("/media/interview.mov", fps=25.0, frames=25 * 60)
        p.media_pool.root.clips.append(mpi)
        tl = FakeTimeline("Main", fps=25.0, start_frame=90000)
        p.timelines.append(tl)
        p.current = tl
        tl.tracks["video"][0].append(FakeTimelineItem(mpi, 90000, 250, 50, 300, "video", 1, 25.0))
        tl.tracks["audio"][0].append(FakeTimelineItem(mpi, 90000, 250, 50, 300, "audio", 1, 25.0))
        tl.markers[125] = {"color": "Red", "name": "Intro", "note": "hello", "duration": 1}
        return r
