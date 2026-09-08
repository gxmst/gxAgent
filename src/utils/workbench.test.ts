// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createSession, normalizeMessage } from "../appDefaults";
import { groupProjectSessions, taskState } from "./workbench";
import { useWorkspaceViewStore } from "../store/workspaceViewStore";

describe("project navigation", () => {
  it("groups equivalent Windows directories and preserves distinct project roots", () => {
    const first = createSession("code");
    first.sessionConfig.workDir = "C:\\Projects\\App\\";
    const second = createSession("code");
    second.sessionConfig.workDir = "c:/projects/app";
    const inherited = createSession("code");
    const groups = groupProjectSessions([first, second, inherited], "/projects/other");
    expect(groups).toHaveLength(2);
    expect(groups[0].sessions).toEqual([first, second]);
    expect(groups[1].workDir).toBe("/projects/other");
  });

  it("does not merge case-sensitive Unix directories", () => {
    const first = createSession("code"); first.sessionConfig.workDir = "/repo/App";
    const second = createSession("code"); second.sessionConfig.workDir = "/repo/app";
    expect(groupProjectSessions([first, second], "")).toHaveLength(2);
  });
});

describe("run state", () => {
  it("recovers a saved unfinished run as interrupted", () => {
    const message = normalizeMessage({ role: "assistant", content: "partial", run: { requestId: "request", status: "running", startedAt: 100 } });
    expect(message?.run?.status).toBe("interrupted");
    const session = createSession("code", "task", [message!]);
    expect(taskState(session)).toBe("interrupted");
    expect(taskState(session, { requestId: "request", status: "running" }, {})).toBe("approval");
    expect(taskState(session, { requestId: "request", status: "stopping" }, {})).toBe("stopping");
  });

  it("retains completed run identity and ignores malformed run metadata", () => {
    expect(normalizeMessage({ role: "assistant", content: "done", run: { requestId: "request", status: "completed", startedAt: 100, finishedAt: 200 } })?.run).toEqual({ requestId: "request", status: "completed", startedAt: 100, finishedAt: 200 });
    expect(normalizeMessage({ role: "assistant", run: { requestId: 12, status: "completed", startedAt: 100 } })?.run).toBeUndefined();
  });
});

it("keeps file reads and selected tabs isolated when tasks switch", () => {
  const view = useWorkspaceViewStore.getState();
  view.clear();
  view.setFile("first", { workDir: "/first", path: "/first/a.ts", loading: true });
  view.setFile("second", { workDir: "/second", path: "/second/b.ts", content: "second" });
  view.setTab("first", "files");
  view.setTab("second", "changes");
  view.setFile("first", { content: "late first response", loading: false });
  expect(useWorkspaceViewStore.getState().files.second.content).toBe("second");
  expect(useWorkspaceViewStore.getState().tabs.first).toBe("files");
  view.clear("first");
  expect(useWorkspaceViewStore.getState().files.first).toBeUndefined();
  expect(useWorkspaceViewStore.getState().files.second.path).toBe("/second/b.ts");
});
