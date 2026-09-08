use crate::config::AppConfig;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearningConfig {
    #[serde(default)]
    pub skill_roots: Vec<String>,
    #[serde(default)]
    pub enabled_skills: Vec<String>,
    #[serde(default)]
    pub knowledge_enabled: bool,
    #[serde(default = "default_top_k")]
    pub top_k: usize,
    #[serde(default = "default_match_mode")]
    pub match_mode: String,
}
fn default_top_k() -> usize {
    5
}
fn default_match_mode() -> String {
    "any".into()
}
impl Default for LearningConfig {
    fn default() -> Self {
        Self {
            skill_roots: Vec::new(),
            enabled_skills: Vec::new(),
            knowledge_enabled: false,
            top_k: 5,
            match_mode: "any".into(),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub path: String,
    pub scope: String,
    pub body: String,
    pub resources: Vec<String>,
    pub dependencies: Vec<String>,
    pub missing_dependencies: Vec<String>,
}
#[derive(Serialize)]
pub struct Catalog {
    pub skills: Vec<Skill>,
    pub errors: Vec<String>,
}

#[derive(Deserialize)]
struct Metadata {
    name: String,
    description: String,
}

fn parse_skill(path: &Path, scope: &str, config: &AppConfig) -> Result<Skill, String> {
    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if metadata.len() > 256 * 1024 {
        return Err("SKILL.md exceeds 256 KB".into());
    }
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let text = text.trim_start_matches('\u{feff}');
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return Err("SKILL.md must start with YAML front matter".into());
    }
    let mut header = Vec::new();
    let mut closed = false;
    for line in lines.by_ref() {
        if line.trim() == "---" {
            closed = true;
            break;
        }
        header.push(line);
    }
    if !closed {
        return Err("Unterminated skill front matter".into());
    }
    let meta: Metadata = serde_yaml_ng::from_str(&header.join("\n")).map_err(|e| e.to_string())?;
    if meta.name.is_empty()
        || meta.name.len() > 64
        || !meta
            .name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        || meta.description.trim().is_empty()
    {
        return Err("Skill needs a lowercase name and a description".into());
    }
    let body = lines.collect::<Vec<_>>().join("\n");
    if body.trim().is_empty() {
        return Err("Skill instructions are empty".into());
    }
    let canonical = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    let root = canonical.parent().ok_or("Invalid skill path")?;
    let mut resources = Vec::new();
    for entry in walkdir::WalkDir::new(root)
        .max_depth(4)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        if entry.file_type().is_file() && entry.path() != canonical {
            resources.push(
                entry
                    .path()
                    .strip_prefix(root)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
            if resources.len() >= 200 {
                break;
            }
        }
    }
    resources.sort();
    let mut dependencies = Vec::new();
    let dependency_path = root.join("agents").join("openai.yaml");
    if dependency_path.exists() {
        let canonical_dependency =
            std::fs::canonicalize(&dependency_path).map_err(|e| e.to_string())?;
        if !canonical_dependency.starts_with(root) {
            return Err("Skill dependency file leaves its directory".into());
        }
        if std::fs::metadata(&canonical_dependency)
            .map_err(|e| e.to_string())?
            .len()
            > 64 * 1024
        {
            return Err("Skill dependency file exceeds 64 KB".into());
        }
        let yaml: serde_yaml_ng::Value = serde_yaml_ng::from_str(
            &std::fs::read_to_string(canonical_dependency).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        if let Some(tools) = yaml["dependencies"]["tools"].as_sequence() {
            for tool in tools {
                if tool["type"].as_str() == Some("mcp") {
                    if let Some(name) = tool["value"].as_str() {
                        dependencies.push(name.to_owned());
                    }
                }
            }
        }
    }
    let missing_dependencies = dependencies
        .iter()
        .filter(|name| !config.mcp_servers.contains_key(*name))
        .cloned()
        .collect();
    let path = canonical.to_string_lossy().into_owned();
    let identity = if cfg!(windows) {
        path.to_lowercase()
    } else {
        path.clone()
    };
    Ok(Skill {
        id: hex::encode(Sha256::digest(identity.as_bytes())),
        name: meta.name,
        description: meta.description,
        path,
        scope: scope.into(),
        body,
        resources,
        dependencies,
        missing_dependencies,
    })
}

pub fn discover(config: &AppConfig) -> Catalog {
    let mut roots: Vec<(PathBuf, String)> = config
        .learning
        .skill_roots
        .iter()
        .map(|p| (PathBuf::from(p), "global".into()))
        .collect();
    if let Some(home) = dirs::home_dir() {
        roots.push((home.join(".agents").join("skills"), "global".into()));
    }
    if !config.default_work_dir.is_empty() {
        roots.push((
            Path::new(&config.default_work_dir)
                .join(".agents")
                .join("skills"),
            "project".into(),
        ));
        roots.push((
            Path::new(&config.default_work_dir)
                .join(".gxagent")
                .join("skills"),
            "project".into(),
        ));
    }
    let mut catalog = Catalog {
        skills: Vec::new(),
        errors: Vec::new(),
    };
    let mut seen = std::collections::HashSet::new();
    for (root, scope) in roots {
        if !root.is_dir() {
            continue;
        }
        for entry in walkdir::WalkDir::new(&root)
            .max_depth(3)
            .follow_links(false)
        {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    catalog.errors.push(e.to_string());
                    continue;
                }
            };
            if !entry.file_type().is_file() || entry.file_name() != "SKILL.md" {
                continue;
            }
            match parse_skill(entry.path(), &scope, config) {
                Ok(skill) => {
                    if seen.insert(skill.id.clone()) {
                        catalog.skills.push(skill);
                    }
                }
                Err(error) => catalog
                    .errors
                    .push(format!("{}: {error}", entry.path().display())),
            }
            if catalog.skills.len() >= 256 {
                catalog
                    .errors
                    .push("Skill catalog limited to 256 entries".into());
                return catalog;
            }
        }
    }
    catalog
        .skills
        .sort_by(|a, b| a.name.cmp(&b.name).then(a.path.cmp(&b.path)));
    catalog
}

