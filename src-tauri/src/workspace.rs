use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::process::Command;

const MAX_TREE_DEPTH: usize = 12;
const MAX_TREE_ENTRIES: usize = 10_000;
const MAX_GIT_CHECKPOINTS: usize = 50;
const CHECKPOINT_REF_PREFIX: &str = "refs/gxagent/checkpoints/";
const CHECKPOINT_INDEX_TREE_TRAILER: &str = "GXAgent-Index-Tree:";

fn git_index_lock_path(index_path: &Path) -> PathBuf {
    let mut value = index_path.as_os_str().to_os_string();
    value.push(".lock");
    PathBuf::from(value)
}

struct TemporaryGitIndex {
    path: PathBuf,
}

impl TemporaryGitIndex {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TemporaryGitIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_file(git_index_lock_path(&self.path));
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub path: String,
    pub exists: bool,
    pub is_directory: bool,
    pub writable: bool,
    pub created: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryNode {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub modified_at: Option<u64>,
    pub children: Vec<DirectoryNode>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    pub index_status: String,
    pub worktree_status: String,
    pub path: String,
    pub original_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusResult {
    pub repository_root: String,
    pub branch: String,
    pub entries: Vec<GitStatusEntry>,
    pub clean: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckpoint {
    pub reference: String,
    pub commit: String,
    pub created_at: u64,
    pub label: String,
}

pub fn default_workspace_path() -> PathBuf {
    dirs::home_dir()
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
        .join("gxAgent-workspace")
}

fn expand_home(path: &str) -> PathBuf {
    if path == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from(path));
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

pub fn ensure_workspace_dir(path: &str, create: bool) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(
            "Work directory is empty. Choose a valid workspace before running tools.".to_string(),
        );
    }

    let candidate = expand_home(trimmed);
    if !candidate.exists() {
        if !create {
            return Err(format!(
                "Work directory does not exist: {}",
                candidate.display()
            ));
        }
        std::fs::create_dir_all(&candidate).map_err(|e| {
            format!(
                "Failed to create work directory '{}': {}",
                candidate.display(),
                e
            )
        })?;
    }

    let metadata = std::fs::metadata(&candidate).map_err(|e| {
        format!(
            "Cannot inspect work directory '{}': {}",
            candidate.display(),
            e
        )
    })?;
    if !metadata.is_dir() {
        return Err(format!(
            "Work directory is not a directory: {}",
            candidate.display()
        ));
    }
    if metadata.permissions().readonly() {
        return Err(format!(
            "Work directory is read-only: {}",
            candidate.display()
        ));
    }

    let canonical = std::fs::canonicalize(&candidate).map_err(|e| {
        format!(
            "Failed to resolve work directory '{}': {}",
            candidate.display(),
            e
        )
    })?;

    Ok(canonical)
}

pub fn workspace_info(path: &str, create: bool) -> Result<WorkspaceInfo, String> {
    let candidate = expand_home(path.trim());
    let existed = candidate.exists();
    let resolved = ensure_workspace_dir(path, create)?;
    let metadata = std::fs::metadata(&resolved).map_err(|e| e.to_string())?;
    Ok(WorkspaceInfo {
        path: resolved.to_string_lossy().to_string(),
        exists: true,
        is_directory: metadata.is_dir(),
        writable: !metadata.permissions().readonly(),
        created: !existed,
    })
}

pub fn resolve_within_workspace(path: &str, work_dir: &str) -> Result<PathBuf, String> {
    let root = ensure_workspace_dir(work_dir, false)?;
    let requested = Path::new(path);
    let joined = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        root.join(requested)
    };

    // Existing paths can be canonicalized directly. For a path that may be
    // created, canonicalize its closest existing ancestor and append the tail.
    let resolved = if joined.exists() {
        std::fs::canonicalize(&joined).map_err(|e| e.to_string())?
    } else {
        let mut ancestor = joined.as_path();
        let mut tail = Vec::new();
        while !ancestor.exists() {
            let name = ancestor
                .file_name()
                .ok_or_else(|| format!("Cannot resolve path: {}", joined.display()))?;
            tail.push(name.to_os_string());
            ancestor = ancestor
                .parent()
                .ok_or_else(|| format!("Cannot resolve path: {}", joined.display()))?;
        }
        let mut canonical = std::fs::canonicalize(ancestor).map_err(|e| e.to_string())?;
        for component in tail.into_iter().rev() {
            canonical.push(component);
        }
        canonical
    };

