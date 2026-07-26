import { describe, expect, it } from "vitest";
import { splitCommandSegments, suggestCommandTrustPattern, suggestTrustPatterns } from "./trustPatterns";

describe("splitCommandSegments", () => {
  it("splits on unquoted separators", () => {
    expect(splitCommandSegments("git status; git diff")).toEqual(["git status", "git diff"]);
    expect(splitCommandSegments("cd src && npm test")).toEqual(["cd src", "npm test"]);
    expect(splitCommandSegments("a || b")).toEqual(["a", "b"]);
    expect(splitCommandSegments("Get-Content x | Select-String y")).toEqual([
      "Get-Content x",
      "Select-String y",
    ]);
  });

  it("keeps separators inside quotes", () => {
    expect(splitCommandSegments("echo 'a; b'")).toEqual(["echo 'a; b'"]);
    expect(splitCommandSegments('git commit -m "x && y"')).toEqual(['git commit -m "x && y"']);
  });
});

describe("suggestCommandTrustPattern", () => {
  it("uses two tokens for subcommand launchers", () => {
    expect(suggestCommandTrustPattern("git commit -m msg")).toBe("git commit");
    expect(suggestCommandTrustPattern("npm run build:css")).toBe("npm run");
    expect(suggestCommandTrustPattern("cargo test --lib")).toBe("cargo test");
    expect(suggestCommandTrustPattern("node scripts/gen.js --fast")).toBe("node scripts/gen.js");
  });

  it("falls back to the first token otherwise", () => {
    expect(suggestCommandTrustPattern("Get-Date")).toBe("Get-Date");
    expect(suggestCommandTrustPattern("systeminfo")).toBe("systeminfo");
    // Launcher followed by a flag: the flag is not a subcommand
    expect(suggestCommandTrustPattern("git --version")).toBe("git");
  });

  it("skips the call operator", () => {
    expect(suggestCommandTrustPattern("& .\\build.ps1")).toBe(".\\build.ps1");
  });
});

describe("suggestTrustPatterns", () => {
  it("produces one pattern per compound segment, deduped", () => {
    const args = JSON.stringify({ command: "git status; git diff; git status" });
    expect(suggestTrustPatterns("execute_command", args)).toEqual(["git status", "git diff"]);
  });

  it("trusts the directory for file writes", () => {
    const args = JSON.stringify({ path: "src\\components\\Button.tsx" });
    expect(suggestTrustPatterns("write_file", args)).toEqual(["src\\components\\"]);
  });

  it("falls back to the tool name for MCP tools and malformed args", () => {
    expect(suggestTrustPatterns("mcp_query_db", "{}")).toEqual(["mcp_query_db"]);
    expect(suggestTrustPatterns("execute_command", "not json")).toEqual(["execute_command"]);
  });
});
