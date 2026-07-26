import { describe, expect, it } from "vitest";
import { QUOTE_EXCERPT_MAX, formatQuoteReply, quoteExcerpt, splitLeadingQuote } from "./quote";

describe("quoteExcerpt", () => {
  it("prefers the selection over the message content", () => {
    expect(quoteExcerpt("full message content", "  selected part  ")).toBe("selected part");
  });

  it("falls back to the message content when the selection is blank", () => {
    expect(quoteExcerpt("full message content", "   ")).toBe("full message content");
    expect(quoteExcerpt("full message content")).toBe("full message content");
  });

  it("clamps long content to ~200 chars with an ellipsis", () => {
    const long = "x".repeat(500);
    const excerpt = quoteExcerpt(long);
    expect(excerpt.length).toBe(QUOTE_EXCERPT_MAX + 1);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("does not add an ellipsis to short content", () => {
    expect(quoteExcerpt("short")).toBe("short");
  });
});

describe("formatQuoteReply", () => {
  it("prepends the excerpt as a markdown blockquote", () => {
    expect(formatQuoteReply("quoted line", "my reply"))
      .toBe("> quoted line\n\nmy reply");
  });

  it("prefixes every line of a multi-line excerpt", () => {
    expect(formatQuoteReply("first\nsecond", "reply"))
      .toBe("> first\n> second\n\nreply");
  });

  it("keeps blank excerpt lines inside the same blockquote", () => {
    expect(formatQuoteReply("first\n\nthird", "reply"))
      .toBe("> first\n>\n> third\n\nreply");
  });

  it("returns just the blockquote when the message is empty", () => {
    expect(formatQuoteReply("quoted", "  ")).toBe("> quoted");
  });
});

describe("splitLeadingQuote", () => {
  it("round-trips what formatQuoteReply produced", () => {
    const formatted = formatQuoteReply("first\n\nthird", "my reply");
    expect(splitLeadingQuote(formatted)).toEqual({ quote: "first\n\nthird", rest: "my reply" });
  });

  it("returns quote=null for plain content", () => {
    expect(splitLeadingQuote("no quote here")).toEqual({ quote: null, rest: "no quote here" });
  });

  it("does not treat a mid-message blockquote as a leading quote", () => {
    const content = "intro\n> quoted later";
    expect(splitLeadingQuote(content)).toEqual({ quote: null, rest: content });
  });

  it("handles a quote-only message", () => {
    expect(splitLeadingQuote("> only quote")).toEqual({ quote: "only quote", rest: "" });
  });
});
