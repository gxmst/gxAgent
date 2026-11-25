import { describe, expect, it } from "vitest";
import {
  extractActiveMention,
  flattenDirectoryTree,
  matchMentions,
  stripMentionToken,
} from "./mentions";

describe("mentions", () => {
  it("extracts @-mentions at start or after whitespace, ignoring emails", () => {
    expect(extractActiveMention("@App", 4)).toEqual({ query: "App", start: 0, end: 4 });
    expect(extractActiveMention("check @src/App", 14)).toEqual({
      query: "src/App",
      start: 6,
      end: 14,
    });
    expect(extractActiveMention("mail dev@example.com", 20)).toBeNull();
    expect(extractActiveMention("hello ", 6)).toBeNull();
  });

  it("flattens directory trees to relative forward-slash paths", () => {
    const files = flattenDirectoryTree(
      {
        name: "repo",
        path: "F:\\repo",
        kind: "directory",
        size: 0,
        children: [
          {
            name: "src",
            path: "F:\\repo\\src",
            kind: "directory",
            size: 0,
            children: [
              { name: "App.tsx", path: "F:\\repo\\src\\App.tsx", kind: "file", size: 10, children: [] },
            ],
          },
        ],
      },
      "F:\\repo",
    );
    expect(files).toEqual([
      { relativePath: "src/App.tsx", fullPath: "F:\\repo\\src\\App.tsx" },
    ]);
  });

  it("prioritizes git-diff, skills, and basename file matches and strips tokens", () => {
    const matches = matchMentions(
      "diff",
      [{ relativePath: "src/diffHelper.ts", fullPath: "/repo/src/diffHelper.ts" }],
      [],
      "en",
    );
    expect(matches[0].kind).toBe("git-diff");
    expect(matches[1].label).toBe("src/diffHelper.ts");
    expect(stripMentionToken("inspect @src/diff please", { query: "src/diff", start: 8, end: 17 })).toBe(
      "inspect please",
    );
  });
});
