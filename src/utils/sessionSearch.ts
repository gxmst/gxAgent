/**
 * Sidebar full-text session search: case-insensitive substring matching over
 * a session's title and ALL of its messages, plus snippet extraction for the
 * result rows.
 *
 * Sessions are replaced immutably whenever they change, so a WeakMap keyed by
 * session object identity gives a lazy lowercase index that invalidates
 * itself naturally — no re-index on keystrokes, no manual cache eviction.
 */

export interface SearchableMessage {
  role: string;
  content: string;
  variants?: string[];
  currentVariantIndex?: number;
}

export interface SearchableSession {
  id: string;
  title: string;
  messages: SearchableMessage[];
}

/** Snippet parts around the first hit; render as before<mark>hit</mark>after.
 *  `hit` preserves the original casing from the message. */
export interface SearchSnippet {
  before: string;
  hit: string;
  after: string;
}

export interface SessionSearchMatch<T extends SearchableSession> {
  session: T;
  /** null when the title alone matched — no snippet needed. */
  snippet: SearchSnippet | null;
}

/** The text a message contributes to search: the active variant when variants
 *  exist, mirroring what the chat view and exports show. */
export const messageSearchText = (message: SearchableMessage) => (
  message.role === "context_divider"
    ? ""
    : message.variants
      ? (message.variants[message.currentVariantIndex || 0] || message.content)
      : message.content
);

const indexCache = new WeakMap<SearchableSession, string>();

/** Lazy lowercase blob of title + every message, cached by object identity. */
export const sessionSearchIndex = (session: SearchableSession): string => {
  const cached = indexCache.get(session);
  if (cached !== undefined) return cached;
  const blob = [session.title || "", ...session.messages.map(messageSearchText)]
    .join("\n")
    .toLowerCase();
  indexCache.set(session, blob);
  return blob;
};

const SNIPPET_BEFORE = 24;
const SNIPPET_TOTAL = 60;

const collapseWhitespace = (text: string) => text.replace(/\s+/g, " ");

/** ~60 chars of context around the first hit in `content`, or null when the
 *  query does not occur. Ellipses are baked into before/after. */
export const extractSnippet = (content: string, queryLower: string): SearchSnippet | null => {
  if (!queryLower) return null;
  const hitIndex = content.toLowerCase().indexOf(queryLower);
  if (hitIndex < 0) return null;
  const start = Math.max(0, hitIndex - SNIPPET_BEFORE);
  const end = Math.min(
    content.length,
    hitIndex + queryLower.length + Math.max(SNIPPET_TOTAL - queryLower.length - (hitIndex - start), 12),
  );
  const before = (start > 0 ? "…" : "") + collapseWhitespace(content.slice(start, hitIndex));
  const hit = collapseWhitespace(content.slice(hitIndex, hitIndex + queryLower.length));
  const after = collapseWhitespace(content.slice(hitIndex + queryLower.length, end)) + (end < content.length ? "…" : "");
  return { before, hit, after };
};

/** All sessions matching `query` (case-insensitive substring across title and
 *  every message), each with a snippet from the first matching message.
 *  Archived sessions are NOT excluded — the caller decides how to render
 *  them. Returns all sessions (no snippets) when the query is blank. */
export function searchSessions<T extends SearchableSession>(
  sessions: T[],
  query: string,
): SessionSearchMatch<T>[] {
  const queryLower = query.trim().toLowerCase();
  if (!queryLower) return sessions.map((session) => ({ session, snippet: null }));

  const matches: SessionSearchMatch<T>[] = [];
  for (const session of sessions) {
    if (!sessionSearchIndex(session).includes(queryLower)) continue;
    if ((session.title || "").toLowerCase().includes(queryLower)) {
      matches.push({ session, snippet: null });
      continue;
    }
    let snippet: SearchSnippet | null = null;
    for (const message of session.messages) {
      snippet = extractSnippet(messageSearchText(message), queryLower);
      if (snippet) break;
    }
    matches.push({ session, snippet });
  }
  return matches;
}