#[tauri::command]
pub async fn list_skills(config: AppConfig) -> Result<Catalog, String> {
    tokio::task::spawn_blocking(move || discover(&config))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_skill_resource(
    config: AppConfig,
    skill_id: String,
    resource: String,
) -> Result<String, String> {
    let catalog = discover(&config);
    let skill = catalog
        .skills
        .iter()
        .find(|s| s.id == skill_id)
        .ok_or("Skill is no longer available")?;
    let root = Path::new(&skill.path)
        .parent()
        .ok_or("Invalid skill path")?;
    let path = std::fs::canonicalize(root.join(resource)).map_err(|e| e.to_string())?;
    if !path.starts_with(root) || !path.is_file() {
        return Err("Resource must be inside the skill directory".into());
    }
    if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > 256 * 1024 {
        return Err("Resource exceeds 256 KB".into());
    }
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn front_matter_and_mcp_dependencies_are_parsed() {
        let root = std::env::temp_dir().join(format!("gx-skill-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("agents")).unwrap();
        std::fs::write(root.join("SKILL.md"),"---\nname: test-skill\ndescription: |\n  Reusable test workflow.\n---\nRead before acting.").unwrap();
        std::fs::write(
            root.join("agents/openai.yaml"),
            "dependencies:\n  tools:\n    - type: mcp\n      value: docs\n",
        )
        .unwrap();
        let skill = parse_skill(&root.join("SKILL.md"), "project", &AppConfig::default()).unwrap();
        assert_eq!(skill.body, "Read before acting.");
        assert_eq!(skill.missing_dependencies, vec!["docs"]);
        std::fs::write(root.join("SKILL.md"), "---\nname: invalid name\n---\nbody").unwrap();
        assert!(parse_skill(&root.join("SKILL.md"), "project", &AppConfig::default()).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
