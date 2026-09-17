import { describe, expect, it } from "vitest";
import { SessionManager, electronPartition, partitionPath } from "../src/main/sessions.js";
import { CaptureSupervisor } from "../src/main/supervisor.js";
import { allowNewWindow, arenaWebPreferences, isLoopbackUrl } from "../src/main/guards.js";
import { safeLeafName } from "../src/main/downloads.js";
import { planStartup } from "../src/main/main.js";

const A = "01933b40-9c2a-7b1e-9c9b-2b6d6a2e8a0a";
const B = "01933b40-9c2a-7b1e-9c9b-2b6d6a2e8a0b";

describe("SessionManager", () => {
  it("derives partition paths from UUIDs only", () => {
    expect(partitionPath("/ud", A)).toBe(`/ud/partitions/${A}`);
    expect(() => partitionPath("/ud", "owner@example.com")).toThrow();
    expect(() => partitionPath("/ud", "../escape")).toThrow();
    expect(electronPartition(A)).toBe(`persist:arena-${A}`);
  });

  it("tracks epochs per account independently", () => {
    const m = new SessionManager("/ud");
    m.register(A);
    m.register(B);
    m.beginEpoch(A, "e1");
    expect(m.get(A)?.epochId).toBe("e1");
    expect(m.get(B)?.epochId).toBeNull();
    m.endEpoch(A); // sign out A...
    expect(m.get(A)?.epochId).toBeNull();
    m.beginEpoch(B, "e9"); // ...B unaffected
    expect(m.get(B)?.epochId).toBe("e9");
  });
});

describe("CaptureSupervisor", () => {
  it("stamps account identity before queueing; drops unbound", () => {
    const s = new CaptureSupervisor({ accountId: A, epochId: "e1" });
    s.bindSession("sess-1");
    expect(s.ingest({ method: "Network.requestWillBeSent", cdpSessionId: "sess-1" }).gap).toBe(false);
    expect(s.ingest({ method: "Network.requestWillBeSent", cdpSessionId: "nope" }).gap).toBe(false);
    const drained = s.drain();
    expect(drained.length).toBe(1);
    expect(drained[0]?.accountId).toBe(A);
    expect(s.stats().droppedUnbound).toBe(1);
  });
});

describe("guards", () => {
  it("blocks loopback from Arena sessions", () => {
    expect(isLoopbackUrl("http://127.0.0.1:9999/x")).toBe(true);
    expect(isLoopbackUrl("https://arena.ai/")).toBe(false);
    expect(allowNewWindow("https://arena.ai/auth")).toBe(true);
    expect(allowNewWindow("http://127.0.0.1/")).toBe(false);
    expect(allowNewWindow("file:///etc/passwd")).toBe(false);
  });

  it("arena views are fully sandboxed with no preload", () => {
    const prefs = arenaWebPreferences("persist:arena-x");
    expect(prefs).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      devTools: false,
    });
    expect(prefs["preload"]).toBeUndefined();
  });
});

describe("downloads", () => {
  it("neutralizes traversal filenames", () => {
    expect(safeLeafName("../../etc/passwd")).toBe("passwd");
    expect(safeLeafName("")).toBe("download");
  });
});

describe("planStartup", () => {
  it("wires one supervisor per account", () => {
    const { sessions, supervisors } = planStartup([A, B], {
      userDataPath: "/ud",
      diagnosticsPreload: "/p",
      diagnosticsHtml: "/h",
    });
    expect(sessions.list().length).toBe(2);
    expect(supervisors.size).toBe(2);
  });
});
