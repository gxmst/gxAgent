import type { ApiProfile, AppConfig, ModelInfo, ProviderPreset } from "../types";

export const profileFromConfig = (config: AppConfig): ApiProfile => ({
  name: "", provider: config.provider, wire_format: config.wire_format,
  base_url: config.base_url, api_key: config.api_key, default_model: config.model,
  models: config.active_profile ? config.profiles[config.active_profile]?.models || [] : [],
});

export const profileFromPreset = (preset: ProviderPreset): ApiProfile => ({
  name: preset.name, provider: preset.provider, wire_format: preset.wire_format || "openai",
  base_url: preset.base_url, api_key: "", default_model: preset.default_model, models: [],
});

export function connectionError(profile: ApiProfile, profiles: AppConfig["profiles"], editingId: string | null, zh: boolean): string {
  if (!profile.name.trim()) return zh ? "请填写连接名称" : "Enter a connection name";
  if (Object.entries(profiles).some(([id, p]) => id !== editingId && p.name.trim().toLocaleLowerCase() === profile.name.trim().toLocaleLowerCase())) return zh ? "此连接名称已存在，请使用其他名称" : "This connection name already exists";
  try {
    const url = new URL(profile.base_url.trim());
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { return zh ? "请填写有效的 HTTP(S) API 地址，不含密钥、查询参数或锚点" : "Enter an HTTP(S) API URL without credentials, query or fragment"; }
  if (!profile.default_model.trim()) return zh ? "请获取或手填默认模型 ID" : "Fetch or enter a default model ID";
  return "";
}

export function connectionModels(current: string, saved: string[] = [], fetched: ModelInfo[] = []): ModelInfo[] {
  const entries = new Map<string, ModelInfo>();
  for (const id of [current, ...saved]) if (id.trim()) entries.set(id, { id });
  for (const model of fetched) entries.set(model.id, model);
  return Array.from(entries.values());
}
