import { describe, expect, it } from "vitest";
import {
  extractSnippet,
  searchSessions,
  sessionSearchIndex,
  type SearchableSession,
} from "./sessionSearch";

type TestSession = SearchableSession & { archived?: boolean };

const session = (
  id: string,
  title: string,
  contents: string[],
  archived = false,
): TestSession => ({
  id,
  title,
  archived,
  messages: contents.map((content) => ({ role: "user", content })),
});

describe("searchSessions", () => {
  it("matches case-insensitively across ALL messages, not just recent ones", () => {
    const old = Array.from({ length: 30 }, (_, i) => `filler message ${i}`);
    const target = session("s1", "untitled", ["The NEEDLE is here", ...old]);
    const other = session("s2", "untitled", ["nothing to see"]);

    const results = searchSessions([target, other], "needle");
    expect(results.map((r) => r.session.id)).toEqual(["s1"]);
  });

  it("returns every session with no snippet when the query is blank", () => {
    const sessions = [session("a", "one", []), session("b", "two", [])];
    const results = searchSessions(sessions, "   ");
    expect(results.map((r) => r.session.id)).toEqual(["a", "b"]);
    expect(results.every((r) => r.snippet === null)).toBe(true);
  });

  it("matches on title alone without producing a snippet", () => {
    const results = searchSessions([session("a", "Rust build errors", ["unrelated"])], "rust");
    expect(results).toHaveLength(1);
    expect(results[0].snippet).toBeNull();
  });

  it("produces a snippet from the first matching message", () => {
    const s = session("a", "untitled", [
      "no hit in this one",
      "prefix text before the magicword and some trailing context that keeps going",
    ]);
    const [result] = searchSessions([s], "MagicWord");
    expect(result.snippet).not.toBeNull();
    expect(result.snippet!.hit).toBe("magicword");
    expect(result.snippet!.before.endsWith("before the ")).toBe(true);
    expect(result.snippet!.after.startsWith(" and some trailing")).toBe(true);
  });

  it("searches the active variant when a message has variants", () => {
    const s: TestSession = {
      id: "v",
      title: "untitled",
      messages: [{
        role: "assistant",
        content: "original text",
        variants: ["original text", "regenerated with keyword inside"],
        currentVariantIndex: 1,
      }],
    };
    expect(searchSessions([s], "keyword")).toHaveLength(1);
    expect(searchSessions([s], "original")).toHaveLength(0);
  });

  it("includes archived sessions in the results", () => {
    const archived = session("arch", "untitled", ["archived content here"], true);
    const results = searchSessions([archived], "archived content");
    expect(results).toHaveLength(1);
    expect(results[0].session.archived).toBe(true);
  });
});

describe("extractSnippet", () => {
  it("returns null when the query does not occur", () => {
    expect(extractSnippet("hello world", "absent")).toBeNull();
  });

  it("adds ellipses only where text was cut", () => {
    const long = `${"a".repeat(100)} target ${"b".repeat(100)}`;
    const snippet = extractSnippet(long, "target")!;
    expect(snippet.before.startsWith("…")).toBe(true);
    expect(snippet.after.endsWith("…")).toBe(true);

    const short = extractSnippet("small target text", "target")!;
    expect(short.before).toBe("small ");
    expect(short.after).toBe(" text");
  });

  it("keeps the snippet bounded to roughly 60 chars around the hit", () => {
    const long = `${"x".repeat(500)} pivot ${"y".repeat(500)}`;
    const snippet = extractSnippet(long, "pivot")!;
    const total = snippet.before.length + snippet.hit.length + snippet.after.length;
    expect(total).toBeLessThanOrEqual(80);
  });

  it("collapses newlines so the snippet stays a single line", () => {
    const snippet = extractSnippet("line one\nline two hit\nline three", "hit")!;
    expect(`${snippet.before}${snippet.hit}${snippet.after}`).not.toContain("\n");
  });
});

describe("sessionSearchIndex", () => {
  it("caches by object identity and rebuilds for a replaced session", () => {
    const original = session("a", "Title", ["first"]);
    const first = sessionSearchIndex(original);
    expect(sessionSearchIndex(original)).toBe(first);

    const replaced = { ...original, messages: [...original.messages, { role: "user", content: "SECOND" }] };
    const rebuilt = sessionSearchIndex(replaced);
    expect(rebuilt).not.toBe(first);
    expect(rebuilt).toContain("second");
  });

  it("skips context divider content", () => {
    const s: TestSession = {
      id: "d",
      title: "t",
      messages: [{ role: "context_divider", content: "divider-secret" }],
    };
    expect(sessionSearchIndex(s)).not.toContain("divider-secret");
  });
});
