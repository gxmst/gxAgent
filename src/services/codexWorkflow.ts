import type { Message } from "../types";
import { activeHistoryGroups } from "../utils/messageHistory";
import { useAppStore } from "../store/appStore";

export async function codexHistoryKey(messages: Message[]): Promise<string> {
  const history = activeHistoryGroups(messages).flatMap(group => group.serialized);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(history)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function rememberCodexHistory(sessionId: string, historyComplete: boolean) {
  const snapshot = useAppStore.getState().sessions.find(session => session.id === sessionId);
  if (!snapshot?.codexThread) return;
  // Retrying an earlier answer leaves later visible turns outside this thread.
  if (!historyComplete) {
    useAppStore.getState().setSessions(sessions => sessions.map(session => session.id === sessionId
      ? { ...session, codexThread: undefined }
      : session));
    return;
  }
  const threadId = snapshot.codexThread.id;
  void codexHistoryKey(snapshot.messages).then(historyKey => {
    useAppStore.getState().setSessions(sessions => sessions.map(session => session.id === sessionId
      && session.codexThread?.id === threadId && session.messages === snapshot.messages
      ? { ...session, codexThread: { ...session.codexThread, historyKey } }
      : session));
  }).catch(() => { /* A missing fingerprint starts a fresh thread with visible history. */ });
}
