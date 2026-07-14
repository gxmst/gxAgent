export interface SidebarOrderableSession {
  id: string;
  pinned?: boolean;
  sidebarOrder: number;
  sessionConfig: { mode: "chat" | "code" };
}

export function compareSidebarSessions(
  left: SidebarOrderableSession,
  right: SidebarOrderableSession,
) {
  return Number(Boolean(right.pinned)) - Number(Boolean(left.pinned))
    || left.sidebarOrder - right.sidebarOrder;
}

export function moveSessionInSidebar<T extends SidebarOrderableSession>(
  sessions: T[],
  sessionId: string,
  direction: "up" | "down",
): T[] {
  const target = sessions.find((session) => session.id === sessionId);
  if (!target) return sessions;

  const peers = sessions
    .filter((session) => (
      session.sessionConfig.mode === target.sessionConfig.mode
      && Boolean(session.pinned) === Boolean(target.pinned)
    ))
    .sort((left, right) => left.sidebarOrder - right.sidebarOrder);
  const currentIndex = peers.findIndex((session) => session.id === sessionId);
  const neighbor = peers[currentIndex + (direction === "up" ? -1 : 1)];
  if (!neighbor) return sessions;

  const earlierOrder = Math.min(target.sidebarOrder, neighbor.sidebarOrder);
  const laterOrder = Math.max(target.sidebarOrder, neighbor.sidebarOrder);
  const targetOrder = direction === "up"
    ? (earlierOrder === laterOrder ? earlierOrder - 1 : earlierOrder)
    : (earlierOrder === laterOrder ? laterOrder + 1 : laterOrder);
  const neighborOrder = direction === "up" ? laterOrder : earlierOrder;

  return sessions.map((session) => {
    if (session.id === target.id) return { ...session, sidebarOrder: targetOrder };
    if (session.id === neighbor.id) return { ...session, sidebarOrder: neighborOrder };
    return session;
  });
}
