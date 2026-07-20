import { useState, useEffect } from "react";
import { RolePreset } from "../rolePresets";

export function CustomPresetForm({ lang, onSave, t, editingPreset }: { lang: string; onSave: (preset: RolePreset) => void; t: (key: string, lang: string) => string; editingPreset?: RolePreset | null }) {
  const [emoji, setEmoji] = useState(editingPreset?.emoji || "🤖");
  const [name, setName] = useState(editingPreset?.name || "");
  const [prompt, setPrompt] = useState(editingPreset?.prompt || "");
  const [temp, setTemp] = useState(editingPreset?.temperature ?? 0.5);

  useEffect(() => {
    if (editingPreset) {
      setEmoji(editingPreset.emoji || "🤖");
      setName(editingPreset.name || "");
      setPrompt(editingPreset.prompt || "");
      setTemp(editingPreset.temperature ?? 0.5);
    }
  }, [editingPreset]);

  return (
    <div className="role-preset-form-inner">
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          className="role-preset-form-input"
          placeholder={t("role.customEmoji", lang)}
          value={emoji}
          onChange={(e) => setEmoji(e.target.value)}
          style={{ width: 40, textAlign: "center" }}
        />
        <input
          className="role-preset-form-input"
          placeholder={t("role.customName", lang)}
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ flex: 1 }}
        />
      </div>
      <textarea
        className="role-preset-form-textarea"
        placeholder={t("role.customPrompt", lang)}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: "0.7rem", opacity: 0.7 }}>{t("role.customTemp", lang)}: {temp}</span>
        <input type="range" min={0} max={2} step={0.1} value={temp} onChange={(e) => setTemp(parseFloat(e.target.value))} style={{ flex: 1 }} />
      </div>
      <button
        className="btn btn-primary"
        style={{ fontSize: "0.72rem", padding: "4px 12px", width: "100%" }}
        disabled={!name.trim() || !prompt.trim()}
        onClick={() => {
          onSave({
            id: editingPreset?.id || `custom-${Date.now()}`,
            emoji: emoji || "🤖",
            name: name.trim(),
            nameZh: name.trim(),
            description: "",
            descriptionZh: "",
            prompt: prompt.trim(),
            temperature: temp,
            category: "Custom",
          });
        }}
      >
        {t("role.customSave", lang)}
      </button>
    </div>
  );
}
