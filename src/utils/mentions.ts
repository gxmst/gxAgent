import type { DirectoryNode } from "../components/workspace/WorkspaceTree";
import type { Skill } from "../types";

export interface ActiveMention {
  query: string;
  start: number;
  end: number;
}

export interface MentionOption {
  id: string;
  kind: "git-diff" | "skill" | "file";
  label: string;
  subtitle?: string;
  path?: string;
  skill?: Skill;
}

export interface FlatWorkspaceFile {
  relativePath: string;
  fullPath: string;
}

/**
 * Find an active `@token` immediately before the caret when preceded by
 * start-of-string or whitespace (so email addresses do not trigger mentions).
 */
export function extractActiveMention(text: string, cursorPos: number): ActiveMention | null {
  const safeCursor = Math.max(0, Math.min(cursorPos, text.length));
  const before = text.slice(0, safeCursor);
  const match = /(?:^|\s)(@[^\s@]*)$/.exec(before);
  if (!match) return null;
  const token = match[1];
  const start = safeCursor - token.length;
  return {
    query: token.slice(1),
    start,
    end: safeCursor,
  };
}

/** Flatten a directory tree into workspace-relative forward-slash file entries. */
export function flattenDirectoryTree(
  node: DirectoryNode | null | undefined,
  workDir: string,
): FlatWorkspaceFile[] {
  if (!node) return [];
  const normalizedRoot = workDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const out: FlatWorkspaceFile[] = [];

  const visit = (entry: DirectoryNode) => {
    if (entry.kind === "file") {
      const normalizedPath = entry.path.replace(/\\/g, "/");
      const relative =
        normalizedRoot && normalizedPath.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)
          ? normalizedPath.slice(normalizedRoot.length + 1)
          : entry.name;
      out.push({ relativePath: relative, fullPath: entry.path });
      return;
    }
    for (const child of entry.children || []) {
      visit(child);
    }
  };

  visit(node);
  return out;
}

/** Score and rank matching `@git-diff`, enabled/available skills, and workspace files. */
export function matchMentions(
  query: string,
  files: FlatWorkspaceFile[],
  skills: Skill[],
  lang: string,
  limit = 12,
): MentionOption[] {
  const q = query.trim().toLowerCase();
  const zh = lang === "zh";
  const results: MentionOption[] = [];

  if (!q || "git-diff".includes(q) || "diff".includes(q)) {
    results.push({
      id: "special:git-diff",
      kind: "git-diff",
      label: "@git-diff",
      subtitle: zh ? "附加当前工作区 Git 变更 Diff" : "Attach current workspace Git diff",
    });
  }

  for (const skill of skills) {
    const hay = `${skill.name} ${skill.description}`.toLowerCase();
    if (!q || hay.includes(q)) {
      results.push({
        id: `skill:${skill.id}`,
        kind: "skill",
        label: `@skill:${skill.name}`,
        subtitle: skill.description,
        skill,
      });
    }
  }

  const matchedFiles: { file: FlatWorkspaceFile; score: number }[] = [];
  for (const file of files) {
    const lower = file.relativePath.toLowerCase();
    if (!q) {
      matchedFiles.push({ file, score: lower.split("/").length });
      continue;
    }
    const idx = lower.indexOf(q);
    if (idx >= 0) {
      const basename = lower.split("/").pop() || lower;
      const baseMatch = basename.startsWith(q) ? 0 : basename.includes(q) ? 1 : 2;
      matchedFiles.push({ file, score: baseMatch * 1000 + idx });
    }
  }
  matchedFiles.sort((a, b) => a.score - b.score || a.file.relativePath.localeCompare(b.file.relativePath));

  for (const { file } of matchedFiles) {
    if (results.length >= limit) break;
    results.push({
      id: `file:${file.fullPath}`,
      kind: "file",
      label: file.relativePath,
      subtitle: file.fullPath,
      path: file.fullPath,
    });
  }

  return results.slice(0, limit);
}

/** Remove the active `@...` token cleanly when inserting an attachment chip. */
export function stripMentionToken(text: string, mention: ActiveMention): string {
  const before = text.slice(0, mention.start).replace(/[ \t]+$/, "");
  const after = text.slice(mention.end).replace(/^[ \t]+/, "");
  if (before && after) return `${before} ${after}`;
  return `${before}${after}`;
}
