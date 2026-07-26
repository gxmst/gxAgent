/**
 * Workspace-panel actions: open a file in the viewer, attach a workspace file
 * to the composer, show a git diff, restore a file from git, and accept or
 * roll back the per-run git checkpoint.
 *
 * Extracted verbatim from App.tsx. Workspace/file/checkpoint state lives in
 * the zustand store; attachment state comes from useAttachments via params.
 */
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import type { Attachment } from "../types";
import type { DirectoryNode } from "../components/workspace/WorkspaceTree";
import type { GitStatusEntry } from "../components/workspace/WorkspaceChanges";
import type { ConfirmationOptions } from "../components/shared/ConfirmDialog";
import {
  MAX_ATTACHMENT_TEXT_PER_FILE,
  createEmptyWorkspaceState,
  fitAttachmentBudget,
  resolveWorkspacePath,
} from "../appDefaults";
import { useAppStore } from "../store/appStore";
import { runtime } from "../services/agentRuntime";
import { addLog, notify, refreshWorkspace } from "../services/agentEvents";

export function useWorkspaceActions({
  lang,
  effectiveWorkDir,
  sessionMutationLocked,
  requestConfirmation,
  setDiffView,
  attachmentsBySession,
  setAttachmentsBySession,
  attachmentLoadingBySession,
  setAttachmentLoadingBySession,
  reportAttachmentFit,
}: {
  lang: string;
  effectiveWorkDir: string;
  sessionMutationLocked: boolean;
  requestConfirmation: (options: ConfirmationOptions) => Promise<boolean>;
  setDiffView: React.Dispatch<React.SetStateAction<boolean>>;
  attachmentsBySession: Record<string, Attachment[]>;
  setAttachmentsBySession: React.Dispatch<React.SetStateAction<Record<string, Attachment[]>>>;
  attachmentLoadingBySession: Record<string, boolean>;
  setAttachmentLoadingBySession: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  reportAttachmentFit: (
    fitted: ReturnType<typeof fitAttachmentBudget>,
    sessionId: string,
    warnedNames?: Set<string>,
  ) => void;
}) {
  const currentSessionId = useAppStore((s) => s.currentSessionId);
  const setFileContent = useAppStore((s) => s.setFileContent);
  const setSelectedFile = useAppStore((s) => s.setSelectedFile);
  const workspaceBySession = useAppStore((s) => s.workspaceBySession);
  const setWorkspaceBySession = useAppStore((s) => s.setWorkspaceBySession);
  const setModifiedFilesBySession = useAppStore((s) => s.setModifiedFilesBySession);
  const setPreviewBySession = useAppStore((s) => s.setPreviewBySession);
  const checkpointBySession = useAppStore((s) => s.checkpointBySession);
  const setCheckpointBySession = useAppStore((s) => s.setCheckpointBySession);
  const currentWorkspace = workspaceBySession[currentSessionId] || createEmptyWorkspaceState();

  const selectWorkspaceFile = async (node: DirectoryNode) => {
    const sessionId = currentSessionId;
    const workDir = effectiveWorkDir;
    const sequence = (runtime.fileRequestSequence[sessionId] || 0) + 1;
    runtime.fileRequestSequence[sessionId] = sequence;
    setSelectedFile(node.path);
    setFileContent(null);
    try {
      const content = await invoke<string>("read_file_content", { path: node.path, workDir });
      if (useAppStore.getState().currentSessionId !== sessionId
        || runtime.effectiveWorkDir !== workDir
        || runtime.fileRequestSequence[sessionId] !== sequence) return;
      setSelectedFile(node.path);
      setFileContent(content);
    } catch (error) {
      addLog(`Failed to read file: ${error}`, "error", true, sessionId);
    }
  };

  const attachWorkspaceFile = async (node: DirectoryNode) => {
    const sessionId = currentSessionId;
    const workDir = effectiveWorkDir;
    if (attachmentLoadingBySession[sessionId] || sessionMutationLocked) {
      notify(t("ui.wait-for-attachment-processing-or", lang), "info");
      return;
    }
    setAttachmentLoadingBySession((previous) => ({ ...previous, [sessionId]: true }));
    try {
      const content = await invoke<string>("read_file_content", { path: node.path, workDir });
      const data = content.slice(0, MAX_ATTACHMENT_TEXT_PER_FILE);
      const fitted = fitAttachmentBudget(attachmentsBySession[sessionId] || [], [{
        name: node.name,
        path: node.path,
        type: "text",
        data,
        mimeType: "text/plain",
        truncated: data.length < content.length,
        originalSize: content.length,
      }]);
      if (fitted.accepted.length > 0) {
        setAttachmentsBySession((previous) => ({
          ...previous,
          [sessionId]: [...(previous[sessionId] || []), ...fitted.accepted],
        }));
      }
      reportAttachmentFit(fitted, sessionId);
    } catch (error) {
      addLog(`Failed to attach file: ${error}`, "error", true, sessionId);
    } finally {
      setAttachmentLoadingBySession((previous) => ({ ...previous, [sessionId]: false }));
    }
  };

  const selectGitEntry = async (entry: GitStatusEntry) => {
    const sessionId = currentSessionId;
    const workDir = effectiveWorkDir;
    setWorkspaceBySession((previous) => ({
      ...previous,
      [sessionId]: { ...(previous[sessionId] || currentWorkspace), selectedPath: entry.path, diff: "" },
    }));
    try {
      const hasStaged = Boolean(entry.indexStatus.trim() && entry.indexStatus !== "?");
      const hasWorktree = Boolean(entry.worktreeStatus.trim()) || entry.worktreeStatus === "?";
      const [stagedResult, worktreeResult] = await Promise.all([
        hasStaged
          ? invoke<string>("get_git_diff", { workDir, path: entry.path, staged: true })
          : Promise.resolve(""),
        hasWorktree
          ? invoke<string>("get_git_diff", { workDir, path: entry.path, staged: false })
          : Promise.resolve(""),
      ]);
      const sections = [
        stagedResult ? `${t("ui.staged", lang)}\n${stagedResult}` : "",
        worktreeResult ? `${t("ui.worktree", lang)}\n${worktreeResult}` : "",
      ].filter(Boolean);
      const diff = sections.join("\n\n") || (t("ui.no-textual-diff-to-display", lang));
      setWorkspaceBySession((previous) => {
        if (previous[sessionId]?.workDir !== workDir
          || previous[sessionId]?.selectedPath !== entry.path) return previous;
        return {
          ...previous,
          [sessionId]: { ...previous[sessionId], diff },
        };
      });
    } catch (error) {
      addLog(String(error), "error", true, sessionId);
    }
  };

  const restoreGitEntry = async (entry: GitStatusEntry) => {
    const sessionId = currentSessionId;
    const workDir = effectiveWorkDir;
    const repositoryRoot = currentWorkspace.repositoryRoot || workDir;
    if (sessionMutationLocked) {
      notify(t("ui.files-cannot-be-restored-while", lang), "error");
      return;
    }
    if (!await requestConfirmation({
      title: t("ui.restore-file-title", lang),
      message: t("ui.confirm-restore-file", lang, { path: entry.path }),
      confirmLabel: t("ui.restore", lang),
      cancelLabel: t("ui.cancel", lang),
      danger: true,
    })) return;
    try {
      if (entry.indexStatus.trim() && entry.indexStatus !== "?") {
        await invoke("restore_git_path", { workDir, path: entry.path, staged: true });
      }
      await invoke("restore_git_path", { workDir, path: entry.path, staged: false });
      if (entry.originalPath && entry.originalPath !== entry.path) {
        await invoke("restore_git_path", { workDir, path: entry.originalPath, staged: false });
      }
      if (useAppStore.getState().currentSessionId === sessionId && runtime.effectiveWorkDir === workDir) {
        runtime.fileRequestSequence[sessionId] = (runtime.fileRequestSequence[sessionId] || 0) + 1;
        setFileContent(null);
        setSelectedFile(null);
        setDiffView(false);
      }
      const restoredKeys = new Set([
        resolveWorkspacePath(repositoryRoot, entry.path),
        ...(entry.originalPath ? [resolveWorkspacePath(repositoryRoot, entry.originalPath)] : []),
      ]);
      setModifiedFilesBySession((previous) => {
        const nextFiles = { ...(previous[sessionId] || {}) };
        for (const key of restoredKeys) delete nextFiles[key];
        return { ...previous, [sessionId]: nextFiles };
      });
      if (/\.(html?|svg)$/i.test(entry.path)) {
        setPreviewBySession((previous) => ({ ...previous, [sessionId]: "" }));
      }
      if (useAppStore.getState().currentSessionId === sessionId && runtime.effectiveWorkDir === workDir) {
        await refreshWorkspace(sessionId, workDir);
      }
    } catch (error) {
      addLog(String(error), "error", true, sessionId);
    }
  };

  const restoreRunCheckpoint = async () => {
    const sessionId = currentSessionId;
    const checkpoint = checkpointBySession[sessionId];
    if (!checkpoint) return;
    if (sessionMutationLocked) {
      notify(t("ui.stop-the-current-task-before", lang), "error");
      return;
    }
    if (!await requestConfirmation({
      title: t("ui.restore-checkpoint-title", lang),
      message: t("ui.confirm-restore-checkpoint", lang, { dir: checkpoint.workDir }),
      confirmLabel: t("ui.restore", lang),
      cancelLabel: t("ui.cancel", lang),
      danger: true,
    })) return;
    try {
      await invoke("restore_git_checkpoint", { workDir: checkpoint.workDir, commit: checkpoint.commit });
      if (useAppStore.getState().currentSessionId === sessionId && runtime.effectiveWorkDir === checkpoint.workDir) {
        runtime.fileRequestSequence[sessionId] = (runtime.fileRequestSequence[sessionId] || 0) + 1;
        setFileContent(null);
        setSelectedFile(null);
        setDiffView(false);
      }
      setModifiedFilesBySession((previous) => ({ ...previous, [sessionId]: {} }));
      setPreviewBySession((previous) => ({ ...previous, [sessionId]: "" }));
      if (runtime.effectiveWorkDir === checkpoint.workDir) {
        await refreshWorkspace(sessionId, checkpoint.workDir);
      }
      await invoke("delete_git_checkpoint", { workDir: checkpoint.workDir, reference: checkpoint.reference });
      setCheckpointBySession((previous) => ({ ...previous, [sessionId]: null }));
    } catch (error) {
      addLog(String(error), "error", true, sessionId);
    }
  };

  const acceptRunCheckpoint = async () => {
    const sessionId = currentSessionId;
    const checkpoint = checkpointBySession[sessionId];
    if (!checkpoint) return;
    if (sessionMutationLocked) {
      notify(t("ui.run-changes-can-be-kept", lang), "error");
      return;
    }
    try {
      await invoke("delete_git_checkpoint", { workDir: checkpoint.workDir, reference: checkpoint.reference });
      setCheckpointBySession((previous) => ({ ...previous, [sessionId]: null }));
      notify(t("ui.run-changes-kept", lang), "success");
    } catch (error) {
      addLog(String(error), "error", true, sessionId);
    }
  };

  return {
    selectWorkspaceFile,
    attachWorkspaceFile,
    selectGitEntry,
    restoreGitEntry,
    restoreRunCheckpoint,
    acceptRunCheckpoint,
  };
}
