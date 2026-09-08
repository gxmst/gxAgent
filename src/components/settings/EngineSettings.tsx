import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, PlugZap } from "lucide-react";
import type { AppConfig } from "../../types";
import { useCodexStore, type CodexModel } from "../../store/codexStore";

const EMPTY_MODELS: CodexModel[] = [];

export function EngineSettings({ lang, config, setConfig }: { lang: string; config: AppConfig; setConfig: React.Dispatch<React.SetStateAction<AppConfig>> }) {
  const zh = lang === "zh";
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<{ success: boolean; text: string } | null>(null);
  const models = useCodexStore(state => state.executable === config.codex_executable ? state.models : EMPTY_MODELS);
  return <div className="engine-settings settings-wide">
    <label className="form-group"><span className="form-label">{zh ? "编码引擎" : "Coding engine"}</span><select className="input-text" value={config.code_engine || "native"} onChange={event => setConfig(previous => ({ ...previous, code_engine: event.target.value as AppConfig["code_engine"] }))}><option value="native">gxAgent</option><option value="codex">Codex</option></select></label>
    <label className="form-group"><span className="form-label">{zh ? "Codex 可执行文件" : "Codex executable"}</span><input className="input-text" value={config.codex_executable || "codex"} onChange={event => { setStatus(null); setConfig(previous => ({ ...previous, codex_executable: event.target.value })); }} spellCheck={false} /></label>
    <label className="form-group"><span className="form-label">{zh ? "Codex 默认模型" : "Default Codex model"}</span><input className="input-text" list="codex-model-catalog" placeholder={zh ? "继承 Codex 默认" : "Inherit Codex default"} value={config.codex_model || ""} onChange={event => setConfig(previous => ({ ...previous, codex_model: event.target.value }))} /><datalist id="codex-model-catalog">{models.map(model => <option key={model.id} value={model.model}>{model.displayName}</option>)}</datalist></label>
    <button className="btn" disabled={checking} onClick={async () => {
      setChecking(true); setStatus(null);
      const executable = config.codex_executable || "codex";
      try {
        const result = await invoke<{ authenticated: boolean; models: CodexModel[] }>("inspect_codex", { executable });
        useCodexStore.setState({ executable, models: result.models || [] });
        setStatus({ success: result.authenticated, text: result.authenticated ? (zh ? "已连接，登录有效" : "Connected and authenticated") : (zh ? "已连接，Codex 尚未登录" : "Connected; Codex login required") });
      } catch (error) { setStatus({ success: false, text: String(error) }); }
      finally { setChecking(false); }
    }}>{checking ? <Loader2 size={14} className="spin" /> : <PlugZap size={14} />}{zh ? "检查 Codex 连接" : "Check Codex connection"}</button>
    {status && <div className={`engine-connection ${status.success ? "success" : "error"}`} role="status">{status.text}</div>}
  </div>;
}
