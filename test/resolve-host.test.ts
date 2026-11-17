import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ResolveHost } from "../src/hosts/resolve.js";
import type { TimelineInfo } from "../src/hosts/types.js";

const hasPython = spawnSync("python3", ["--version"]).status === 0;

describe.skipIf(!hasPython)("Resolve host (fake Resolve)", () => {
  const saved = { ...process.env };
  beforeAll(() => {
    process.env.OPENEDIT_RESOLVE_FAKE = "1";
    delete process.env.OPENEDIT_RESOLVE_ONESHOT;
  });
  afterAll(() => {
    process.env = saved;
  });

  it("keeps one persistent --serve process and matches responses by id", async () => {
    const host = new ResolveHost();
    try {
      const [a, b, c] = await Promise.all([host.status(), host.rpc<string>("ping"), host.getTimeline()]);
      expect(a.connected).toBe(true);
      expect(b).toBe("pong");
      expect(c.name).toBe("Main");
      // State lives in the long-lived process: a marker added now is still there on the next call.
      expect(await host.addMarkers([{ time: 2, name: "Persisted" }])).toBe(1);
      const tl = await host.getTimeline();
      expect(tl.markers.map((m) => m.name)).toContain("Persisted");
    } finally {
      host.close();
    }
  });

  it("falls back to one process per command", async () => {
    process.env.OPENEDIT_RESOLVE_ONESHOT = "1";
    const host = new ResolveHost();
    try {
      await host.addMarkers([{ time: 2, name: "Gone" }]);
      const tl = await host.rpc<TimelineInfo>("getTimeline");
      expect(tl.markers.map((m) => m.name)).not.toContain("Gone");
    } finally {
      delete process.env.OPENEDIT_RESOLVE_ONESHOT;
      host.close();
    }
  });
});
