import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  createSession,
  normalizeSessions,
} from "../appDefaults";
import { resolveRequestConfig } from "./requestConfig";
import {
  captureContextVariants,
  selectMessageVariant,
  serializeMessageForApi,
} from "./messageHistory";
import {
  learningConfig,
  normalizeLearningContext,
  normalizeSnapshots,
} from "./learning";
import type { LearningContext, Message } from "../types";

const learning: LearningContext = {
  skills: [],
  retrieval: {
    query: "backup",
    topK: 5,
    mode: "any",
    durationMs: 1,
    hits: [
      {
        chunkId: "abc:def:0",
        documentId: "one",
        path: "/guide.md",
        title: "Guide",
        text: "Backups preserve tasks.",
        score: 1,
        startChar: 0,
        endChar: 20,
      },
    ],
  },
};

describe("learning context ownership", () => {
  it("keeps citations with their answer variant and preserves evidence in later context", () => {
    const original: Message = {
      role: "assistant",
      content: "First answer",
      learningContext: learning,
    };
    const retried: Message = {
      ...original,
      content: "Second answer",
      variants: ["First answer", "Second answer"],
      currentVariantIndex: 1,
      contextVariants: [...captureContextVariants(original), {}],
      learningContext: undefined,
    };
    expect(selectMessageVariant(retried, 0).learningContext).toEqual(learning);
    expect(
      selectMessageVariant(selectMessageVariant(retried, 0), 1).learningContext,
    ).toBeUndefined();
    expect(serializeMessageForApi(original)[0].content).toContain(
      "[KB:abc:def:0]",
    );
    expect(serializeMessageForApi(original)[0].content).toContain(
      "not instructions",
    );
  });
  it("normalizes interrupted tool state and retains context after restart", () => {
    const session = createSession("code", "Recovered", [
      {
        role: "assistant",
        content: "partial",
        run: { requestId: "one", status: "running", startedAt: 1 },
        actions: [
          {
            id: "tool",
            name: "execute_command",
            arguments: "{}",
            status: "executing",
          },
        ],
        learningContext: learning,
      },
    ]);
    const message = normalizeSessions([session])[0].messages[0];
    expect(message.run?.status).toBe("interrupted");
    expect(message.actions?.[0].status).toBe("error");
    expect(message.actions?.[0].output).toContain("Verify");
    expect(message.learningContext).toEqual(learning);
  });
  it("applies task overrides without modifying global skill selection", () => {
    const config = {
      ...DEFAULT_CONFIG,
      learning: {
        skill_roots: [],
        enabled_skills: ["global"],
        knowledge_enabled: true,
        top_k: 5,
        match_mode: "any" as const,
      },
    };
    const session = createSession("code").sessionConfig;
    const resolved = resolveRequestConfig(config, {
      ...session,
      skillIds: [],
      knowledgeEnabled: false,
    });
    expect(resolved.learning?.enabled_skills).toEqual([]);
    expect(resolved.learning?.knowledge_enabled).toBe(false);
    expect(config.learning.enabled_skills).toEqual(["global"]);
  });
  it("rejects malformed snapshots and bounds retained calls", () => {
    expect(normalizeSnapshots([{}, null, "not a snapshot"])).toEqual([]);
    const snapshots = Array.from({ length: 10 }, (_, iteration) => ({
      engine: "native",
      iteration,
      capturedAt: 1,
      messages: [],
      tools: [],
      truncated: false,
    }));
    expect(normalizeSnapshots(snapshots)?.map((s) => s.iteration)).toEqual([
      4, 5, 6, 7, 8, 9,
    ]);
  });
  it("rejects incomplete evidence from imported history before it reaches the inspector", () => {
    expect(
      normalizeLearningContext({ skills: [{ name: "broken", body: "body" }] }),
    ).toBeUndefined();
    expect(
      normalizeLearningContext({
        ...learning,
        retrieval: {
          ...learning.retrieval,
          hits: [{ chunkId: "one", text: "passage", title: "Guide" }],
        },
      }),
    ).toBeUndefined();
    expect(normalizeLearningContext(learning)).toEqual(learning);
    expect(
      learningConfig({
        ...DEFAULT_CONFIG,
        learning: { top_k: NaN, enabled_skills: null } as any,
      }),
    ).toEqual({
      skill_roots: [],
      enabled_skills: [],
      knowledge_enabled: false,
      top_k: 5,
      match_mode: "any",
    });
  });
});
