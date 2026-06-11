import { Settings as SettingsIcon, X } from 'lucide-react';
import { AppConfig } from '../../types';
import { useState } from 'react';

interface SettingsPanelProps {
  config: AppConfig;
  onSave: (config: AppConfig) => void;
  onClose: () => void;
}

export function SettingsPanel({ config, onSave, onClose }: SettingsPanelProps) {
  const [localConfig, setLocalConfig] = useState(config);

  const handleSave = () => {
    onSave(localConfig);
    onClose();
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <div className="settings-title">
            <SettingsIcon size={20} />
            <h2>设置</h2>
          </div>
          <button className="close-btn" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="settings-content">
          <div className="setting-group">
            <label>API 提供商</label>
            <select
              value={localConfig.provider}
              onChange={(e) => setLocalConfig({ ...localConfig, provider: e.target.value })}
            >
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="custom">自定义</option>
            </select>
          </div>

          <div className="setting-group">
            <label>API 地址</label>
            <input
              type="text"
              value={localConfig.base_url}
              onChange={(e) => setLocalConfig({ ...localConfig, base_url: e.target.value })}
            />
          </div>

          <div className="setting-group">
            <label>API 密钥</label>
            <input
              type="password"
              value={localConfig.api_key}
              onChange={(e) => setLocalConfig({ ...localConfig, api_key: e.target.value })}
            />
          </div>

          <div className="setting-group">
            <label>模型</label>
            <input
              type="text"
              value={localConfig.model}
              onChange={(e) => setLocalConfig({ ...localConfig, model: e.target.value })}
            />
          </div>

          <div className="setting-group">
            <label>主题</label>
            <select
              value={localConfig.theme}
              onChange={(e) => setLocalConfig({ ...localConfig, theme: e.target.value as 'light' | 'dark' })}
            >
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </div>
        </div>

        <div className="settings-footer">
          <button className="cancel-btn" onClick={onClose}>取消</button>
          <button className="save-btn" onClick={handleSave}>保存</button>
        </div>
      </div>
    </div>
  );
}
