import { describe, it, expect } from "vitest";
import { getToolStats } from "./sessionHelpers";

describe("getToolStats", () => {
  it("returns an empty map for no sessions", () => {
    expect(getToolStats([])).toEqual({});
  });

  it("counts tool calls across messages and sessions", () => {
    const sessions = [
      {
        messages: [
          { actions: [{ name: "read_file" }, { name: "write_file" }] },
          { actions: [{ name: "read_file" }] },
        ],
      },
      {
        messages: [{ actions: [{ name: "run_command" }, { name: "read_file" }] }],
      },
    ];
    expect(getToolStats(sessions)).toEqual({
      read_file: 3,
      write_file: 1,
      run_command: 1,
    });
  });

  it("labels actions without a name as 'unknown'", () => {
    const sessions = [{ messages: [{ actions: [{}, { name: "x" }] }] }];
    expect(getToolStats(sessions)).toEqual({ unknown: 1, x: 1 });
  });

  it("tolerates messages without actions and sessions without messages", () => {
    const sessions = [
      { messages: [{ role: "user", content: "hi" }] },
      {},
    ];
    expect(getToolStats(sessions as any)).toEqual({});
  });
});