    if !resolved.starts_with(&root) {
        return Err(format!(
            "Path '{}' resolves outside workspace '{}'",
            path,
            root.display()
        ));
    }
    Ok(resolved)
}

fn modified_at(metadata: &std::fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
}

fn build_tree(
    path: &Path,
    depth: usize,
    max_depth: usize,
    include_hidden: bool,
    entries_seen: &mut usize,
) -> Result<DirectoryNode, String> {
    *entries_seen += 1;
    if *entries_seen > MAX_TREE_ENTRIES {
        return Err(format!(
            "Directory tree exceeds {} entries",
            MAX_TREE_ENTRIES
        ));
    }

    let metadata = std::fs::symlink_metadata(path)
        .map_err(|e| format!("Failed to inspect '{}': {}", path.display(), e))?;
    let file_type = metadata.file_type();
    let kind = if file_type.is_symlink() {
        "symlink"
    } else if metadata.is_dir() {
        "directory"
    } else {
        "file"
    };
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());

    let mut children = Vec::new();
    if metadata.is_dir() && !file_type.is_symlink() && depth < max_depth {
        let mut child_paths = std::fs::read_dir(path)
            .map_err(|e| format!("Failed to read '{}': {}", path.display(), e))?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|child| {
                include_hidden
                    || child
                        .file_name()
                        .and_then(|name| name.to_str())
                        .map(|name| !name.starts_with('.'))
                        .unwrap_or(true)
            })
            .collect::<Vec<_>>();
        child_paths.sort_by(|a, b| {
            let a_dir = a.is_dir();
            let b_dir = b.is_dir();
            b_dir.cmp(&a_dir).then_with(|| {
                a.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase()
                    .cmp(
                        &b.file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_lowercase(),
                    )
            })
        });

        for child in child_paths {
            children.push(build_tree(
                &child,
                depth + 1,
                max_depth,
                include_hidden,
                entries_seen,
            )?);
        }
    }

    Ok(DirectoryNode {
        name,
        path: path.to_string_lossy().to_string(),
        kind: kind.to_string(),
        size: if metadata.is_file() {
            metadata.len()
        } else {
            0
        },
        modified_at: modified_at(&metadata),
        children,
    })
}

fn selected_workspace(
    explicit: Option<String>,
    fallback: Option<String>,
) -> Result<PathBuf, String> {
    let selected = explicit
        .filter(|value| !value.trim().is_empty())
        .or_else(|| fallback.filter(|value| !value.trim().is_empty()))
        .ok_or_else(|| "No workspace was provided".to_string())?;
    ensure_workspace_dir(&selected, false)
}

#[tauri::command]
pub fn validate_workspace(path: String, create: Option<bool>) -> Result<WorkspaceInfo, String> {
    workspace_info(&path, create.unwrap_or(false))
}

#[tauri::command]
pub async fn list_directory_tree(
    path: Option<String>,
    work_dir: Option<String>,
    max_depth: Option<usize>,
    include_hidden: Option<bool>,
) -> Result<DirectoryNode, String> {
    let target = if let Some(selected) = work_dir.filter(|value| !value.trim().is_empty()) {
        let root = ensure_workspace_dir(&selected, false)?;
        match path.filter(|value| !value.trim().is_empty()) {
            Some(path) => resolve_within_workspace(&path, &root.to_string_lossy())?,
            None => root,
        }
    } else if let Some(path) = path.filter(|value| !value.trim().is_empty()) {
        ensure_workspace_dir(&path, false)?
    } else {
        return Err("No workspace was provided".to_string());
    };
    let max_depth = max_depth.unwrap_or(3).clamp(1, MAX_TREE_DEPTH);
    tokio::task::spawn_blocking(move || {
        let mut entries_seen = 0;
        build_tree(
            &target,
            0,
            max_depth,
            include_hidden.unwrap_or(false),
            &mut entries_seen,
        )
    })
    .await
    .map_err(|e| format!("Directory tree task failed: {}", e))?
}

