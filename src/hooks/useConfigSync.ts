import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppConfig, ModelInfo, ProviderPreset } from "../types";
import {
  DEFAULT_CONFIG,
  FONT_OPTIONS,
  normalizeTheme,
  themeMode,
} from "../appDefaults";

/**
 * Synchronizes global AppConfig and provider presets with the Rust backend,
 * debounces auto-saves, and keeps document theme/language/font attributes aligned.
 */
export function useConfigSync() {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [configReady, setConfigReady] = useState(false);
  const [configSaveStatus, setConfigSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const lastSavedConfigRef = useRef("");
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelCatalogSourceKey, setModelCatalogSourceKey] = useState<string | null>(null);
  const [, setModelsLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [loadedConfig, loadedPresets] = await Promise.all([
          invoke<AppConfig>("load_config"),
          invoke<ProviderPreset[]>("get_provider_presets"),
        ]);
        const nextConfig = { ...DEFAULT_CONFIG, ...loadedConfig };
        lastSavedConfigRef.current = JSON.stringify(nextConfig);
        setConfig(nextConfig);
        setPresets(loadedPresets);
      } catch (error) {
        console.error("Failed to load config:", error);
        try {
          const loadedPresets = await invoke<ProviderPreset[]>("get_provider_presets");
          setPresets(loadedPresets);
        } catch { /* ignore */ }
      } finally {
        setConfigReady(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!configReady) return;
    const serialized = JSON.stringify(config);
    if (serialized === lastSavedConfigRef.current) return;

    setConfigSaveStatus("saving");
    const timer = window.setTimeout(async () => {
      try {
        await invoke("save_config", { config });
        lastSavedConfigRef.current = serialized;
        setConfigSaveStatus("saved");
      } catch (error) {
        console.error("Failed to auto-save config:", error);
        setConfigSaveStatus("error");
      }
    }, 650);
    return () => window.clearTimeout(timer);
  }, [config, configReady]);

  useEffect(() => {
    const normalized = normalizeTheme(config.theme || "light");
    const apply = () => {
      const mode = themeMode(normalized);
      document.documentElement.setAttribute("data-theme", mode);
      document.documentElement.setAttribute("data-mode", mode);
      document.documentElement.style.backgroundColor = mode === "dark" ? "#111215" : "#f6f7f9";
      try {
        localStorage.setItem("gx_theme", normalized);
        localStorage.setItem("gx_theme_mode", mode);
      } catch { /* ignore */ }
    };
    apply();
    if (normalized !== "system" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [config.theme]);

  useEffect(() => {
    document.documentElement.lang = config.language || "zh";
  }, [config.language]);

  useEffect(() => {
    document.documentElement.style.setProperty("--dynamic-font-size", `${config.font_size || 14}px`);
  }, [config.font_size]);

  useEffect(() => {
    const selected = FONT_OPTIONS.find((font) => font.value === (config.font_family || "system")) || FONT_OPTIONS[0];
    document.documentElement.style.setProperty("--app-font-family", selected.css);
  }, [config.font_family]);

  return {
    config,
    setConfig,
    configReady,
    configSaveStatus,
    setConfigSaveStatus,
    lastSavedConfigRef,
    presets,
    models,
    setModels,
    modelCatalogSourceKey,
    setModelCatalogSourceKey,
    setModelsLoading,
  };
}
