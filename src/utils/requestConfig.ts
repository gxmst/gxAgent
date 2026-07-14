import type { AppConfig, SessionConfig } from "../types";
import { ROLE_PRESETS } from "../rolePresets";

const withWebSearchPolicy = (
  tools: string[],
  searchMode: SessionConfig["searchMode"],
) => {
  const globallyEnabled = tools.includes("web_search");
  const withoutSearch = tools.filter((tool) => tool !== "web_search");
  if (!globallyEnabled || searchMode === "off") return withoutSearch;
  return [...withoutSearch, "web_search"];
};

/**
 * Resolve the effective prompt for an explicitly active role preset.
 *
 * Built-in presets are looked up by id so sessions automatically receive the
 * latest bundled definition. Custom presets are not part of the request-layer
 * registry, so their persisted session prompt remains the compatibility
 * fallback. A manual session prompt never becomes a role fallback unless a
 * preset id is explicitly active.
 */
export function resolveActiveRolePrompt(sessionConfig: SessionConfig): string | null {
  if (!sessionConfig.activeRolePresetId) return null;

  const bundledPreset = ROLE_PRESETS.find(
    (preset) => preset.id === sessionConfig.activeRolePresetId,
  );
  const prompt = bundledPreset?.prompt ?? sessionConfig.systemPrompt;
  return typeof prompt === "string" && prompt.trim() ? prompt.trim() : null;
}

/**
 * Resolve the complete request configuration for a session.
 *
 * Resolution order is global config -> selected profile -> session overrides.
 * A null session value means "inherit". Search mode may remove web_search, but
 * it can never re-enable a tool that is disabled globally.
 */
export function resolveRequestConfig(
  globalConfig: AppConfig,
  sessionConfig: SessionConfig,
  searchMode: SessionConfig["searchMode"] = sessionConfig.searchMode,
): AppConfig {
  const profile = sessionConfig.profileId
    ? globalConfig.profiles[sessionConfig.profileId]
    : undefined;

  const resolved: AppConfig = {
    ...globalConfig,
    ...(profile
      ? {
          provider: profile.provider,
          wire_format: profile.wire_format,
          base_url: profile.base_url,
          api_key: profile.api_key,
          model: profile.default_model,
          active_profile: sessionConfig.profileId,
        }
      : {}),
  };

  // role_prompt is deliberately request-only. Clear any stale value that may
  // have reached the global/profile object, then set it only for an explicitly
  // active and resolvable role preset.
  delete resolved.role_prompt;
  const rolePrompt = resolveActiveRolePrompt(sessionConfig);
  if (rolePrompt !== null) {
    resolved.system_prompt = rolePrompt;
    resolved.role_prompt = rolePrompt;
  } else if (sessionConfig.systemPrompt !== null) {
    resolved.system_prompt = sessionConfig.systemPrompt;
  }
  if (sessionConfig.model !== null) resolved.model = sessionConfig.model;
  if (sessionConfig.temperature !== null) resolved.temperature = sessionConfig.temperature;
  if (sessionConfig.topP !== null) resolved.top_p = sessionConfig.topP;
  if (sessionConfig.maxTokens !== "inherit") resolved.max_tokens = sessionConfig.maxTokens;
  if (sessionConfig.streaming !== null) resolved.streaming = sessionConfig.streaming;
  if (sessionConfig.thinkingLevel !== null) resolved.thinking_level = sessionConfig.thinkingLevel;
  if (sessionConfig.contextLimit !== null) resolved.context_limit = sessionConfig.contextLimit;
  if (sessionConfig.workDir !== null && sessionConfig.workDir.trim()) {
    resolved.default_work_dir = sessionConfig.workDir.trim();
  }

  resolved.tools_enabled = withWebSearchPolicy(globalConfig.tools_enabled, searchMode);
  return resolved;
}
