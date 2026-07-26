import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { describe, expect, it } from "vitest";
import { repairMalformedGfmTables } from "./markdownPreprocess";

describe("repairMalformedGfmTables", () => {
  it("repairs a delimiter missing the final column in the reported table", () => {
    const source = [
      "具体来看：",
      "",
      "| 模型 | 思考力度 | 通过率 | 平均成本 |",
      "|---|--------|------|",
      "| gpt-5.6-sol | max | 73% | $8.39 |",
      "| gpt-5.6-sol | high | 69% | $3.47 |",
    ].join("\n");

    expect(repairMalformedGfmTables(source)).toBe(source.replace(
      "|---|--------|------|",
      "|---|--------|------|---|",
    ));
  });

  it("lets the reported content render as a GFM table instead of cross-row math", () => {
    const source = [
      "| Model | Effort | Pass | Cost |",
      "|---|--------|------|",
      "| gpt-5.6-sol | max | 73% | $8.39 |",
      "| gpt-5.6-sol | high | 69% | $3.47 |",
    ].join("\n");
    const html = renderToStaticMarkup(createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm, remarkMath],
      rehypePlugins: [rehypeKatex],
      children: repairMalformedGfmTables(source),
    }));

    expect(html).toContain("<table>");
    expect(html.match(/<th>/g)).toHaveLength(4);
    expect(html).toContain("$8.39");
    expect(html).not.toContain("class=\"katex\"");
  });

  it("leaves an already valid table byte-for-byte unchanged", () => {
    const source = "| A | B |\r\n|:---|---:|\r\n| $8.39 | $3.47 |";
    expect(repairMalformedGfmTables(source)).toBe(source);
  });

  it("preserves CRLF while repairing only the delimiter", () => {
    const source = "| A | B | C |\r\n|---|---|\r\n| 1 | 2 | 3 |";
    expect(repairMalformedGfmTables(source)).toBe(
      "| A | B | C |\r\n|---|---|---|\r\n| 1 | 2 | 3 |",
    );
  });

  it("supports delimiter rows without outer pipes", () => {
    const source = "A | B | C\n--- | ---\n1 | 2 | 3";
    expect(repairMalformedGfmTables(source)).toBe(
      "A | B | C\n--- | --- | ---\n1 | 2 | 3",
    );
  });

  it("counts escaped pipes as cell content", () => {
    const source = "| A \\| detail | B | C |\n|---|---|\n| 1 \\| note | 2 | 3 |";
    expect(repairMalformedGfmTables(source)).toBe(
      "| A \\| detail | B | C |\n|---|---|---|\n| 1 \\| note | 2 | 3 |",
    );
  });

  it("does not guess when the first data row does not confirm the header width", () => {
    const source = "| A | B | C | D |\n|---|---|---|\n| 1 | 2 | 3 |";
    expect(repairMalformedGfmTables(source)).toBe(source);
  });

  it("does not rewrite prose or an ambiguous single-line pipe sequence", () => {
    const source = "Choose A | B for now.\n\n| A | B | |---| | one | two |";
    expect(repairMalformedGfmTables(source)).toBe(source);
  });

  it.each([
    ["backtick", "```md", "```"],
    ["tilde", "~~~~markdown", "~~~~"],
  ])("skips malformed tables inside a %s fence", (_name, opening, closing) => {
    const table = "| A | B | C |\n|---|---|\n| 1 | 2 | 3 |";
    const source = `${opening}\n${table}\n${closing}`;
    expect(repairMalformedGfmTables(source)).toBe(source);
  });

  it("skips indented code blocks", () => {
    const source = "    | A | B | C |\n    |---|---|\n    | 1 | 2 | 3 |";
    expect(repairMalformedGfmTables(source)).toBe(source);
  });

  it("leaves valid inline and display math unchanged", () => {
    const source = "Inline $x^2 + y^2$ stays math.\n\n$$\nx^2\n$$";
    expect(repairMalformedGfmTables(source)).toBe(source);
  });
});
