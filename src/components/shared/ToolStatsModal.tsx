/**
 * Tool-usage statistics dialog (per-session or all-sessions), opened from the
 * sidebar context menu or the global context menu.
 *
 * Extracted verbatim from App.tsx. The dialog payload stays App state because
 * the sidebar and the global context menu both set it.
 */
import { BarChart3 } from "lucide-react";
import { t } from "../../i18n";
import type { ToolStatsDialog } from "../../appDefaults";

export interface ToolStatsModalProps {
  lang: string;
  toolStatsDialog: ToolStatsDialog;
  setToolStatsDialog: React.Dispatch<React.SetStateAction<ToolStatsDialog | null>>;
}

export function ToolStatsModal({ lang, toolStatsDialog, setToolStatsDialog }: ToolStatsModalProps) {
  const toolStatsEntries = Object.entries(toolStatsDialog.stats).sort((a, b) => b[1] - a[1]);
  const toolStatsTotal = toolStatsEntries.reduce((sum, [, count]) => sum + count, 0);
  const toolStatsMax = toolStatsEntries[0]?.[1] || 0;

  return (
    <div className="modal-overlay" onMouseDown={(e) => {
      if (e.target === e.currentTarget) {
        setToolStatsDialog(null);
      }
    }}>
      <div className="modal-content stats-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="stats-modal-title">
            <BarChart3 size={15} /> {t("stats.title", lang)}
          </h3>
          <button className="btn" style={{ padding: "3px 8px", fontSize: "var(--font-caption)" }} onClick={() => setToolStatsDialog(null)}>
            {t("settings.close", lang)}
          </button>
        </div>
        <div className="modal-body stats-modal-body">
          <div className="stats-summary">
            <span>{toolStatsDialog.title}</span>
            <strong>{t("stats.total", lang, { count: String(toolStatsTotal) })}</strong>
          </div>
          {toolStatsEntries.length > 0 ? (
            <div className="stats-list">
              {toolStatsEntries.map(([name, count]) => (
                <div className="stats-row" key={name}>
                  <div className="stats-row-header">
                    <span className="stats-tool-name">{name}</span>
                    <span className="stats-tool-count">{t("stats.count", lang, { count: String(count) })}</span>
                  </div>
                  <div className="stats-meter">
                    <span style={{ width: `${Math.max(4, Math.round((count / toolStatsMax) * 100))}%` }} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="stats-empty">{t("stats.empty", lang)}</div>
          )}
        </div>
      </div>
    </div>
  );
}
