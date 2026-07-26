/**
 * Global-config actions shared by Settings and the composer: model-list
 * fetching, provider presets, connection profiles (save/activate/delete),
 * model display names, MCP server test/delete, tool toggles, the trust
 * whitelist and explicit config saves.
 *
 * Extracted verbatim from App.tsx. Config and the model catalog are App
 * state and flow in as params; MCP status lives in the zustand store.
 */
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import type { AppConfig, ModelInfo, ProviderPreset } from "../types";
import { TOOL_NAMES, modelCatalogKey } from "../appDefaults";
import { useAppStore } from "../store/appStore";
import { addLog } from "../services/agentEvents";

export function useConfigActions({
  lang,
  config,
  setConfig,
  setModels,
  setModelCatalogSourceKey,
  setModelsLoading,
  newProfileName,
  setNewProfileName,
  setConfigSaveStatus,
  lastSavedConfigRef,
}: {
  lang: string;
  config: AppConfig;
  setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
  setModels: React.Dispatch<React.SetStateAction<ModelInfo[]>>;
  setModelCatalogSourceKey: React.Dispatch<React.SetStateAction<string | null>>;
  setModelsLoading: React.Dispatch<React.SetStateAction<boolean>>;
  newProfileName: string;
  setNewProfileName: React.Dispatch<React.SetStateAction<string>>;
  setConfigSaveStatus: React.Dispatch<React.SetStateAction<"idle" | "saving" | "saved" | "error">>;
  lastSavedConfigRef: React.MutableRefObject<string>;
}) {
  const setMcpStatusByName = useAppStore((s) => s.setMcpStatusByName);

  const fetchModelList = async () => {
    if (!config.base_url) return;
    const snapshot = {
      wire_format: config.wire_format || "openai",
      base_url: config.base_url,
      api_key: config.api_key,
    };
    setModelsLoading(true);
    try {
      // Ollama has a distinct models endpoint; route the shared "fetch models"
      // button to it so the button works regardless of the active wire format.
      const list = snapshot.wire_format === "ollama"
        ? await invoke<ModelInfo[]>("fetch_ollama_models", { baseUrl: snapshot.base_url })
        : await invoke<ModelInfo[]>("fetch_models", {
            wireFormat: snapshot.wire_format,
            baseUrl: snapshot.base_url,
            apiKey: snapshot.api_key,
          });
      setModels(list);
      setModelCatalogSourceKey(modelCatalogKey(snapshot));
      addLog(t("log.modelsFetched", lang, { count: String(list.length), url: snapshot.base_url }), "success");
    } catch (e) {
      addLog(t("log.modelsFailed", lang) + e, "error");
    } finally {
      setModelsLoading(false);
    }
  };

  const applyPreset = (preset: ProviderPreset) => {
    setConfig((prev) => ({
      ...prev,
      provider: preset.provider,
      wire_format: preset.wire_format || "openai",
      base_url: preset.base_url,
      model: preset.default_model || prev.model,
      api_key: preset.needs_api_key ? prev.api_key : "",
    }));
    setModels([]);
    setModelCatalogSourceKey(null);
  };

  const handleSaveProfile = async () => {
    const name = newProfileName.trim();
    if (!name) return;
    try {
      const updated = await invoke<AppConfig>("save_profile", {
        currentConfig: config,
        profile: { name, base_url: config.base_url, api_key: config.api_key, default_model: config.model, wire_format: config.wire_format || "openai", provider: config.provider || "openai" },
      });
      setConfig(updated);
      cacheModelDisplayName(config.model, name);
      setNewProfileName("");
      addLog(t("profile.saved", lang), "success");
    } catch (e) {
      addLog(String(e), "error");
    }
  };

  const getModelDisplayName = (modelId: string) => {
    if (config.active_profile) {
      const profile = config.profiles[config.active_profile];
      if (profile && profile.default_model === modelId) return profile.name;
    }
    const profile = Object.values(config.profiles).find(p => p.default_model === modelId);
    if (profile) return profile.name;
    const cached = localStorage.getItem("gx_model_display_names");
    if (cached) {
      try {
        const map: Record<string, string> = JSON.parse(cached);
        if (map[modelId]) return map[modelId];
      } catch { /* ignore */ }
    }
    return modelId;
  };

  const cacheModelDisplayName = (modelId: string, displayName: string) => {
    try {
      const cached = localStorage.getItem("gx_model_display_names");
      const map: Record<string, string> = cached ? JSON.parse(cached) : {};
      map[modelId] = displayName;
      localStorage.setItem("gx_model_display_names", JSON.stringify(map));
    } catch { /* ignore */ }
  };

  const handleActivateProfile = async (name: string) => {
    try {
      const updated = await invoke<AppConfig>("set_active_profile", { currentConfig: config, name });
      setConfig(updated);
      const profile = updated.profiles[name];
      if (profile) cacheModelDisplayName(profile.default_model, profile.name);
      addLog(t("profile.activated", lang) + name, "success");
    } catch (e) {
      addLog(String(e), "error");
    }
  };

  const handleDeleteProfile = async (name: string) => {
    try {
      const updated = await invoke<AppConfig>("delete_profile", { currentConfig: config, name });
      setConfig(updated);
    } catch (e) {
      addLog(String(e), "error");
    }
  };

  const handleClearActiveProfile = async () => {
    try {
      const updated = await invoke<AppConfig>("clear_active_profile", { currentConfig: config });
      setConfig(updated);
    } catch (e) {
      addLog(String(e), "error");
    }
  };

  const testMcpServer = async (name: string) => {
    const server = config.mcp_servers[name];
    if (!server) return;
    setMcpStatusByName((previous) => ({ ...previous, [name]: { state: "starting" } }));
    try {
      const result = await invoke<{
        status: "ready" | "error";
        toolCount: number;
        error?: string | null;
      }>("test_mcp_server", {
        name,
        command: server.command,
        args: server.args || [],
        env: server.env || {},
      });
      setMcpStatusByName((previous) => ({
        ...previous,
        [name]: {
          state: result.status === "ready" ? "ready" : "error",
          toolCount: result.toolCount,
          message: result.error || undefined,
        },
      }));
    } catch (error) {
      setMcpStatusByName((previous) => ({ ...previous, [name]: { state: "error", message: String(error) } }));
    }
  };

  const deleteMcpServer = async (name: string) => {
    try {
      const updated = await invoke<AppConfig>("delete_mcp_server", { currentConfig: config, name });
      setConfig(updated);
      setMcpStatusByName((previous) => {
        const next = { ...previous };
        delete next[name];
        return next;
      });
    } catch (error) {
      addLog(String(error), "error", true);
    }
  };

  const saveConfig = async () => {
    setConfigSaveStatus("saving");
    try {
      await invoke("save_config", { config });
      lastSavedConfigRef.current = JSON.stringify(config);
      setConfigSaveStatus("saved");
      addLog(t("log.configSaved", lang), "success", true);
    } catch (e) {
      setConfigSaveStatus("error");
      addLog(t("log.configFailed", lang) + e, "error", true);
    }
  };

  const toggleTool = (tool: string) => {
    const meta = TOOL_NAMES.find((item) => item.key === tool);
    const wasEnabled = config.tools_enabled.includes(tool);
    setConfig((prev) => ({
      ...prev,
      tools_enabled: prev.tools_enabled.includes(tool)
        ? prev.tools_enabled.filter((t) => t !== tool)
        : [...prev.tools_enabled, tool],
    }));
    addLog(
      t(wasEnabled ? "ui.tool-disabled" : "ui.tool-enabled", lang, { label: meta?.label || tool }),
      wasEnabled ? "info" : "success",
      true
    );
  };

  const removeTrustedPattern = async (toolName: string, pattern: string) => {
    try {
      const updatedConfig = await invoke<AppConfig>("remove_trusted_pattern", {
        currentConfig: config,
        toolName,
        pattern,
      });
      setConfig(updatedConfig);
    } catch (e) {
      addLog(`Failed to remove whitelist pattern: ${e}`, "error");
    }
  };

  return {
    fetchModelList,
    applyPreset,
    handleSaveProfile,
    getModelDisplayName,
    cacheModelDisplayName,
    handleActivateProfile,
    handleDeleteProfile,
    handleClearActiveProfile,
    testMcpServer,
    deleteMcpServer,
    saveConfig,
    toggleTool,
    removeTrustedPattern,
  };
}
