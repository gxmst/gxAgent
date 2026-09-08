import { test, expect } from "@playwright/test";
import { emit, installFixture } from "./fixture";

test.beforeEach(async ({ page }) => {
  await installFixture(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Session recovery", exact: true }),
  ).toBeVisible();
});

test("MCP inspector validates JSON and displays complete structured errors", async ({
  page,
}, testInfo) => {
  await page.keyboard.press("Control+,");
  await page.getByRole("tab", { name: "Tools & MCP", exact: true }).click();
  await page
    .getByRole("button", { name: "Inspect tools", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Tool", exact: true }),
  ).toHaveValue("search_docs");
  await page
    .getByRole("textbox", { name: "Arguments", exact: true })
    .fill("[]");
  await page.getByRole("button", { name: "Call tool", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("JSON object");
  expect(
    await page.evaluate(
      () =>
        (window as any).__calls.filter(
          (c: any) => c.command === "call_mcp_debug",
        ).length,
    ),
  ).toBe(0);
  await page
    .getByRole("textbox", { name: "Arguments", exact: true })
    .fill('{"query":"knowledge"}');
  await page.evaluate(() => {
    (window as any).__mcpError = true;
  });
  await page.getByRole("button", { name: "Call tool", exact: true }).click();
  await page.getByRole("button", { name: "Call", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Tool returned an error");
  await expect(page.locator(".lab-json")).toContainText("structuredContent");
  await page.locator(".lab-json").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("mcp-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".lab-json").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("mcp-mobile.png") });
});

test("knowledge import, retrieval and fixed-question evaluation work together", async ({
  page,
}, testInfo) => {
  await page.keyboard.press("Control+,");
  await page.getByRole("tab", { name: "Knowledge", exact: true }).click();
  await page
    .getByRole("button", { name: "Add documents", exact: true })
    .click();
  await expect(page.locator(".knowledge-documents")).toContainText("new.md");
  await page
    .getByRole("textbox", { name: "Search query", exact: true })
    .fill("knowledge");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".evidence-list").first()).toContainText(
    "guide.md",
  );
  await page
    .getByLabel("Evaluation question", { exact: true })
    .fill("What is local knowledge?");
  await page
    .getByRole("combobox", { name: "Expected source", exact: true })
    .selectOption("doc-1");
  await page.getByRole("button", { name: "Add question", exact: true }).click();
  await page.getByRole("button", { name: "Evaluate", exact: true }).click();
  await expect(page.locator(".lab-metrics")).toContainText("100.0%");
  await page.locator(".lab-metrics").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("knowledge-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".lab-metrics").scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("button", { name: "Evaluate", exact: true }),
  ).toBeVisible();
  const overflowing = await page
    .locator(".settings-modal")
    .evaluate((root) => root.scrollWidth > root.clientWidth + 2);
  expect(overflowing).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("knowledge-mobile.png") });
});

test("skills and knowledge apply to a request and expose evidence and context", async ({
  page,
}, testInfo) => {
  await page.keyboard.press("Control+,");
  await page.getByRole("tab", { name: "Skills", exact: true }).click();
  await page.getByRole("checkbox", { name: /docs-reader/ }).check();
  await page.getByRole("tab", { name: "Knowledge", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Retrieve before answering", exact: true })
    .check();
  await page.keyboard.press("Escape");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Explain local knowledge");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const args = await page.evaluate(
    () =>
      (window as any).__calls.find(
        (c: any) => c.command === "start_agent_session",
      ).args,
  );
  expect(args.config.learning.knowledge_enabled).toBe(true);
  expect(args.config.learning.enabled_skills).toEqual(["a".repeat(64)]);
  expect(args.retrievalQuery).toBe("Explain local knowledge");
  await emit(page, "agent-learning-context", {
    requestId: args.requestId,
    learning: {
      skills: [],
      retrieval: {
        query: "local knowledge",
        durationMs: 2,
        topK: 5,
        mode: "any",
        hits: [
          {
            chunkId: "abcd:1234:0",
            documentId: "doc-1",
            path: "C:/docs/guide.md",
            title: "guide.md",
            text: "Indexed documents are searched locally.",
            score: 1,
            startChar: 0,
            endChar: 40,
          },
        ],
      },
    },
  });
  await emit(page, "agent-context", {
    requestId: args.requestId,
    snapshot: {
      engine: "native",
      iteration: 1,
      capturedAt: Date.now(),
      messages: [
        { role: "system", content: "Read documents before answering." },
      ],
      tools: [],
      truncated: false,
    },
  });
  await emit(page, "agent-stream-chunk", {
    requestId: args.requestId,
    content: "Search local documents. [KB:abcd:1234:0]",
  });
  await emit(page, "agent-complete", {
    requestId: args.requestId,
    status: "success",
  });
  await page.getByRole("link", { name: "1", exact: true }).click();
  await expect(page.locator(".message-evidence pre")).toContainText(
    "Indexed documents",
  );
  await page
    .getByRole("button", { name: "Inspect context", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Context", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page
    .locator(".context-inspector summary")
    .filter({ hasText: "system" })
    .click();
  await expect(page.locator(".context-inspector")).toContainText(
    "Read documents before answering.",
  );
  await page.screenshot({ path: testInfo.outputPath("context-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".context-inspector")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await page.screenshot({ path: testInfo.outputPath("context-mobile.png") });
});

test("restoring a snapshot creates a separate task", async ({ page }) => {
  await page.keyboard.press("Control+,");
  await page.getByRole("tab", { name: "Data", exact: true }).click();
  await page.getByRole("button", { name: "Restore copy", exact: true }).click();
  await page
    .getByRole("alertdialog", { name: "Restore task copy", exact: true })
    .getByRole("button", { name: "Restore copy", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Task copy restored" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", {
      name: "Session recovery (restored)",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator('[data-session-id="review"]')).toBeVisible();
});

test("damaged storage can be repaired while ordinary writes are paused", async ({
  page,
}) => {
  await page.evaluate(() =>
    localStorage.setItem("fixture_damaged_storage", "true"),
  );
  await page.reload();
  await expect(
    page.getByText("Session loading failed. Saving is paused.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.keyboard.press("Control+,");
  await page.getByRole("tab", { name: "Data", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Create snapshot", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Repair task", exact: true }).click();
  await page
    .getByRole("alertdialog", { name: "Repair damaged task", exact: true })
    .getByRole("button", { name: "Repair from snapshot", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Create snapshot", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "Session recovery", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Continue after repair");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__calls.some(
          (c: any) => c.command === "start_agent_session",
        ),
      ),
    )
    .toBe(true);
});

test("continuous streaming persists partial progress without waiting for silence", async ({
  page,
}) => {
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Run a long task");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.evaluate(() => {
    const bridge = window as any;
    const requestId = bridge.__calls.find(
      (c: any) => c.command === "start_agent_session",
    ).args.requestId;
    bridge.__streamInterval = setInterval(
      () =>
        bridge.__emit("agent-stream-chunk", {
          requestId,
          content: "progress ",
        }),
      80,
    );
  });
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window as any).__sessions
            .find((s: any) => s.id === "review")
            .messages.some(
              (m: any) =>
                m.run?.status === "running" && m.content.includes("progress"),
            ),
        ),
      { timeout: 8000 },
    )
    .toBe(true);
  await page.evaluate(() => {
    const bridge = window as any;
    clearInterval(bridge.__streamInterval);
    const requestId = bridge.__calls.find(
      (c: any) => c.command === "start_agent_session",
    ).args.requestId;
    bridge.__emit("agent-complete", { requestId, status: "success" });
  });
});

test("manual snapshots require a successful save of the latest response", async ({
  page,
}) => {
  await page.evaluate(() => {
    (window as any).__saveFailure = true;
  });
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Snapshot this response");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const requestId = await page.evaluate(
    () =>
      (window as any).__calls.find(
        (c: any) => c.command === "start_agent_session",
      ).args.requestId,
  );
  await emit(page, "agent-stream-chunk", {
    requestId,
    content: "Latest unsaved response",
  });
  await emit(page, "agent-complete", { requestId, status: "completed" });
  await page.keyboard.press("Control+,");
  await page.getByRole("tab", { name: "Data", exact: true }).click();
  await page
    .getByRole("button", { name: "Create snapshot", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Session disk is unavailable",
  );
  expect(
    await page.evaluate(
      () =>
        (window as any).__calls.filter(
          (c: any) => c.command === "create_session_backup",
        ).length,
    ),
  ).toBe(0);
  await page.evaluate(() => {
    (window as any).__saveFailure = false;
  });
  await page
    .getByRole("button", { name: "Create snapshot", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Snapshots created" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as any).__snapshotSessions
          .find((s: any) => s.id === "review")
          .messages.at(-1).content,
    ),
  ).toBe("Latest unsaved response");
});