#[cfg(windows)]
fn configure_command(command: &mut Command) {
    command.creation_flags(0x08000000);
}

#[cfg(not(windows))]
fn configure_command(_command: &mut Command) {}

async fn git_output(work_dir: &Path, args: &[&str]) -> Result<String, String> {
    Ok(git_output_raw(work_dir, args).await?.trim().to_string())
}

async fn git_output_raw(work_dir: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("git");
    command.args(args).current_dir(work_dir);
    configure_command(&mut command);
    let output = command
        .output()
        .await
        .map_err(|e| format!("Failed to run git: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("git {:?} failed with {}", args, output.status)
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

async fn repository_root(work_dir: &Path) -> Result<PathBuf, String> {
    let root = git_output(work_dir, &["rev-parse", "--show-toplevel"]).await?;
    ensure_workspace_dir(&root, false)
}

fn parse_status_z(raw: &str) -> Vec<GitStatusEntry> {
    let mut records = raw.split_terminator('\0');
    let mut entries = Vec::new();
    while let Some(record) = records.next() {
        if record.len() < 3 || !record.is_char_boundary(3) {
            continue;
        }
        let index_status = record[0..1].to_string();
        let worktree_status = record[1..2].to_string();
        let path = record[3..].to_string();
        let renamed = matches!(index_status.as_str(), "R" | "C")
            || matches!(worktree_status.as_str(), "R" | "C");
        let original_path = if renamed {
            records.next().map(str::to_string)
        } else {
            None
        };
        entries.push(GitStatusEntry {
            index_status,
            worktree_status,
            path,
            original_path,
        });
    }
    entries
}

fn render_untracked_diff(root: &Path, relative: &str) -> Result<String, String> {
    const MAX_UNTRACKED_DIFF_BYTES: u64 = 1024 * 1024;
    let path = resolve_within_workspace(relative, &root.to_string_lossy())?;
    let metadata = std::fs::metadata(&path)
        .map_err(|e| format!("Failed to inspect untracked file '{}': {}", relative, e))?;
    if !metadata.is_file() {
        return Ok(format!("Untracked directory: {}", relative));
    }
    if metadata.len() > MAX_UNTRACKED_DIFF_BYTES {
        return Ok(format!(
            "diff --git a/{0} b/{0}\nnew file (diff omitted: {1} bytes exceeds 1 MiB)",
            relative,
            metadata.len()
        ));
    }
    let bytes = std::fs::read(&path)
        .map_err(|e| format!("Failed to read untracked file '{}': {}", relative, e))?;
    let content = match String::from_utf8(bytes) {
        Ok(content) => content.replace("\r\n", "\n"),
        Err(_) => {
            return Ok(format!(
            "diff --git a/{0} b/{0}\nnew file mode 100644\nBinary file /dev/null and b/{0} differ",
            relative
        ))
        }
    };
    let line_count = content.lines().count();
    let mut body = String::new();
    for line in content.split_inclusive('\n') {
        body.push('+');
        body.push_str(line);
    }
    if !content.is_empty() && !content.ends_with('\n') {
        body.push_str("\n\\ No newline at end of file\n");
    }
    Ok(format!(
        "diff --git a/{0} b/{0}\nnew file mode 100644\n--- /dev/null\n+++ b/{0}\n@@ -0,0 +1,{1} @@\n{2}",
        relative, line_count, body
    ))
}

#[tauri::command]
pub async fn get_git_status(
    work_dir: Option<String>,
    default_work_dir: Option<String>,
) -> Result<GitStatusResult, String> {
    let selected = selected_workspace(work_dir, default_work_dir)?;
    let root = repository_root(&selected).await?;
    let branch = git_output(&root, &["branch", "--show-current"])
        .await
        .unwrap_or_default();
    let raw = git_output_raw(
        &root,
        &[
            "-c",
            "core.quotepath=false",
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
        ],
    )
    .await?;
    let entries = parse_status_z(&raw);
    Ok(GitStatusResult {
        repository_root: root.to_string_lossy().to_string(),
        branch,
        clean: entries.is_empty(),
        entries,
    })
}

#[tauri::command]
pub async fn get_git_diff(
    work_dir: Option<String>,
    default_work_dir: Option<String>,
    path: Option<String>,
    staged: Option<bool>,
) -> Result<String, String> {
    let selected = selected_workspace(work_dir, default_work_dir)?;
    let root = repository_root(&selected).await?;
    let mut owned = vec!["diff".to_string(), "--no-ext-diff".to_string()];
    if staged.unwrap_or(false) {
        owned.push("--cached".to_string());
    }
    let status_raw = git_output_raw(
        &root,
        &[
            "-c",
            "core.quotepath=false",
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
        ],
    )
    .await?;
    let status_entries = parse_status_z(&status_raw);
    let has_selected_path = path
        .as_ref()
        .map(|path| !path.trim().is_empty())
        .unwrap_or(false);
    if let Some(path) = path.filter(|path| !path.trim().is_empty()) {
        let resolved = resolve_within_workspace(&path, &root.to_string_lossy())?;
        let relative = resolved.strip_prefix(&root).map_err(|e| e.to_string())?;
        let relative = relative.to_string_lossy().replace('\\', "/");
        if !staged.unwrap_or(false)
            && status_entries.iter().any(|entry| {
                entry.path == relative && entry.index_status == "?" && entry.worktree_status == "?"
            })
        {
            return render_untracked_diff(&root, &relative);
        }
        owned.push("--".to_string());
        owned.push(relative);
    }
    let args = owned.iter().map(String::as_str).collect::<Vec<_>>();
    let mut diff = git_output(&root, &args).await?;
    if !has_selected_path && !staged.unwrap_or(false) {
        for entry in status_entries {
            if entry.index_status == "?" && entry.worktree_status == "?" {
                let untracked = render_untracked_diff(&root, &entry.path)?;
                if !diff.is_empty() {
                    diff.push_str("\n\n");
                }
                diff.push_str(&untracked);
            }
        }
    }
    Ok(diff)
}

#[tauri::command]
pub async fn restore_git_path(
    work_dir: Option<String>,
    default_work_dir: Option<String>,
    path: String,
    source: Option<String>,
    staged: Option<bool>,
) -> Result<(), String> {
    let selected = selected_workspace(work_dir, default_work_dir)?;
    let root = repository_root(&selected).await?;
    let resolved = resolve_within_workspace(&path, &root.to_string_lossy())?;
    let relative = resolved.strip_prefix(&root).map_err(|e| e.to_string())?;
    let relative_string = relative.to_string_lossy().replace('\\', "/");

    let status_raw = git_output_raw(
        &root,
        &[
            "-c",
            "core.quotepath=false",
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
        ],
    )
    .await?;
    let status_entry = parse_status_z(&status_raw).into_iter().find(|entry| {
        entry.path == relative_string || entry.original_path.as_deref() == Some(&relative_string)
    });
    if !staged.unwrap_or(false)
        && status_entry
            .as_ref()
            .map(|entry| entry.index_status == "?" && entry.worktree_status == "?")
            .unwrap_or(false)
    {
        if resolved.is_dir() {
            std::fs::remove_dir_all(&resolved)
        } else {
            std::fs::remove_file(&resolved)
        }
        .map_err(|e| {
            format!(
                "Failed to remove untracked path '{}': {}",
                relative.display(),
                e
            )
        })?;
        return Ok(());
    }

    let mut owned = vec!["restore".to_string()];
    if staged.unwrap_or(false) {
        owned.push("--staged".to_string());
    } else {
        owned.push("--worktree".to_string());
    }
    if let Some(source) = source.filter(|source| !source.trim().is_empty()) {
        owned.push("--source".to_string());
        owned.push(source);
    }
    owned.push("--".to_string());
    owned.push(relative.to_string_lossy().to_string());
    if let Some(original) = status_entry.and_then(|entry| entry.original_path) {
        if original != relative_string {
            owned.push(original);
        }
    }
    let args = owned.iter().map(String::as_str).collect::<Vec<_>>();
    git_output(&root, &args).await.map(|_| ())
}

async fn git_output_with_index(
    root: &Path,
    index_path: &Path,
    args: &[&str],
    identity: bool,
) -> Result<String, String> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(root)
        .env("GIT_INDEX_FILE", index_path);
    if identity {
        command
            .env("GIT_AUTHOR_NAME", "gxAgent")
            .env("GIT_AUTHOR_EMAIL", "gxagent@local")
            .env("GIT_COMMITTER_NAME", "gxAgent")
            .env("GIT_COMMITTER_EMAIL", "gxagent@local");
    }
    configure_command(&mut command);
    let output = command.output().await.map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn parse_checkpoint_index_tree(commit_data: &str) -> Result<Option<String>, String> {
    for line in commit_data.lines().rev() {
        let Some(value) = line.trim().strip_prefix(CHECKPOINT_INDEX_TREE_TRAILER) else {
            continue;
        };
        let value = value.trim();
        if (40..=64).contains(&value.len())
            && value.chars().all(|character| character.is_ascii_hexdigit())
        {
            return Ok(Some(value.to_string()));
        }
        return Err("Checkpoint index metadata is invalid".to_string());
    }
    Ok(None)
}

async fn checkpoint_index_tree(root: &Path, commit: &str) -> Result<Option<String>, String> {
    let commit_data = git_output_raw(root, &["cat-file", "-p", commit]).await?;
    parse_checkpoint_index_tree(&commit_data)
}

pub async fn create_checkpoint_internal(
    work_dir: &str,
    label: Option<String>,
) -> Result<GitCheckpoint, String> {
    let selected = ensure_workspace_dir(work_dir, false)?;
    let root = repository_root(&selected).await?;
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let reference = format!("{}{}-{}", CHECKPOINT_REF_PREFIX, created_at, &suffix[..8]);
    let label = label
        .filter(|label| !label.trim().is_empty())
        .unwrap_or_else(|| "automatic".to_string());
    let index_tree = git_output(&root, &["write-tree"]).await?;
    let temporary_index =
        TemporaryGitIndex::new(std::env::temp_dir().join(format!("gxagent-index-{}", suffix)));

    let head = git_output(&root, &["rev-parse", "--verify", "HEAD"])
        .await
        .ok();
    if head.is_some() {
        git_output_with_index(&root, temporary_index.path(), &["read-tree", "HEAD"], false).await?;
    } else {
        git_output_with_index(
            &root,
            temporary_index.path(),
            &["read-tree", "--empty"],
            false,
        )
        .await?;
    }
    git_output_with_index(&root, temporary_index.path(), &["add", "-A"], false).await?;
    let tree = git_output_with_index(&root, temporary_index.path(), &["write-tree"], false).await?;

    // A tree id written only into the commit message is not reachable to Git's
    // object graph and may be pruned. Keep the original index tree alive through
    // a small auxiliary parent commit, while the public checkpoint commit keeps
    // the combined worktree snapshot as its own tree.
    let index_snapshot_message = format!("gxAgent checkpoint index snapshot: {}", suffix);
    let index_commit = git_output_with_index(
        &root,
        temporary_index.path(),
        &["commit-tree", &index_tree, "-m", &index_snapshot_message],
        true,
    )
    .await?;

    let message = format!(
        "gxAgent checkpoint: {}\n\n{} {}",
        label, CHECKPOINT_INDEX_TREE_TRAILER, index_tree
    );
    let mut args = vec!["commit-tree".to_string(), tree];
    if let Some(head) = head {
        args.push("-p".to_string());
        args.push(head);
    }
    args.push("-p".to_string());
    args.push(index_commit);
    args.push("-m".to_string());
    args.push(message);
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    let commit = git_output_with_index(&root, temporary_index.path(), &refs, true).await?;
    drop(temporary_index);
    git_output(&root, &["update-ref", &reference, &commit]).await?;
    prune_old_checkpoints(&root, MAX_GIT_CHECKPOINTS).await?;

    Ok(GitCheckpoint {
        reference,
        commit,
        created_at,
        label,
    })
}

async fn prune_old_checkpoints(root: &Path, keep: usize) -> Result<(), String> {
    let raw = git_output(
        root,
        &[
            "for-each-ref",
            "--sort=-creatordate",
            "--format=%(refname)",
            CHECKPOINT_REF_PREFIX,
        ],
    )
    .await?;
    for reference in raw.lines().skip(keep) {
        git_output(root, &["update-ref", "-d", reference]).await?;
    }
    Ok(())
}

fn validate_checkpoint_reference(reference: &str) -> Result<(), String> {
    let suffix = reference
        .strip_prefix(CHECKPOINT_REF_PREFIX)
        .ok_or_else(|| "Only gxAgent checkpoint references can be deleted".to_string())?;
    if suffix.is_empty()
        || !suffix
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || value == '-' || value == '_')
    {
        return Err("Invalid gxAgent checkpoint reference".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn create_git_checkpoint(
    work_dir: Option<String>,
    default_work_dir: Option<String>,
    label: Option<String>,
) -> Result<GitCheckpoint, String> {
    let selected = selected_workspace(work_dir, default_work_dir)?;
    create_checkpoint_internal(&selected.to_string_lossy(), label).await
}

#[tauri::command]
pub async fn list_git_checkpoints(
    work_dir: Option<String>,
    default_work_dir: Option<String>,
) -> Result<Vec<GitCheckpoint>, String> {
    let selected = selected_workspace(work_dir, default_work_dir)?;
    let root = repository_root(&selected).await?;
    let raw = git_output(
        &root,
        &[
            "for-each-ref",
            "--sort=-creatordate",
            "--format=%(refname)|%(objectname)|%(creatordate:unix)|%(subject)",
            "refs/gxagent/checkpoints",
        ],
    )
    .await?;
    Ok(raw
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(4, '|');
            let reference = parts.next()?.to_string();
            let commit = parts.next()?.to_string();
            let created_at = parts.next()?.parse().ok()?;
            let subject = parts.next().unwrap_or_default();
            let label = subject
                .strip_prefix("gxAgent checkpoint: ")
                .unwrap_or(subject)
                .to_string();
            Some(GitCheckpoint {
                reference,
                commit,
                created_at,
                label,
            })
        })
        .collect())
}

#[tauri::command]
pub async fn delete_git_checkpoint(
    work_dir: Option<String>,
    default_work_dir: Option<String>,
    reference: String,
) -> Result<(), String> {
    validate_checkpoint_reference(&reference)?;
    let selected = selected_workspace(work_dir, default_work_dir)?;
    let root = repository_root(&selected).await?;
    git_output(&root, &["update-ref", "-d", &reference])
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn restore_git_checkpoint(
    work_dir: Option<String>,
    default_work_dir: Option<String>,
    commit: String,
) -> Result<(), String> {
    let selected = selected_workspace(work_dir, default_work_dir)?;
    let root = repository_root(&selected).await?;
    git_output(
        &root,
        &["cat-file", "-e", &format!("{}^{{commit}}", commit)],
    )
    .await?;
    let index_tree = checkpoint_index_tree(&root, &commit).await?;
    if let Some(index_tree) = &index_tree {
        git_output(
            &root,
            &["cat-file", "-e", &format!("{}^{{tree}}", index_tree)],
        )
        .await?;
    }
    let checkpoint_paths = git_output_raw(&root, &["ls-tree", "-r", "--name-only", "-z", &commit])
        .await?
        .split_terminator('\0')
        .map(str::to_string)
        .collect::<std::collections::HashSet<_>>();
    let untracked_before =
        git_output_raw(&root, &["ls-files", "--others", "--exclude-standard", "-z"])
            .await?
            .split_terminator('\0')
            .map(str::to_string)
            .collect::<Vec<_>>();

    git_output(
        &root,
        &[
            "restore",
            "--source",
            &commit,
            "--staged",
            "--worktree",
            "--",
            ".",
        ],
    )
    .await?;

    for path in untracked_before {
        if checkpoint_paths.contains(&path) {
            continue;
        }
        let resolved = resolve_within_workspace(&path, &root.to_string_lossy())?;
        if resolved.is_dir() {
            std::fs::remove_dir_all(&resolved)
                .map_err(|e| format!("Failed to remove '{}': {}", resolved.display(), e))?;
        } else if resolved.exists() {
            std::fs::remove_file(&resolved)
                .map_err(|e| format!("Failed to remove '{}': {}", resolved.display(), e))?;
        }
    }
    if let Some(index_tree) = index_tree {
        git_output(&root, &["read-tree", &index_tree]).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;

    fn temp_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("gxagent-{}-{}", label, uuid::Uuid::new_v4()))
    }

    fn test_git(dir: &Path, args: &[&str]) -> String {
        let output = StdCommand::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("run git in test");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    #[test]
    fn workspace_validation_creates_and_rejects_files() {
        let dir = temp_path("workspace");
        let info = workspace_info(&dir.to_string_lossy(), true).expect("workspace created");
        assert!(info.created);
        assert!(Path::new(&info.path).is_dir());

        let file = dir.join("not-a-dir");
        std::fs::write(&file, b"x").unwrap();
        assert!(ensure_workspace_dir(&file.to_string_lossy(), false).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn tree_is_structured_and_honors_hidden_filter() {
        let dir = temp_path("tree");
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src").join("main.rs"), b"fn main() {}").unwrap();
        std::fs::write(dir.join(".hidden"), b"hidden").unwrap();
        let mut seen = 0;
        let tree = build_tree(&dir, 0, 3, false, &mut seen).unwrap();
        assert!(tree.children.iter().any(|node| node.name == "src"));
        assert!(!tree.children.iter().any(|node| node.name == ".hidden"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn parses_git_status_and_renames() {
        let entries = parse_status_z(
            " M src/中文 file.rs\0R  new name.txt\0old name.txt\0?? trailing .txt\0",
        );
        let modified = &entries[0];
        assert_eq!(modified.worktree_status, "M");
        assert_eq!(modified.path, "src/中文 file.rs");

        let renamed = &entries[1];
        assert_eq!(renamed.original_path.as_deref(), Some("old name.txt"));
        assert_eq!(renamed.path, "new name.txt");
        assert_eq!(entries[2].path, "trailing .txt");
    }

    #[test]
    fn checkpoint_reference_validation_is_namespaced() {
        assert!(validate_checkpoint_reference("refs/gxagent/checkpoints/1234-abcd").is_ok());
        assert!(validate_checkpoint_reference("refs/heads/main").is_err());
        assert!(validate_checkpoint_reference("refs/gxagent/checkpoints/../main").is_err());
    }

    #[test]
    fn temporary_git_index_is_removed_on_drop() {
        let index_path = temp_path("temporary-index");
        let lock_path = git_index_lock_path(&index_path);
        std::fs::write(&index_path, b"index").unwrap();
        std::fs::write(&lock_path, b"lock").unwrap();

        drop(TemporaryGitIndex::new(index_path.clone()));

        assert!(!index_path.exists());
        assert!(!lock_path.exists());
    }

    #[test]
    fn checkpoint_index_tree_trailer_is_validated() {
        let tree = "a".repeat(40);
        let data = format!(
            "tree deadbeef\n\ngxAgent checkpoint: test\n\n{} {}\n",
            CHECKPOINT_INDEX_TREE_TRAILER, tree
        );
        assert_eq!(parse_checkpoint_index_tree(&data).unwrap(), Some(tree));
        assert!(parse_checkpoint_index_tree(&format!(
            "{} not-an-object-id",
            CHECKPOINT_INDEX_TREE_TRAILER
        ))
        .is_err());
        assert_eq!(
            parse_checkpoint_index_tree("legacy checkpoint").unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn checkpoint_roundtrip_preserves_head_and_restores_index_and_untracked_files() {
        if StdCommand::new("git").arg("--version").output().is_err() {
            return;
        }
        let dir = temp_path("git-checkpoint");
        std::fs::create_dir_all(&dir).unwrap();
        test_git(&dir, &["init"]);
        std::fs::write(dir.join("tracked.txt"), "initial\n").unwrap();
        std::fs::write(dir.join("staged.txt"), "initial\n").unwrap();
        std::fs::write(dir.join("mixed.txt"), "initial\n").unwrap();
        test_git(&dir, &["add", "tracked.txt", "staged.txt", "mixed.txt"]);
        test_git(
            &dir,
            &[
                "-c",
                "user.name=gxAgent Test",
                "-c",
                "user.email=gxagent@example.invalid",
                "commit",
                "-m",
                "initial",
            ],
        );
        let head_before = test_git(&dir, &["rev-parse", "HEAD"]);

        std::fs::write(dir.join("tracked.txt"), "checkpoint\n").unwrap();
        std::fs::write(dir.join("staged.txt"), "checkpoint staged\n").unwrap();
        test_git(&dir, &["add", "staged.txt"]);
        std::fs::write(dir.join("mixed.txt"), "checkpoint index\n").unwrap();
        test_git(&dir, &["add", "mixed.txt"]);
        std::fs::write(dir.join("mixed.txt"), "checkpoint worktree\n").unwrap();
        std::fs::write(dir.join("checkpoint-only.txt"), "included\n").unwrap();
        let status_before = test_git(&dir, &["status", "--porcelain=v1"]);
        let checkpoint = create_checkpoint_internal(
            &dir.to_string_lossy(),
            Some("integration test".to_string()),
        )
        .await
        .unwrap();
        assert_eq!(test_git(&dir, &["rev-parse", "HEAD"]), head_before);
        assert_eq!(test_git(&dir, &["status", "--porcelain=v1"]), status_before);

        std::fs::write(dir.join("tracked.txt"), "later\n").unwrap();
        std::fs::write(dir.join("staged.txt"), "later\n").unwrap();
        test_git(&dir, &["add", "staged.txt"]);
        std::fs::write(dir.join("mixed.txt"), "later\n").unwrap();
        std::fs::write(dir.join("after-checkpoint.txt"), "remove me\n").unwrap();
        restore_git_checkpoint(
            Some(dir.to_string_lossy().to_string()),
            None,
            checkpoint.commit.clone(),
        )
        .await
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(dir.join("tracked.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "checkpoint\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("checkpoint-only.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "included\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("staged.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "checkpoint staged\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("mixed.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "checkpoint worktree\n"
        );
        assert!(!dir.join("after-checkpoint.txt").exists());
        assert_eq!(test_git(&dir, &["rev-parse", "HEAD"]), head_before);
        let restored_status =
            test_git(&dir, &["status", "--porcelain=v1", "--untracked-files=all"]);
        assert!(
            restored_status.contains(" M tracked.txt"),
            "{restored_status}"
        );
        assert!(
            restored_status.contains("M  staged.txt"),
            "{restored_status}"
        );
        assert!(
            restored_status.contains("MM mixed.txt"),
            "{restored_status}"
        );
        assert!(
            restored_status.contains("?? checkpoint-only.txt"),
            "{restored_status}"
        );

        delete_git_checkpoint(
            Some(dir.to_string_lossy().to_string()),
            None,
            checkpoint.reference.clone(),
        )
        .await
        .unwrap();
        let deleted_ref = StdCommand::new("git")
            .args(["show-ref", &checkpoint.reference])
            .current_dir(&dir)
            .output()
            .unwrap();
        assert!(!deleted_ref.status.success());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn untracked_diff_and_restore_are_complete() {
        if StdCommand::new("git").arg("--version").output().is_err() {
            return;
        }
        let dir = temp_path("git-untracked");
        std::fs::create_dir_all(&dir).unwrap();
        test_git(&dir, &["init"]);
        std::fs::write(dir.join("中文 file.txt"), "first\nsecond\n").unwrap();

        let diff = get_git_diff(
            Some(dir.to_string_lossy().to_string()),
            None,
            Some("中文 file.txt".to_string()),
            Some(false),
        )
        .await
        .unwrap();
        assert!(diff.contains("new file mode"));
        assert!(diff.contains("+first\n+second\n"));

        restore_git_path(
            Some(dir.to_string_lossy().to_string()),
            None,
            "中文 file.txt".to_string(),
            None,
            Some(false),
        )
        .await
        .unwrap();
        assert!(!dir.join("中文 file.txt").exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}
