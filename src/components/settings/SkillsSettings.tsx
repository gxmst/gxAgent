import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FolderPlus, RefreshCw, X } from "lucide-react";
import type { AppConfig, Skill } from "../../types";
import { learningConfig } from "../../utils/learning";

export function SkillsSettings({
  config,
  setConfig,
  lang,
}: {
  config: AppConfig;
  setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
  lang: string;
}) {
  const zh = lang === "zh";
  const settings = learningConfig(config);
  const [catalog, setCatalog] = useState<{ skills: Skill[]; errors: string[] }>(
    { skills: [], errors: [] },
  );
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [resource, setResource] = useState<{
    key: string;
    text: string;
  } | null>(null);
  const rootsKey = JSON.stringify([
    settings.skill_roots,
    config.default_work_dir,
    Object.keys(config.mcp_servers),
  ]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    invoke<typeof catalog>("list_skills", { config })
      .then((value) => {
        if (active) setCatalog(value);
      })
      .catch((e) => {
        if (active) setError(String(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [rootsKey, refresh]);
  const toggle = (id: string) =>
    setConfig((previous) => {
      const state = learningConfig(previous);
      return {
        ...previous,
        learning: {
          ...state,
          enabled_skills: state.enabled_skills.includes(id)
            ? state.enabled_skills.filter((s) => s !== id)
            : [...state.enabled_skills, id],
        },
      };
    });
  return (
    <section
      className="settings-page lab-surface"
      role="tabpanel"
      id="settings-panel-skills"
      aria-labelledby="settings-tab-skills"
    >
      <div className="lab-toolbar">
        <h4>Skills</h4>
        <button
          className="btn"
          disabled={loading}
          onClick={() => setRefresh((r) => r + 1)}
        >
          <RefreshCw size={14} />
          {zh ? "刷新" : "Refresh"}
        </button>
        <button
          className="btn"
          onClick={async () => {
            try {
              const path = await invoke<string | null>(
                "pick_workspace_directory",
              );
              if (path)
                setConfig((p) => {
                  const s = learningConfig(p);
                  return {
                    ...p,
                    learning: {
                      ...s,
                      skill_roots: [...new Set([...s.skill_roots, path])],
                    },
                  };
                });
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          <FolderPlus size={14} />
          {zh ? "添加目录" : "Add directory"}
        </button>
      </div>
      <p className="lab-path">{config.default_work_dir}</p>
      {settings.skill_roots.map((path) => (
        <div className="lab-row" key={path}>
          <span className="lab-path">{path}</span>
          <button
            className="panel-toggle-btn"
            title={zh ? "移除目录" : "Remove directory"}
            aria-label={zh ? "移除目录" : "Remove directory"}
            onClick={() =>
              setConfig((p) => ({
                ...p,
                learning: {
                  ...learningConfig(p),
                  skill_roots: learningConfig(p).skill_roots.filter(
                    (r) => r !== path,
                  ),
                },
              }))
            }
          >
            <X size={14} />
          </button>
        </div>
      ))}
      {loading && (
        <p role="status">{zh ? "读取技能中..." : "Loading skills..."}</p>
      )}
      {error && (
        <p role="alert" className="lab-error">
          {error}
        </p>
      )}
      {catalog.errors.map((e) => (
        <p className="lab-error" key={e}>
          {e}
        </p>
      ))}
      {!loading && !catalog.skills.length && (
        <p className="lab-muted">
          {zh ? "未找到 SKILL.md" : "No SKILL.md found"}
        </p>
      )}
      {catalog.skills.map((skill) => (
        <div className="skill-row" key={skill.id}>
          <label>
            <input
              type="checkbox"
              checked={settings.enabled_skills.includes(skill.id)}
              disabled={
                skill.missingDependencies.length > 0 &&
                !settings.enabled_skills.includes(skill.id)
              }
              onChange={() => toggle(skill.id)}
            />
            <strong>{skill.name}</strong>
            <small>
              {skill.scope === "project"
                ? zh
                  ? "项目"
                  : "Project"
                : zh
                  ? "全局"
                  : "Global"}
            </small>
          </label>
          <p>{skill.description}</p>
          <p className="lab-path">{skill.path}</p>
          {skill.dependencies.length > 0 && (
            <p>MCP: {skill.dependencies.join(", ")}</p>
          )}
          {skill.missingDependencies.length > 0 && (
            <p className="lab-error">
              {zh ? "缺少服务：" : "Missing servers: "}
              {skill.missingDependencies.join(", ")}
            </p>
          )}
          <details className="context-entry">
            <summary>SKILL.md</summary>
            <pre>{skill.body}</pre>
          </details>
          {skill.resources.length > 0 && (
            <details className="context-entry">
              <summary>
                {zh ? "脚本与参考资料" : "Scripts & references"} ·{" "}
                {skill.resources.length}
              </summary>
              {skill.resources.map((file) => (
                <div key={file}>
                  <button
                    className="lab-resource"
                    onClick={async () => {
                      try {
                        const text = await invoke<string>(
                          "read_skill_resource",
                          { config, skillId: skill.id, resource: file },
                        );
                        setResource({ key: `${skill.id}:${file}`, text });
                      } catch (e) {
                        setError(String(e));
                      }
                    }}
                  >
                    {file}
                  </button>
                  {resource?.key === `${skill.id}:${file}` && (
                    <pre>{resource.text}</pre>
                  )}
                </div>
              ))}
            </details>
          )}
        </div>
      ))}
    </section>
  );
}
