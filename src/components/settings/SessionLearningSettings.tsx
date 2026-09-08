import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppConfig, SessionConfig, Skill } from "../../types";
import { learningConfig } from "../../utils/learning";

export function SessionLearningSettings({
  config,
  session,
  patch,
  lang,
}: {
  config: AppConfig;
  session: SessionConfig;
  patch: (value: Partial<SessionConfig>) => void;
  lang: string;
}) {
  const zh = lang === "zh";
  const [skills, setSkills] = useState<Skill[]>([]);
  const [error, setError] = useState("");
  const workDir = session.workDir || config.default_work_dir;
  const key = JSON.stringify([
    workDir,
    config.learning?.skill_roots,
    Object.keys(config.mcp_servers),
  ]);
  useEffect(() => {
    let active = true;
    invoke<{ skills: Skill[] }>("list_skills", {
      config: { ...config, default_work_dir: workDir },
    })
      .then((result) => {
        if (active) setSkills(result.skills);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [key]);
  const selected = session.skillIds || learningConfig(config).enabled_skills;
  return (
    <section className="lab-section">
      <h4>{zh ? "知识与技能" : "Knowledge & skills"}</h4>
      <label className="lab-field">
        {zh ? "回答前检索" : "Retrieve before answering"}
        <select
          value={
            session.knowledgeEnabled === undefined
              ? "inherit"
              : String(session.knowledgeEnabled)
          }
          onChange={(e) =>
            patch({
              knowledgeEnabled:
                e.target.value === "inherit"
                  ? undefined
                  : e.target.value === "true",
            })
          }
        >
          <option value="inherit">{zh ? "继承全局" : "Inherit"}</option>
          <option value="true">{zh ? "启用" : "On"}</option>
          <option value="false">{zh ? "关闭" : "Off"}</option>
        </select>
      </label>
      <label className="lab-check">
        <input
          type="checkbox"
          checked={session.skillIds === undefined}
          onChange={(e) =>
            patch({ skillIds: e.target.checked ? undefined : [...selected] })
          }
        />
        {zh ? "继承全局技能选择" : "Inherit skill selection"}
      </label>
      {error && (
        <p className="lab-error" role="alert">
          {error}
        </p>
      )}
      {skills.map((skill) => (
        <label className="lab-check" key={skill.id}>
          <input
            type="checkbox"
            checked={selected.includes(skill.id)}
            disabled={
              session.skillIds === undefined ||
              (skill.missingDependencies.length > 0 &&
                !selected.includes(skill.id))
            }
            onChange={() =>
              patch({
                skillIds: selected.includes(skill.id)
                  ? selected.filter((id) => id !== skill.id)
                  : [...selected, skill.id],
              })
            }
          />
          {skill.name}
        </label>
      ))}
    </section>
  );
}
