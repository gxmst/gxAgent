import { useState } from "react";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { ROLE_PRESETS, type RolePreset } from "../../rolePresets";
import type { ChatSession, SessionConfig } from "../../types";
import { useAppStore } from "../../store/appStore";
import { CustomPresetForm } from "../CustomPresetForm";
import { t } from "../../i18n";

export function RolePresetManager({ lang, session, customPresets, setCustomPresets, onChange }: {
  lang: string;
  session: ChatSession;
  customPresets: RolePreset[];
  setCustomPresets: React.Dispatch<React.SetStateAction<RolePreset[]>>;
  onChange: (patch: Partial<SessionConfig>) => void;
}) {
  const zh = lang === "zh";
  const [editing, setEditing] = useState<RolePreset | null | undefined>();
  const setSessions = useAppStore(state => state.setSessions);
  const selected = customPresets.find(preset => preset.id === session.sessionConfig.activeRolePresetId);
  return <div className="session-role-settings">
    <label className="session-field"><span className="session-label">{zh ? "角色模板" : "Role preset"}</span>
      <select className="session-select" value={session.sessionConfig.activeRolePresetId || ""} onChange={event => {
        const preset = [...ROLE_PRESETS, ...customPresets].find(item => item.id === event.target.value);
        onChange({ activeRolePresetId: preset?.id || null, systemPrompt: preset?.prompt || null, temperature: preset?.temperature ?? null });
      }}>
        <option value="">{zh ? "无角色模板" : "No role preset"}</option>
        <optgroup label={zh ? "内置" : "Built-in"}>{ROLE_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{zh ? preset.nameZh : preset.name}</option>)}</optgroup>
        {!!customPresets.length && <optgroup label={zh ? "自定义" : "Custom"}>{customPresets.map(preset => <option key={preset.id} value={preset.id}>{zh ? preset.nameZh : preset.name}</option>)}</optgroup>}
      </select>
    </label>
    <div className="session-role-actions">
      <button className="btn" onClick={() => setEditing(null)}><Plus size={13} />{zh ? "新建模板" : "New preset"}</button>
      {selected && <><button className="panel-toggle-btn" onClick={() => setEditing(selected)} title={zh ? "编辑模板" : "Edit preset"} aria-label={zh ? "编辑模板" : "Edit preset"}><Pencil size={13} /></button>
        <button className="panel-toggle-btn" title={zh ? "删除模板" : "Delete preset"} aria-label={zh ? "删除模板" : "Delete preset"} onClick={() => {
          setSessions(sessions => sessions.map(item => item.sessionConfig.activeRolePresetId === selected.id ? { ...item, sessionConfig: { ...item.sessionConfig, activeRolePresetId: null, systemPrompt: null, temperature: null } } : item));
          setCustomPresets(presets => presets.filter(preset => preset.id !== selected.id));
          setEditing(undefined);
        }}><Trash2 size={13} /></button></>}
    </div>
    {editing !== undefined && <div className="session-preset-editor"><button className="panel-toggle-btn" onClick={() => setEditing(undefined)} aria-label={zh ? "关闭模板编辑" : "Close preset editor"}><X size={13} /></button><CustomPresetForm lang={lang} editingPreset={editing} t={t} onSave={preset => {
      setCustomPresets(presets => presets.some(item => item.id === preset.id) ? presets.map(item => item.id === preset.id ? preset : item) : [...presets, preset]);
      setEditing(undefined);
    }} /></div>}
  </div>;
}
