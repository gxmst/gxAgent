import { describe, expect, it } from "vitest";
import type { AppConfig, SessionConfig } from "../types";
import { ROLE_PRESETS } from "../rolePresets";
import { resolveActiveRolePrompt, resolveRequestConfig } from "./requestConfig";

const globalConfig: AppConfig = {
  provider: "openai",
  wire_format: "openai",
  base_url: "https://global.example/v1",
  api_key: "global-key",
  model: "global-model",
  temperature: 0.7,
  top_p: 1,
  max_tokens: null,
  system_prompt: "global prompt",
  streaming: true,
  thinking_level: "medium",
  context_limit: 50,
  tools_enabled: ["read_file", "web_search"],
  approval_policy: "standard",
  trusted_patterns: [],
  default_work_dir: "C:\\global",
  persist_trust: false,
  theme: "light",
  language: "zh",
  profiles: {
    proxy: {
      name: "proxy",
      provider: "anthropic",
      wire_format: "anthropic",
      base_url: "https://proxy.example",
      api_key: "proxy-key",
      default_model: "same-model",
    },
  },
  active_profile: null,
  mcp_servers: {},
  search_provider: "duckduckgo",
  search_api_key: "",
  font_size: 14,
  font_family: "system",
  show_advanced_reply_info: false,
  command_timeout: 30,
  max_agent_loops: 10,
  max_tool_calls_per_request: 30,
  preview_sandbox: true,
  tools_migration_version: 1,
};

const sessionConfig: SessionConfig = {
  schemaVersion: 2,
  mode: "chat",
  profileId: null,
  workDir: null,
  systemPrompt: null,
  model: null,
  contextLimit: null,
  temperature: null,
  topP: null,
  maxTokens: "inherit",
  streaming: null,
  thinkingLevel: null,
  backgroundImage: "",
  activeRolePresetId: null,
  searchMode: "auto",
};

describe("resolveRequestConfig", () => {
  it("inherits global values for null overrides", () => {
    expect(resolveRequestConfig(globalConfig, sessionConfig)).toMatchObject({
      provider: "openai",
      base_url: "https://global.example/v1",
      model: "global-model",
      temperature: 0.7,
      default_work_dir: "C:\\global",
    });
  });

  it("resolves the complete selected profile, not just its model", () => {
    const resolved = resolveRequestConfig(globalConfig, { ...sessionConfig, profileId: "proxy" });
    expect(resolved).toMatchObject({
      provider: "anthropic",
      wire_format: "anthropic",
      base_url: "https://proxy.example",
      api_key: "proxy-key",
      model: "same-model",
      active_profile: "proxy",
    });
  });

  it("keeps endpoints distinct even when model ids are identical", () => {
    const sameModelGlobal = { ...globalConfig, model: "same-model" };
    const resolved = resolveRequestConfig(sameModelGlobal, { ...sessionConfig, profileId: "proxy" });
    expect(resolved.base_url).toBe("https://proxy.example");
    expect(resolved.api_key).toBe("proxy-key");
  });

  it("applies explicit session overrides after the profile", () => {
    const resolved = resolveRequestConfig(globalConfig, {
      ...sessionConfig,
      profileId: "proxy",
      model: "override-model",
      temperature: 0.2,
      workDir: "C:\\session",
    });
    expect(resolved.model).toBe("override-model");
    expect(resolved.temperature).toBe(0.2);
    expect(resolved.default_work_dir).toBe("C:\\session");
  });

  it("resolves an active bundled role by id so its latest prompt wins", () => {
    const preset = ROLE_PRESETS[0];
    const withStaleSnapshot = {
      ...sessionConfig,
      activeRolePresetId: preset.id,
      systemPrompt: "stale bundled prompt",
    };

    expect(resolveActiveRolePrompt(withStaleSnapshot)).toBe(preset.prompt);
    expect(resolveRequestConfig(globalConfig, withStaleSnapshot)).toMatchObject({
      system_prompt: preset.prompt,
      role_prompt: preset.prompt,
    });
  });

  it("uses the session snapshot for an active custom role", () => {
    const activeCustomRole = {
      ...sessionConfig,
      activeRolePresetId: "custom-123",
      systemPrompt: "  custom role prompt  ",
    };

    expect(resolveActiveRolePrompt(activeCustomRole)).toBe("custom role prompt");
    expect(resolveRequestConfig(globalConfig, activeCustomRole)).toMatchObject({
      system_prompt: "custom role prompt",
      role_prompt: "custom role prompt",
    });
  });

  it("does not expose a manual system prompt as the role compatibility prompt", () => {
    const resolved = resolveRequestConfig(
      { ...globalConfig, role_prompt: "stale transient role" },
      { ...sessionConfig, systemPrompt: "manual session prompt" },
    );

    expect(resolved.system_prompt).toBe("manual session prompt");
    expect(resolved.role_prompt).toBeUndefined();
  });

  it("distinguishes inherited max tokens from an explicit unlimited override", () => {
    const limitedGlobal = { ...globalConfig, max_tokens: 4096 };
    expect(resolveRequestConfig(limitedGlobal, sessionConfig).max_tokens).toBe(4096);
    expect(resolveRequestConfig(limitedGlobal, { ...sessionConfig, maxTokens: null }).max_tokens).toBeNull();
  });

  it("falls back to global config when a profile no longer exists", () => {
    const resolved = resolveRequestConfig(globalConfig, { ...sessionConfig, profileId: "missing" });
    expect(resolved.base_url).toBe(globalConfig.base_url);
    expect(resolved.model).toBe(globalConfig.model);
  });

  it("lets search mode disable web search", () => {
    const resolved = resolveRequestConfig(globalConfig, sessionConfig, "off");
    expect(resolved.tools_enabled).toEqual(["read_file"]);
  });

  it("never lets session search mode re-enable a globally disabled tool", () => {
    const resolved = resolveRequestConfig(
      { ...globalConfig, tools_enabled: ["read_file"] },
      { ...sessionConfig, searchMode: "force" },
    );
    expect(resolved.tools_enabled).toEqual(["read_file"]);
  });
});
