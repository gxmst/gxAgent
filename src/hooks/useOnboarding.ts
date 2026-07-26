/**
 * First-run onboarding wizard state and flow: initial values derived from the
 * loaded config, connection testing against the chosen endpoint, and the
 * complete/dismiss transitions (including the localStorage "handled" flags).
 *
 * Extracted verbatim from App.tsx. Config, model catalog and session-config
 * patching stay in App and flow in as params.
 */
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import type { AppConfig, ChatSession, ModelInfo, SessionConfig } from "../types";
import type {
  ConnectionCheck,
  OnboardingValues,
} from "../components/onboarding/OnboardingWizard";
import { DEFAULT_CONFIG, modelCatalogKey } from "../appDefaults";
import { notify } from "../services/agentEvents";

export function useOnboarding({
  lang,
  config,
  setConfig,
  configReady,
  lastSavedConfigRef,
  currentSession,
  resolvedCurrentConfig,
  effectiveWorkDir,
  setModels,
  setModelCatalogSourceKey,
  patchSessionConfig,
  setSidebarNav,
}: {
  lang: string;
  config: AppConfig;
  setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
  configReady: boolean;
  lastSavedConfigRef: React.MutableRefObject<string>;
  currentSession: ChatSession;
  resolvedCurrentConfig: AppConfig;
  effectiveWorkDir: string;
  setModels: React.Dispatch<React.SetStateAction<ModelInfo[]>>;
  setModelCatalogSourceKey: React.Dispatch<React.SetStateAction<string | null>>;
  patchSessionConfig: (patch: Partial<SessionConfig>) => void;
  setSidebarNav: React.Dispatch<React.SetStateAction<"chat" | "code">>;
}) {
  const onboardingInitializedRef = useRef(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingConnection, setOnboardingConnection] = useState<ConnectionCheck>({ state: "idle" });
  const [onboardingValues, setOnboardingValues] = useState<OnboardingValues>({
    mode: "chat",
    profileId: null,
    provider: DEFAULT_CONFIG.provider,
    wireFormat: DEFAULT_CONFIG.wire_format,
    baseUrl: DEFAULT_CONFIG.base_url,
    apiKey: DEFAULT_CONFIG.api_key,
    model: DEFAULT_CONFIG.model,
    workDir: DEFAULT_CONFIG.default_work_dir,
  });
  const onboardingValuesRef = useRef(onboardingValues);
  const onboardingTestSequenceRef = useRef(0);
  const currentMode = currentSession.sessionConfig.mode || "chat";

  useEffect(() => {
    if (!configReady || onboardingInitializedRef.current) return;
    onboardingInitializedRef.current = true;

    const initialOnboardingValues: OnboardingValues = {
      mode: currentMode,
      profileId: currentSession.sessionConfig.profileId,
      provider: resolvedCurrentConfig.provider,
      wireFormat: resolvedCurrentConfig.wire_format,
      baseUrl: resolvedCurrentConfig.base_url,
      apiKey: resolvedCurrentConfig.api_key,
      model: resolvedCurrentConfig.model,
      workDir: effectiveWorkDir,
    };
    onboardingValuesRef.current = initialOnboardingValues;
    setOnboardingValues(initialOnboardingValues);

    let onboardingHandled = false;
    try {
      onboardingHandled = localStorage.getItem("gx_onboarding_v1") === "complete"
        || sessionStorage.getItem("gx_onboarding_v1_dismissed") === "true";
    } catch { /* ignore unavailable local storage */ }

    const customConnection = config.base_url !== DEFAULT_CONFIG.base_url
      || config.model !== DEFAULT_CONFIG.model;
    const existingSetup = Object.keys(config.profiles).length > 0
      || config.provider === "ollama"
      || Boolean(config.api_key.trim())
      || customConnection;

    if (existingSetup && !onboardingHandled) {
      try { localStorage.setItem("gx_onboarding_v1", "complete"); } catch { /* ignore */ }
    }
    setOnboardingOpen(!existingSetup && !onboardingHandled);
  }, [configReady, config, currentMode, currentSession.sessionConfig.profileId, effectiveWorkDir, resolvedCurrentConfig]);

  const updateOnboardingValues = (patch: Partial<OnboardingValues>) => {
    const next = { ...onboardingValuesRef.current, ...patch };
    onboardingValuesRef.current = next;
    setOnboardingValues(next);
    onboardingTestSequenceRef.current += 1;
    const connectionChanged = ["profileId", "provider", "wireFormat", "baseUrl", "apiKey", "model"]
      .some((key) => Object.prototype.hasOwnProperty.call(patch, key));
    if (connectionChanged || onboardingConnection.state === "testing") {
      setOnboardingConnection({ state: "idle" });
    }
  };

  const pickOnboardingWorkspace = async () => {
    try {
      const selected = await invoke<string | null>("pick_workspace_directory");
      if (selected) updateOnboardingValues({ workDir: selected });
    } catch (error) {
      notify(`${t("ui.could-not-open-the-folder", lang)}: ${error}`, "error");
    }
  };

  const testOnboardingConnection = async () => {
    const sequence = onboardingTestSequenceRef.current + 1;
    onboardingTestSequenceRef.current = sequence;
    const snapshot = onboardingValuesRef.current;
    setOnboardingConnection({ state: "testing" });
    try {
      const list = snapshot.wireFormat === "ollama"
        ? await invoke<ModelInfo[]>("fetch_ollama_models", { baseUrl: snapshot.baseUrl })
        : await invoke<ModelInfo[]>("fetch_models", {
            wireFormat: snapshot.wireFormat,
            baseUrl: snapshot.baseUrl,
            apiKey: snapshot.apiKey,
          });
      if (onboardingTestSequenceRef.current !== sequence || onboardingValuesRef.current !== snapshot) return;
      setModels(list);
      setModelCatalogSourceKey(modelCatalogKey({
        wire_format: snapshot.wireFormat,
        base_url: snapshot.baseUrl,
      }));
      const selectedModelExists = list.length === 0
        || list.some((model) => model.id === snapshot.model);
      if (!selectedModelExists) {
        setOnboardingConnection({
          state: "error",
          message: t("ui.model-not-in-list", lang, { model: snapshot.model }),
        });
        return;
      }
      setOnboardingConnection({
        state: "success",
        message: list.length > 0
          ? t("ui.endpoint-found-models", lang, { count: String(list.length) })
          : (t("ui.endpoint-ready-the-model-list", lang)),
      });
    } catch (error) {
      if (onboardingTestSequenceRef.current !== sequence || onboardingValuesRef.current !== snapshot) return;
      setOnboardingConnection({ state: "error", message: String(error) });
    }
  };

  const completeOnboarding = async () => {
    if (onboardingConnection.state !== "success") return;
    try {
      if (onboardingValues.mode === "code") {
        await invoke("validate_workspace", { path: onboardingValues.workDir, create: false });
      }

      const nextConfig: AppConfig = {
        ...config,
        provider: onboardingValues.provider,
        wire_format: onboardingValues.wireFormat,
        base_url: onboardingValues.baseUrl.trim(),
        api_key: onboardingValues.apiKey.trim(),
        model: onboardingValues.model.trim(),
        active_profile: onboardingValues.profileId,
        default_work_dir: onboardingValues.mode === "code"
          ? onboardingValues.workDir.trim()
          : config.default_work_dir,
      };
      await invoke("save_config", { config: nextConfig });
      lastSavedConfigRef.current = JSON.stringify(nextConfig);
      setConfig(nextConfig);
      patchSessionConfig({ mode: onboardingValues.mode, profileId: onboardingValues.profileId, model: null, workDir: onboardingValues.mode === "code" ? onboardingValues.workDir.trim() : null });
      setSidebarNav(onboardingValues.mode);
      try { localStorage.setItem("gx_onboarding_v1", "complete"); } catch { /* ignore */ }
      try { sessionStorage.removeItem("gx_onboarding_v1_dismissed"); } catch { /* ignore */ }
      setOnboardingOpen(false);
      notify(t("ui.setup-saved", lang), "success");
    } catch (error) {
      notify(`${t("ui.could-not-save-setup", lang)}: ${error}`, "error");
    }
  };

  const dismissOnboarding = () => {
    try { sessionStorage.setItem("gx_onboarding_v1_dismissed", "true"); } catch { /* ignore */ }
    setOnboardingOpen(false);
  };

  return {
    onboardingOpen,
    onboardingConnection,
    onboardingValues,
    updateOnboardingValues,
    pickOnboardingWorkspace,
    testOnboardingConnection,
    completeOnboarding,
    dismissOnboarding,
  };
}
