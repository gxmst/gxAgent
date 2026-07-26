import { describe, expect, it } from "vitest";
import { fallbackSessionTitle, normalizeGeneratedTitle } from "./sessionTitle";

describe("session titles", () => {
  it("creates a bounded local fallback without breaking CJK text", () => {
    expect(fallbackSessionTitle("请帮我分析这个项目为什么启动以后一直白屏而且没有错误提示"))
      .toBe("请帮我分析这个项目为什么启动以后一直...");
  });

  it("uses an attachment name when the prompt is empty", () => {
    expect(fallbackSessionTitle("", "error.log")).toBe("error.log");
  });

  it("removes common model decorations", () => {
    expect(normalizeGeneratedTitle('标题："修复登录状态丢失"')).toBe("修复登录状态丢失");
    expect(normalizeGeneratedTitle("Title: Fix startup crash\nExtra text")).toBe("Fix startup crash");
  });
});
