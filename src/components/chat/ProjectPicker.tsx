import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Popover } from "radix-ui";
import { ChevronDown, FolderOpen, FolderPlus, GitBranch } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { groupProjectSessions, projectName } from "../../utils/workbench";
import { notify } from "../../services/agentEvents";

export function ProjectPicker({ lang, workDir, branch, disabled, onSelect }: {
  lang: string; workDir: string; branch: string; disabled: boolean; onSelect: (path: string) => void;
}) {
  const zh = lang === "zh";
  const sessions = useAppStore(state => state.sessions);
  const [open, setOpen] = useState(false);
  const projects = groupProjectSessions(sessions.filter(session => session.sessionConfig.mode === "code"), workDir);
  return <div className="composer-project-row">
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild><button disabled={disabled} className="composer-project" title={workDir} aria-label={zh ? "选择项目" : "Choose project"}><FolderOpen size={16} /><span>{projectName(workDir) || (zh ? "选择项目" : "Choose project")}</span><ChevronDown size={12} /></button></Popover.Trigger>
      <Popover.Portal><Popover.Content className="workbench-popover project-menu" side="top" align="start" collisionPadding={12} sideOffset={8}>
        {projects.filter(project => project.workDir).map(project => <button className="model-menu-item" key={project.id} onClick={() => { onSelect(project.workDir); setOpen(false); }}><span>{project.name}</span><small>{project.workDir}</small></button>)}
        <button className="project-menu-open" onClick={async () => {
          try { const path = await invoke<string | null>("pick_workspace_directory"); if (path) { onSelect(path); setOpen(false); } }
          catch (error) { notify(String(error), "error"); }
        }}><FolderPlus size={15} />{zh ? "打开其他项目" : "Open another project"}</button>
      </Popover.Content></Popover.Portal>
    </Popover.Root>
    {branch && <span className="composer-branch" title={branch}><GitBranch size={13} /><span>{branch}</span></span>}
  </div>;
}
