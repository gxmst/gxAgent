import { describe, expect, it } from "vitest";
import { compareSidebarSessions, moveSessionInSidebar, type SidebarOrderableSession } from "./sessionOrder";

const session = (
  id: string,
  sidebarOrder: number,
  options: Partial<Pick<SidebarOrderableSession, "pinned" | "archived" | "sessionConfig">> = {},
): SidebarOrderableSession => ({
  id,
  sidebarOrder,
  pinned: options.pinned,
  archived: options.archived,
  sessionConfig: options.sessionConfig || { mode: "chat" },
});

describe("sidebar session ordering", () => {
  it("keeps explicit order and only groups pinned sessions first", () => {
    const sessions = [
      session("older", -10),
      session("pinned", 50, { pinned: true }),
      session("newer", -30),
    ];

    expect([...sessions].sort(compareSidebarSessions).map((item) => item.id))
      .toEqual(["pinned", "newer", "older"]);
  });

  it("moves only within the same mode and pinned group", () => {
    const sessions = [
      session("first", -30),
      session("second", -20),
      session("pinned", -10, { pinned: true }),
      session("code", -40, { sessionConfig: { mode: "code" } }),
    ];
    const moved = moveSessionInSidebar(sessions, "second", "up");

    expect([...moved].filter((item) => item.sessionConfig.mode === "chat" && !item.pinned)
      .sort(compareSidebarSessions).map((item) => item.id))
      .toEqual(["second", "first"]);
    expect(moved.find((item) => item.id === "pinned")?.sidebarOrder).toBe(-10);
    expect(moved.find((item) => item.id === "code")?.sidebarOrder).toBe(-40);
  });

  it("leaves the collection unchanged at a group boundary", () => {
    const sessions = [session("first", -30), session("second", -20)];
    expect(moveSessionInSidebar(sessions, "first", "up")).toBe(sessions);
  });

  it("sorts archived sessions after everything, even pinned+archived", () => {
    const sessions = [
      session("archived", -50, { archived: true }),
      session("plain", -20),
      session("pinned-archived", -40, { pinned: true, archived: true }),
      session("pinned", -10, { pinned: true }),
    ];

    expect([...sessions].sort(compareSidebarSessions).map((item) => item.id))
      .toEqual(["pinned", "plain", "pinned-archived", "archived"]);
  });

  it("keeps pinned order stable among pinned sessions", () => {
    const sessions = [
      session("pin-late", -10, { pinned: true }),
      session("pin-early", -30, { pinned: true }),
      session("plain", -40),
    ];

    expect([...sessions].sort(compareSidebarSessions).map((item) => item.id))
      .toEqual(["pin-early", "pin-late", "plain"]);
  });

  it("does not move sessions across the archived boundary", () => {
    const sessions = [
      session("first", -30),
      session("archived", -25, { archived: true }),
      session("second", -20),
    ];
    const moved = moveSessionInSidebar(sessions, "second", "up");

    expect(moved.find((item) => item.id === "archived")?.sidebarOrder).toBe(-25);
    expect([...moved].filter((item) => !item.archived)
      .sort(compareSidebarSessions).map((item) => item.id))
      .toEqual(["second", "first"]);
  });
});
