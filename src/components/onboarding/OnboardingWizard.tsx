import { useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  FolderOpen,
  Loader2,
  MessageSquare,
  PlugZap,
  Terminal,
} from "lucide-react";
import type { ApiProfile, ModelInfo } from "../../types";

export interface OnboardingValues {
  mode: "chat" | "code";
  profileId: string | null;
  provider: string;
  wireFormat: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  workDir: string;
}

export interface OnboardingProfile extends ApiProfile {
  id: string;
}

export type ConnectionCheck =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "success"; message: string }
  | { state: "error"; message: string };

interface OnboardingWizardProps {
  open: boolean;
  lang: string;
  values: OnboardingValues;
  profiles: OnboardingProfile[];
  models: ModelInfo[];
  connection: ConnectionCheck;
  onChange: (patch: Partial<OnboardingValues>) => void;
  onPickWorkspace: () => void | Promise<void>;
  onTestConnection: () => void | Promise<void>;
  onComplete: () => void | Promise<void>;
  onClose?: () => void;
}

export function OnboardingWizard({
  open,
  lang,
  values,
  profiles,
  models,
  connection,
  onChange,
  onPickWorkspace,
  onTestConnection,
  onComplete,
  onClose,
}: OnboardingWizardProps) {
  const [step, setStep] = useState(0);
  const [revealKey, setRevealKey] = useState(false);
  const zh = lang === "zh";

  if (!open) return null;

  const steps = [
    zh ? "使用方式" : "Mode",
    zh ? "模型连接" : "Model",
    zh ? "工作区" : "Workspace",
  ];
  const connectionReady = Boolean(values.baseUrl.trim() && values.model.trim());
  const workspaceReady = values.mode === "chat" || Boolean(values.workDir.trim());
  const canComplete = connectionReady && workspaceReady && connection.state === "success";

  const connectionTypes = [
    {
      id: "openai",
      label: zh ? "OpenAI 兼容" : "OpenAI compatible",
      wireFormat: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
    },
    {
      id: "anthropic",
      label: "Anthropic",
      wireFormat: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-5",
    },
    {
      id: "gemini",
      label: "Gemini",
      wireFormat: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-2.5-flash",
    },
    {
      id: "ollama",
      label: "Ollama",
      wireFormat: "ollama",
      baseUrl: "http://localhost:11434",
      model: "llama3.2",
    },
  ];

  const selectProfile = (profileId: string) => {
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) {
      onChange({ profileId: null });
      return;
    }
    onChange({
      profileId: profile.id,
      provider: profile.provider,
      wireFormat: profile.wire_format,
      baseUrl: profile.base_url,
      apiKey: profile.api_key,
      model: profile.default_model,
    });
  };

  const selectConnectionType = (provider: string) => {
    const option = connectionTypes.find((item) => item.id === provider);
    if (!option) return;
    onChange({
      profileId: null,
      provider: option.id,
      wireFormat: option.wireFormat,
      baseUrl: option.baseUrl,
      model: option.model,
      apiKey: option.id === "ollama" ? "" : values.apiKey,
    });
  };

  return (
    <div className="onboarding-overlay">
      <section
        className="onboarding-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
      >
        <header className="onboarding-header">
          <div>
            <span className="onboarding-product">gxAgent</span>
            <h1 id="onboarding-title">{zh ? "完成首次设置" : "Complete setup"}</h1>
          </div>
          {onClose && (
            <button className="btn btn-secondary" onClick={onClose}>
              {zh ? "稍后" : "Later"}
            </button>
          )}
        </header>

        <div className="onboarding-steps" role="tablist" aria-label={zh ? "设置步骤" : "Setup steps"}>
          {steps.map((label, index) => (
            <button
              key={label}
              role="tab"
              aria-selected={step === index}
              className={`onboarding-step ${step === index ? "active" : ""} ${step > index ? "complete" : ""}`}
              onClick={() => setStep(index)}
            >
              <span>{step > index ? <Check size={13} /> : index + 1}</span>
              {label}
            </button>
          ))}
        </div>

        <div className="onboarding-body">
          {step === 0 && (
            <div className="onboarding-pane">
              <h2>{zh ? "你主要想让 gxAgent 做什么？" : "How will you use gxAgent?"}</h2>
              <div className="onboarding-mode-grid">
                <button
                  className={`onboarding-mode ${values.mode === "chat" ? "active" : ""}`}
                  onClick={() => onChange({ mode: "chat" })}
                >
                  <MessageSquare size={20} />
                  <strong>{zh ? "对话" : "Chat"}</strong>
                </button>
                <button
                  className={`onboarding-mode ${values.mode === "code" ? "active" : ""}`}
                  onClick={() => onChange({ mode: "code" })}
                >
                  <Terminal size={20} />
                  <strong>{zh ? "编程任务" : "Coding"}</strong>
                </button>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="onboarding-pane">
              <h2>{zh ? "连接一个模型" : "Connect a model"}</h2>
              {profiles.length > 0 && (
                <label className="onboarding-field">
                  <span>{zh ? "已保存的 Profile" : "Saved profile"}</span>
                  <select value={values.profileId || ""} onChange={(event) => selectProfile(event.target.value)}>
                    <option value="">{zh ? "手动配置" : "Manual configuration"}</option>
                    {profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>{profile.name}</option>
                    ))}
                  </select>
                </label>
              )}
              <label className="onboarding-field">
                <span>{zh ? "连接类型" : "Connection type"}</span>
                <select value={values.provider} onChange={(event) => selectConnectionType(event.target.value)}>
                  {connectionTypes.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className="onboarding-field">
                <span>Base URL</span>
                <input
                  value={values.baseUrl}
                  onChange={(event) => onChange({ profileId: null, baseUrl: event.target.value })}
                  placeholder="https://api.deepseek.com/v1"
                />
              </label>
              <label className="onboarding-field">
                <span>API Key</span>
                <div className="onboarding-secret">
                  <input
                    type={revealKey ? "text" : "password"}
                    value={values.apiKey}
                    onChange={(event) => onChange({ profileId: null, apiKey: event.target.value })}
                    placeholder="sk-..."
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setRevealKey((current) => !current)}
                    aria-label={revealKey ? (zh ? "隐藏密钥" : "Hide key") : (zh ? "显示密钥" : "Show key")}
                  >
                    {revealKey ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </label>
              <label className="onboarding-field">
                <span>{zh ? "模型" : "Model"}</span>
                <input
                  list="onboarding-models"
                  value={values.model}
                  onChange={(event) => onChange({ profileId: null, model: event.target.value })}
                  placeholder="deepseek-chat"
                />
                <datalist id="onboarding-models">
                  {models.map((model) => <option key={model.id} value={model.id} />)}
                </datalist>
              </label>
            </div>
          )}

          {step === 2 && (
            <div className="onboarding-pane">
              <h2>{values.mode === "code" ? (zh ? "选择工作区" : "Choose a workspace") : (zh ? "检查连接" : "Check connection")}</h2>
              {values.mode === "code" && (
                <label className="onboarding-field">
                  <span>{zh ? "项目文件夹" : "Project folder"}</span>
                  <div className="onboarding-workspace-row">
                    <input
                      value={values.workDir}
                      onChange={(event) => onChange({ workDir: event.target.value })}
                      placeholder="C:\\Users\\you\\project"
                    />
                    <button className="btn btn-secondary" onClick={onPickWorkspace} title={zh ? "选择文件夹" : "Choose folder"}>
                      <FolderOpen size={15} />
                    </button>
                  </div>
                </label>
              )}
              <div className={`onboarding-connection ${connection.state}`} role="status">
                <PlugZap size={18} />
                <div>
                  <strong>{zh ? "模型连接" : "Model connection"}</strong>
                  <span>
                    {connection.state === "idle" && (zh ? "发送测试请求前不会保存设置" : "Settings are saved after a successful check")}
                    {connection.state === "testing" && (zh ? "正在验证 API 端点..." : "Checking API endpoint...")}
                    {(connection.state === "success" || connection.state === "error") && connection.message}
                  </span>
                </div>
                <button
                  className="btn btn-secondary"
                  onClick={onTestConnection}
                  disabled={!connectionReady || connection.state === "testing"}
                >
                  {connection.state === "testing" ? <Loader2 size={14} className="animate-spin" /> : null}
                  {zh ? "测试" : "Test"}
                </button>
              </div>
            </div>
          )}
        </div>

        <footer className="onboarding-footer">
          <button className="btn btn-secondary" onClick={() => setStep((current) => Math.max(0, current - 1))} disabled={step === 0}>
            <ChevronLeft size={14} /> {zh ? "上一步" : "Back"}
          </button>
          {step < steps.length - 1 ? (
            <button className="btn btn-primary" onClick={() => setStep((current) => Math.min(steps.length - 1, current + 1))}>
              {zh ? "下一步" : "Next"} <ChevronRight size={14} />
            </button>
          ) : (
            <button className="btn btn-primary" onClick={onComplete} disabled={!canComplete}>
              <Check size={14} /> {zh ? "开始使用" : "Start"}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
