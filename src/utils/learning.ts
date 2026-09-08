import type {
  AppConfig,
  ContextSnapshot,
  LearningConfig,
  LearningContext,
} from "../types";

export const DEFAULT_LEARNING: LearningConfig = {
  skill_roots: [],
  enabled_skills: [],
  knowledge_enabled: false,
  top_k: 5,
  match_mode: "any",
};
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((s) => typeof s === "string");
export function learningConfig(config: AppConfig): LearningConfig {
  const value = config.learning;
  return {
    skill_roots: strings(value?.skill_roots)
      ? [...new Set(value.skill_roots)]
      : [],
    enabled_skills: strings(value?.enabled_skills)
      ? [...new Set(value.enabled_skills)]
      : [],
    knowledge_enabled: value?.knowledge_enabled === true,
    top_k:
      typeof value?.top_k === "number" && Number.isFinite(value.top_k)
        ? Math.max(1, Math.min(20, Math.floor(value.top_k)))
        : 5,
    match_mode: value?.match_mode === "all" ? "all" : "any",
  };
}
export function normalizeSnapshots(
  value: unknown,
): ContextSnapshot[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((v): v is ContextSnapshot =>
      Boolean(
        v &&
          typeof v === "object" &&
          typeof v.engine === "string" &&
          Number.isFinite(v.iteration) &&
          Number.isFinite(v.capturedAt) &&
          Array.isArray(v.messages) &&
          Array.isArray(v.tools),
      ),
    )
    .slice(-6);
}
export function normalizeLearningContext(
  value: unknown,
): LearningContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as LearningContext;
  if (
    !Array.isArray(input.skills) ||
    !input.skills.every(
      (s) =>
        s &&
        [s.id, s.name, s.description, s.path, s.scope, s.body].every(
          (v) => typeof v === "string",
        ) &&
        strings(s.resources) &&
        strings(s.dependencies) &&
        strings(s.missingDependencies),
    )
  )
    return undefined;
  if (
    input.retrieval &&
    (typeof input.retrieval.query !== "string" ||
      !Number.isFinite(input.retrieval.durationMs) ||
      !Number.isFinite(input.retrieval.topK) ||
      !["any", "all"].includes(input.retrieval.mode) ||
      !Array.isArray(input.retrieval.hits) ||
      !input.retrieval.hits.every(
        (h) =>
          h &&
          [h.chunkId, h.documentId, h.path, h.title, h.text].every(
            (v) => typeof v === "string",
          ) &&
          [h.score, h.startChar, h.endChar].every(
            (v) => typeof v === "number" && Number.isFinite(v),
          ),
      ))
  )
    return undefined;
  return input;
}
