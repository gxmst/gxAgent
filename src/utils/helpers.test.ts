import { describe, it, expect } from "vitest";
import {
  countTokens,
  sessionToMarkdown,
  isValidJSON,
  formatJSON,
  generateTitle,
  parseCommand,
} from "./helpers";

describe("countTokens", () => {
  it("returns 0 for empty/falsy input", () => {
    expect(countTokens("")).toBe(0);
    // @ts-expect-error exercising runtime guard for null
    expect(countTokens(null)).toBe(0);
  });

  it("approximates ~1 token per 4 chars, rounding up", () => {
    expect(countTokens("a")).toBe(1);
    expect(countTokens("abcd")).toBe(1);
    expect(countTokens("abcde")).toBe(2);
    expect(countTokens("a".repeat(400))).toBe(100);
  });
});

describe("parseCommand", () => {
  it("treats input without leading slash as non-command", () => {
    expect(parseCommand("hello world")).toEqual({ isCommand: false });
    expect(parseCommand("")).toEqual({ isCommand: false });
  });

  it("parses a bare command", () => {
    expect(parseCommand("/clear")).toEqual({
      isCommand: true,
      command: "clear",
      args: "",
    });
  });

  it("lowercases the command and preserves argument casing", () => {
    expect(parseCommand("/Export MyFile.md")).toEqual({
      isCommand: true,
      command: "export",
      args: "MyFile.md",
    });
  });

  it("keeps spaces in multi-word args", () => {
    expect(parseCommand("/say hello there world")).toEqual({
      isCommand: true,
      command: "say",
      args: "hello there world",
    });
  });
});

describe("generateTitle", () => {
  it("returns short messages unchanged", () => {
    expect(generateTitle("short title")).toBe("short title");
  });

  it("trims surrounding whitespace", () => {
    expect(generateTitle("  padded  ")).toBe("padded");
  });

  it("collapses newlines into spaces", () => {
    expect(generateTitle("line one\nline two")).toBe("line one line two");
  });

  it("truncates long messages to 27 chars + ellipsis", () => {
    const long = "a".repeat(50);
    const title = generateTitle(long);
    expect(title).toBe("a".repeat(27) + "...");
    expect(title.length).toBe(30);
  });

  it("keeps a message exactly at the 30-char boundary intact", () => {
    const exactly30 = "a".repeat(30);
    expect(generateTitle(exactly30)).toBe(exactly30);
  });
});

describe("isValidJSON", () => {
  it("accepts valid JSON", () => {
    expect(isValidJSON('{"a":1}')).toBe(true);
    expect(isValidJSON("[1,2,3]")).toBe(true);
    expect(isValidJSON('"a string"')).toBe(true);
  });

  it("rejects invalid JSON", () => {
    expect(isValidJSON("{a:1}")).toBe(false);
    expect(isValidJSON("not json")).toBe(false);
    expect(isValidJSON("")).toBe(false);
  });
});

describe("formatJSON", () => {
  it("pretty-prints valid JSON with 2-space indent", () => {
    expect(formatJSON('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it("returns the original string when input is not JSON", () => {
    expect(formatJSON("not json")).toBe("not json");
  });
});

describe("sessionToMarkdown", () => {
  it("renders a title header and role sections", () => {
    const md = sessionToMarkdown("My Chat", [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(md).toContain("# My Chat");
    expect(md).toContain("👤 用户");
    expect(md).toContain("🤖 助手");
    expect(md).toContain("hi");
    expect(md).toContain("hello");
  });

  it("includes tool calls and their output", () => {
    const md = sessionToMarkdown("T", [
      {
        role: "assistant",
        content: "done",
        actions: [{ name: "read_file", status: "done", output: "file contents" }],
      },
    ]);
    expect(md).toContain("工具调用");
    expect(md).toContain("**read_file** (done)");
    expect(md).toContain("file contents");
  });

  it("omits the tool-call section when there are no actions", () => {
    const md = sessionToMarkdown("T", [{ role: "user", content: "hi", actions: [] }]);
    expect(md).not.toContain("工具调用");
  });
});
