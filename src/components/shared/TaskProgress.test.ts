import { describe, expect, it } from "vitest";
import { parseTaskItems } from "./TaskProgress";

describe("parseTaskItems", () => {
  it("parses the todo_write payload", () => {
    expect(parseTaskItems(JSON.stringify({
      todos: [
        { content: "Inspect project", status: "completed" },
        { content: "Implement fix", status: "in_progress" },
      ],
    }))).toEqual([
      { content: "Inspect project", status: "completed" },
      { content: "Implement fix", status: "in_progress" },
    ]);
  });

  it("normalizes unknown statuses to pending", () => {
    expect(parseTaskItems('{"todos":[{"content":"Review","status":"unknown"}]}'))
      .toEqual([{ content: "Review", status: "pending" }]);
  });

  it("returns an empty list for malformed arguments", () => {
    expect(parseTaskItems("not json")).toEqual([]);
    expect(parseTaskItems('{"todos":"invalid"}')).toEqual([]);
  });
});
