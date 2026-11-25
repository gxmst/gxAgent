import { expect, it } from "vitest";
import { parseMcpArguments, parseMcpEnvironment } from "./mcpConfig";
it("preserves commas, spaces and Windows paths in MCP arguments", () => {
  expect(parseMcpArguments('["--data", "a,b", "C:\\\\My Files\\\\data"]')).toEqual(["--data", "a,b", "C:\\My Files\\data"]);
  expect(parseMcpArguments("--filter\na,b\nC:\\My Files\\data")).toEqual(["--filter", "a,b", "C:\\My Files\\data"]);
  expect(() => parseMcpArguments('[42]')).toThrow("string array");
});
it("rejects invalid or duplicate environment lines rather than ignoring them", () => {
  expect(parseMcpEnvironment("TOKEN=a=b\nEMPTY=")).toEqual({ TOKEN: "a=b", EMPTY: "" });
  expect(() => parseMcpEnvironment("missing assignment")).toThrow();
  expect(() => parseMcpEnvironment("PATH=a\nPath=b")).toThrow("Duplicate");
});
