use std::path::{Path, PathBuf};

/// Optional isolated application storage for development and smoke tests.
/// Set before starting the process; do not change it while the app is running.
pub fn isolated_root() -> Option<PathBuf> {
    std::env::var_os("GXAGENT_DATA_DIR")
        .filter(|value| !value.is_empty())
        .map(|value| absolute_root(Path::new(&value)))
}

fn absolute_root(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()
            .expect("Cannot resolve GXAGENT_DATA_DIR without a working directory")
            .join(path)
    }
}

pub fn config_dir() -> Option<PathBuf> {
    isolated_root()
        .map(|root| root.join("config"))
        .or_else(|| dirs::config_dir().map(|root| root.join("gxAgent")))
}

pub fn data_dir() -> Option<PathBuf> {
    isolated_root()
        .map(|root| root.join("data"))
        .or_else(|| dirs::data_dir().map(|root| root.join("gxAgent")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isolation_root_resolves_relative_and_preserves_absolute_paths() {
        let relative = Path::new("isolated-gxagent-test");
        let expected = std::env::current_dir().unwrap().join(relative);
        assert_eq!(absolute_root(relative), expected);
        assert_eq!(absolute_root(&expected), expected);
    }
}
