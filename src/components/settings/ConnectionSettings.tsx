import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Copy, Loader2, Pencil, Plus, Search, Server, Trash2 } from "lucide-react";
import type { ApiProfile, AppConfig, ModelInfo, ProviderPreset } from "../../types";
import { connectionError, connectionModels, profileFromConfig, profileFromPreset } from "../../utils/connections";
import { sortProfileEntries } from "../../utils/modelSorting";
import { useAppStore } from "../../store/appStore";
import { SecretInput } from "../shared/SecretInput";
import { ModelInput } from "../shared/ModelInput";

const CUSTOM: ApiProfile = { name: "", provider: "openai", wire_format: "openai", base_url: "", api_key: "", default_model: "", models: [] };
export function ConnectionSettings({ config, setConfig, presets, lang, onEditingChange, onBusyChange }: {
  config: AppConfig; setConfig: React.Dispatch<React.SetStateAction<AppConfig>>; presets: ProviderPreset[]; lang: string; onEditingChange: (editing: boolean) => void; onBusyChange: (busy: boolean) => void;
}) {
  const zh = lang === "zh";
  const [draft, setDraft] = useState<ApiProfile | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [makeDefault, setMakeDefault] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [replacement, setReplacement] = useState("");
  const generation = useRef(0);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => () => { generation.current++; }, []);
  const sessions = useAppStore(state => state.sessions);
  const locked = useAppStore(state => Boolean(state.activeRunSessionId || state.preparingRequestSessionId));
  const entries = sortProfileEntries(Object.entries(config.profiles), lang);
  const begin = (profile: ApiProfile, id: string | null = null) => {
    generation.current++; setDraft({ ...profile, models: [...(profile.models || [])] }); setEditingId(id); setMakeDefault(id === config.active_profile || !config.active_profile); setError(""); setStatus(""); setChecking(false); onEditingChange(true);
  };
  const finish = () => { generation.current++; setDraft(null); setDeleting(null); setError(""); setStatus(""); setChecking(false); onEditingChange(false); };
  const patch = (values: Partial<ApiProfile>) => { generation.current++; setDraft(previous => previous ? { ...previous, ...values } : null); setError(""); setStatus(""); setChecking(false); };
  const fetchModels = async () => {
    if (!draft) return;
    const validation = connectionError({ ...draft, name: draft.name || "test", default_model: draft.default_model || "test" }, {}, null, zh);
    if (validation) { setError(validation); return; }
    const currentGeneration = ++generation.current;
    const snapshot = draft;
    setChecking(true); setError(""); setStatus("");
    try {
      const models = snapshot.wire_format === "ollama"
        ? await invoke<ModelInfo[]>("fetch_ollama_models", { baseUrl: snapshot.base_url.trim() })
        : await invoke<ModelInfo[]>("fetch_models", { baseUrl: snapshot.base_url.trim(), apiKey: snapshot.api_key.trim(), wireFormat: snapshot.wire_format });
      if (currentGeneration !== generation.current) return;
      setDraft(previous => previous ? { ...previous, models: models.map(model => model.id), default_model: previous.default_model || models[0]?.id || "" } : null);
      setStatus(zh ? `目录接口可访问，获取到 ${models.length} 个模型。也可手填模型 ID。` : `Model directory reachable: ${models.length} models. You can also enter an ID.`);
    } catch (failure) {
      if (currentGeneration !== generation.current) return;
      setError((zh ? "无法获取目录；仍可手填模型并保存。请检查地址、密钥和网关协议。\n" : "Directory unavailable; you can still enter a model and save. Check the URL, key and protocol.\n") + String(failure));
    } finally { if (currentGeneration === generation.current) setChecking(false); }
  };
  const save = async () => {
    if (!draft || busy || locked) return;
    const validation = connectionError(draft, config.profiles, editingId, zh);
    if (validation) { setError(validation); return; }
    setBusy(true); setError("");
    try {
      const profile = { ...draft, name: draft.name.trim(), api_key: draft.api_key.trim(), base_url: draft.base_url.trim().replace(/\/+$/, ""), default_model: draft.default_model.trim(), models: connectionModels(draft.default_model, draft.models).map(model => model.id) };
      const updated = await invoke<AppConfig>("save_profile", { currentConfig: config, profile, profileId: editingId, setDefault: makeDefault });
      setConfig(updated); finish();
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  };
  const activate = async (id: string) => {
    setBusy(true); setError("");
    try { setConfig(await invoke<AppConfig>("set_active_profile", { currentConfig: config, name: id })); }
    catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!deleting || busy || locked) return;
    setBusy(true); setError("");
    try {
      const updated = await invoke<AppConfig>("delete_profile", { currentConfig: config, name: deleting, replacementId: replacement || null });
      useAppStore.getState().setSessions(previous => previous.map(session => session.sessionConfig.profileId === deleting ? { ...session, sessionConfig: { ...session.sessionConfig, profileId: replacement || null, model: null }, updatedAt: Date.now() } : session));
      setConfig(updated); finish();
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  };
  return <div className="connection-settings settings-wide">
    <div className="settings-section-heading"><div><h4>{zh ? "模型连接" : "Model connections"}</h4><p>{zh ? "每个连接独立保存地址、密钥和模型。输入栏的选择仅影响当前会话。" : "Each connection owns its URL, key and models. Composer selections apply to this conversation."}</p></div>{!draft && !deleting && <button type="button" className="btn btn-primary" disabled={busy || locked} onClick={() => begin(CUSTOM)}><Plus size={16} />{zh ? "添加供应商" : "Add provider"}</button>}</div>
    {draft ? <form className="connection-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
      <h4>{editingId ? (zh ? "编辑连接" : "Edit connection") : (zh ? "添加连接" : "Add connection")}</h4>
      {!editingId && <div className="connection-presets" aria-label={zh ? "连接类型" : "Connection type"}>
        <button type="button" className="connection-preset" disabled={busy} onClick={() => patch(CUSTOM)}><Server size={18} />{zh ? "自定义网关" : "Custom gateway"}</button>
        {presets.map(preset => <button type="button" key={preset.name} className="connection-preset" disabled={busy} onClick={() => patch(profileFromPreset(preset))}>{preset.name}</button>)}
      </div>}
      <div className="connection-form-grid">
        <label className="form-group"><span>{zh ? "连接名称" : "Connection name"}</span><input className="input-text" autoFocus value={draft.name} disabled={busy} onChange={event => patch({ name: event.target.value })} placeholder={zh ? "例如：公司网关" : "e.g. Office gateway"} /></label>
        <label className="form-group"><span>{zh ? "API 地址" : "API base URL"}</span><input className="input-text" value={draft.base_url} disabled={busy} onChange={event => patch({ base_url: event.target.value, api_key: "", models: [] })} placeholder="https://api.example.com/v1" spellCheck={false} /></label>
        <div className="form-group connection-wide"><span id="connection-protocol-label">{zh ? "接口协议" : "API protocol"}</span><div className="connection-protocols" role="group" aria-labelledby="connection-protocol-label">{["openai", "anthropic", "gemini", "ollama"].map(protocol => <button key={protocol} type="button" disabled={busy} aria-pressed={draft.wire_format === protocol} onClick={() => patch({ wire_format: protocol, provider: protocol, models: [] })}>{({ openai: "OpenAI 兼容", anthropic: "Anthropic", gemini: "Gemini", ollama: "Ollama" } as Record<string, string>)[protocol]}</button>)}</div><small>{zh ? "第三方网关通常使用 OpenAI 兼容协议；以网关说明为准。" : "Third-party gateways commonly use OpenAI format. Follow your gateway documentation."}</small></div>
        <div className="form-group"><span id="connection-key-label">{zh ? "API 密钥" : "API key"}</span><SecretInput value={draft.api_key} onChange={value => patch({ api_key: value })} placeholder={draft.wire_format === "ollama" ? (zh ? "本地服务可留空" : "Optional for local servers") : "sk-…"} revealLabel={zh ? "显示密钥" : "Reveal key"} hideLabel={zh ? "隐藏密钥" : "Hide key"} ariaLabel={zh ? "API 密钥" : "API key"} disabled={busy} /></div>
        <div className="form-group"><span>{zh ? "默认模型" : "Default model"}</span><ModelInput label={zh ? "默认模型" : "Default model"} value={draft.default_model} onChange={value => patch({ default_model: value })} models={draft.models || []} placeholder={zh ? "搜索或直接输入模型 ID" : "Search or enter a model ID"} disabled={busy} /></div>
      </div>
      <div className="connection-diagnostics"><button type="button" className="btn" onClick={() => void fetchModels()} disabled={checking || busy || !draft.base_url.trim()}>{checking ? <Loader2 size={15} className="spin" /> : <Search size={15} />}{zh ? "检查连接并获取模型" : "Check connection & fetch models"}</button>{status && <p role="status">{status}</p>}</div>
      <label className="connection-default-choice"><input type="checkbox" checked={makeDefault} disabled={busy} onChange={event => setMakeDefault(event.target.checked)} />{zh ? "设为全局默认连接" : "Set as the global default connection"}</label>
      <div className="connection-editor-actions"><button type="button" className="btn" disabled={busy} onClick={finish}>{zh ? "取消" : "Cancel"}</button><button type="submit" className="btn btn-primary" disabled={busy || checking || locked}>{busy && <Loader2 size={15} className="spin" />}{zh ? "保存连接" : "Save connection"}</button></div>
    </form> : deleting ? <div className="connection-delete">
      <h4>{zh ? "删除连接" : "Delete connection"}: {config.profiles[deleting]?.name}</h4>
      <p>{zh ? `有 ${sessions.filter(session => session.sessionConfig.profileId === deleting).length} 个会话使用此连接。请选择删除后的连接。` : `${sessions.filter(session => session.sessionConfig.profileId === deleting).length} conversations use this connection. Choose their replacement.`}</p>
      <label className="form-group"><span>{zh ? "替换连接" : "Replacement connection"}</span><select aria-label={zh ? "替换连接" : "Replacement connection"} className="input-text" value={replacement} disabled={busy} onChange={event => setReplacement(event.target.value)}><option value="">{config.active_profile === deleting ? (zh ? "保留当前地址与密钥为全局默认" : "Keep current URL and key as global default") : (zh ? "使用全局默认" : "Use global default")}</option>{entries.filter(([id]) => id !== deleting).map(([id, profile]) => <option key={id} value={id}>{profile.name}</option>)}</select></label>
      <div className="connection-editor-actions"><button type="button" className="btn" disabled={busy} onClick={finish}>{zh ? "取消" : "Cancel"}</button><button type="button" className="btn danger" disabled={busy || locked} onClick={() => void remove()}>{zh ? "确认删除" : "Confirm deletion"}</button></div>
    </div> : <>
      <div className="connection-current"><Check size={17} /><div><strong>{zh ? "全局默认" : "Global default"}: {config.active_profile ? config.profiles[config.active_profile]?.name : (zh ? "独立配置" : "Standalone connection")}</strong><span>{config.model} · {config.base_url}</span></div>{!config.active_profile && <button type="button" className="btn" disabled={busy || locked} onClick={() => begin({ ...profileFromConfig(config), name: zh ? "默认连接" : "Default connection" })}>{zh ? "保存为连接" : "Save as a connection"}</button>}</div>
      {!!entries.length && <label className="connection-search"><Search size={16} /><input aria-label={zh ? "搜索连接" : "Search connections"} placeholder={zh ? "搜索供应商、地址或模型" : "Search providers, URLs or models"} value={search} onChange={event => setSearch(event.target.value)} /></label>}
      <div className="connection-list">{entries.filter(([, profile]) => `${profile.name} ${profile.base_url} ${profile.default_model}`.toLowerCase().includes(search.toLowerCase())).map(([id, profile]) => <div className={`connection-card ${config.active_profile === id ? "active" : ""}`} key={id}>
        <div className="connection-card-icon"><Server size={20} /></div><div className="connection-card-info"><strong>{profile.name}{config.active_profile === id && <small>{zh ? "默认" : "Default"}</small>}</strong><span>{profile.default_model}</span><small>{profile.base_url}</small></div>
        <div className="connection-card-actions">{config.active_profile !== id && <button type="button" className="btn" disabled={busy || locked} onClick={() => void activate(id)}>{zh ? "设为默认" : "Set default"}</button>}
          <button type="button" className="btn btn-icon" disabled={busy || locked} aria-label={`${zh ? "编辑" : "Edit"} ${profile.name}`} title={zh ? "编辑" : "Edit"} onClick={() => begin(profile, id)}><Pencil size={16} /></button>
          <button type="button" className="btn btn-icon" disabled={busy || locked} aria-label={`${zh ? "复制" : "Copy"} ${profile.name}`} title={zh ? "复制" : "Copy"} onClick={() => begin({ ...profile, name: `${profile.name} ${zh ? "副本" : "copy"}`, api_key: "" })}><Copy size={16} /></button>
          <button type="button" className="btn btn-icon danger" disabled={busy || locked} aria-label={`${zh ? "删除" : "Delete"} ${profile.name}`} title={zh ? "删除" : "Delete"} onClick={() => { setDeleting(id); setReplacement(""); setError(""); onEditingChange(true); }}><Trash2 size={16} /></button>
        </div>
      </div>)}</div>
      {!entries.length && <div className="connection-empty"><Server size={26} /><p>{zh ? "添加你的第一个供应商或 AI 网关" : "Add your first provider or AI gateway"}</p></div>}
    </>}
    {locked && <p className="form-hint">{zh ? "任务运行期间暂不能修改连接。" : "Connections cannot be changed during a running task."}</p>}
    {error && <p className="connection-error" role="alert">{error}</p>}
  </div>;
}
