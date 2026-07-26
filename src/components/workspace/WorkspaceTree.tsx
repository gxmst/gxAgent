import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, File, FilePlus2, Folder, Search, X } from "lucide-react";

export interface DirectoryNode {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | string;
  size: number;
  modifiedAt?: number | null;
  children: DirectoryNode[];
}

function filterTree(node: DirectoryNode, query: string): DirectoryNode | null {
  if (!query) return node;
  const ownMatch = node.name.toLowerCase().includes(query);
  const children = node.children
    .map((child) => filterTree(child, query))
    .filter((child): child is DirectoryNode => Boolean(child));
  if (!ownMatch && children.length === 0) return null;
  return { ...node, children };
}

function directoryPaths(node: DirectoryNode): string[] {
  if (node.kind !== "directory") return [];
  return [node.path, ...node.children.flatMap(directoryPaths)];
}

function TreeNode({
  node,
  depth,
  expanded,
  onToggle,
  onSelect,
  onAttach,
  attachDisabled,
  attachTitle,
}: {
  node: DirectoryNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (node: DirectoryNode) => void;
  onAttach?: (node: DirectoryNode) => void;
  attachDisabled?: boolean;
  attachTitle: string;
}) {
  const directory = node.kind === "directory";
  const open = expanded.has(node.path);
  return (
    <li role="treeitem" aria-expanded={directory ? open : undefined}>
      <div className="workspace-tree-row" style={{ paddingLeft: `${8 + depth * 14}px` }}>
        <button
          type="button"
          className="workspace-tree-main"
          onClick={() => directory ? onToggle(node.path) : onSelect(node)}
          title={node.path}
        >
          <span className="workspace-tree-chevron" aria-hidden="true">
            {directory ? (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : null}
          </span>
          {directory ? <Folder size={14} /> : <File size={14} />}
          <span>{node.name}</span>
        </button>
        {!directory && onAttach && (
          <button
            type="button"
            className="workspace-tree-attach"
            disabled={attachDisabled}
            onClick={() => onAttach(node)}
            title={attachTitle}
            aria-label={`${attachTitle}: ${node.name}`}
          >
            <FilePlus2 size={13} />
          </button>
        )}
      </div>
      {directory && open && node.children.length > 0 && (
        <ul role="group">
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
              onAttach={onAttach}
              attachDisabled={attachDisabled}
              attachTitle={attachTitle}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function WorkspaceTree({
  root,
  lang,
  loading,
  error,
  onSelect,
  onAttach,
  attachDisabled,
  onRefresh,
}: {
  root: DirectoryNode | null;
  lang: string;
  loading?: boolean;
  error?: string;
  onSelect: (node: DirectoryNode) => void;
  onAttach?: (node: DirectoryNode) => void;
  attachDisabled?: boolean;
  onRefresh?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(root ? [root.path] : []));
  const zh = lang === "zh";
  const filtered = useMemo(() => root ? filterTree(root, query.trim().toLowerCase()) : null, [root, query]);
  const visibleExpanded = useMemo(
    () => query && filtered ? new Set(directoryPaths(filtered)) : expanded,
    [expanded, filtered, query],
  );

  useEffect(() => {
    if (!root) return;
    setExpanded((current) => {
      if (current.has(root.path)) return current;
      return new Set([root.path]);
    });
  }, [root]);

  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <section className="workspace-tree-panel" aria-label={zh ? "工作区文件" : "Workspace files"}>
      <div className="workspace-tree-search">
        <Search size={13} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={zh ? "筛选文件..." : "Filter files..."}
        />
        {query && <button onClick={() => setQuery("")}><X size={12} /></button>}
      </div>
      {loading ? (
        <div className="workspace-tree-state">{zh ? "正在读取工作区..." : "Loading workspace..."}</div>
      ) : error ? (
        <div className="workspace-tree-state error">
          <span>{error}</span>
          {onRefresh && <button className="btn btn-secondary" onClick={onRefresh}>{zh ? "重试" : "Retry"}</button>}
        </div>
      ) : filtered ? (
        <ul className="workspace-tree" role="tree">
          <TreeNode
            node={filtered}
            depth={0}
            expanded={visibleExpanded}
            onToggle={toggle}
            onSelect={onSelect}
            onAttach={onAttach}
            attachDisabled={attachDisabled}
            attachTitle={attachDisabled
              ? (zh ? "附件处理中或任务准备中" : "Attachments are busy or a request is being prepared")
              : (zh ? "添加到输入附件" : "Attach to prompt")}
          />
        </ul>
      ) : (
        <div className="workspace-tree-state">{query ? (zh ? "没有匹配的文件" : "No matching files") : (zh ? "工作区为空" : "Workspace is empty")}</div>
      )}
    </section>
  );
}
