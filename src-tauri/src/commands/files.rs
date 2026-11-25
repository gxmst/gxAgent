use super::config::effective_work_dir;
use crate::{text, tools};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

const PARSED_FILE_CONTENT_LIMIT: usize = 250_000;
const IMAGE_ATTACHMENT_LIMIT: u64 = 20 * 1024 * 1024;
const IMAGE_ATTACHMENT_COUNT_LIMIT: usize = 8;
const IMAGE_ATTACHMENT_TOTAL_LIMIT: u64 = 40 * 1024 * 1024;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedFile {
    name: String,
    path: String,
    kind: String,
    content: String,
    mime_type: String,
    truncated: bool,
    warning: Option<String>,
}

/// Read a file (for workspace file viewer)
#[tauri::command]
pub async fn read_file_content(path: String, work_dir: Option<String>) -> Result<String, String> {
    let work_dir = effective_work_dir(work_dir)?;
    let result = tools::execute_tool(
        "read_file",
        &serde_json::json!({"path": path}).to_string(),
        &work_dir,
        "duckduckgo",
        "",
    )
    .await;
    if result.starts_with("Error:") {
        Err(result)
    } else {
        Ok(result)
    }
}

/// Save code block content to a local file (with native save dialog)
#[tauri::command]
pub async fn save_code_file(
    app: AppHandle,
    content: String,
    language: String,
) -> Result<String, String> {
    let ext_map: HashMap<&str, &str> = [
        ("javascript", "js"),
        ("typescript", "ts"),
        ("python", "py"),
        ("rust", "rs"),
        ("go", "go"),
        ("java", "java"),
        ("c", "c"),
        ("cpp", "cpp"),
        ("csharp", "cs"),
        ("ruby", "rb"),
        ("php", "php"),
        ("swift", "swift"),
        ("kotlin", "kt"),
        ("scala", "scala"),
        ("html", "html"),
        ("css", "css"),
        ("json", "json"),
        ("yaml", "yaml"),
        ("toml", "toml"),
        ("xml", "xml"),
        ("sql", "sql"),
        ("sh", "sh"),
        ("bash", "sh"),
        ("powershell", "ps1"),
        ("dockerfile", "dockerfile"),
        ("markdown", "md"),
        ("text", "txt"),
    ]
    .iter()
    .cloned()
    .collect();

    let ext = ext_map.get(language.as_str()).unwrap_or(&"txt");

    let dialog = app.dialog();
    let (tx, rx) = tokio::sync::oneshot::channel();
    dialog
        .file()
        .add_filter("Code File", &[ext])
        .set_file_name(format!("untitled.{}", ext))
        .save_file(move |path| {
            let _ = tx.send(path);
        });

    match rx.await {
        Ok(Some(path)) => {
            let path_str = path.to_string();
            std::fs::write(&path_str, &content).map_err(|e| format!("Failed to save: {}", e))?;
            Ok(path_str)
        }
        Ok(None) => Ok("Cancelled".to_string()),
        Err(_) => Err("Save dialog failed".to_string()),
    }
}

/// Choose a workspace folder with the native directory picker.
#[tauri::command]
pub async fn pick_workspace_directory(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path.map(|selected| selected.to_string()));
    });

    rx.await.map_err(|_| "Workspace dialog failed".to_string())
}

fn file_kind_and_mime(extension: &str) -> (&'static str, &'static str) {
    match extension {
        "pdf" => ("pdf", "application/pdf"),
        "docx" => (
            "document",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ),
        "xlsx" => (
            "spreadsheet",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ),
        "pptx" => (
            "presentation",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ),
        "csv" | "tsv" => ("spreadsheet", "text/csv"),
        "json" => ("json", "application/json"),
        "md" | "markdown" => ("text", "text/markdown"),
        "png" => ("image", "image/png"),
        "jpg" | "jpeg" => ("image", "image/jpeg"),
        "gif" => ("image", "image/gif"),
        "webp" => ("image", "image/webp"),
        "svg" => ("image", "image/svg+xml"),
        _ => ("text", "text/plain"),
    }
}

fn limited_content(content: String) -> (String, bool) {
    if content.len() <= PARSED_FILE_CONTENT_LIMIT {
        return (content, false);
    }
    (
        text::utf8_prefix(&content, PARSED_FILE_CONTENT_LIMIT).to_string(),
        true,
    )
}

pub(crate) async fn extract_pdf_text(path: &Path) -> Result<String, String> {
    let mut command = tokio::process::Command::new("pdftotext");
    command.args(["-layout", &path.to_string_lossy(), "-"]);
    command.kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = tokio::time::timeout(std::time::Duration::from_secs(30), command.output())
        .await
        .map_err(|_| "PDF extraction timed out after 30s".to_string())?
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "PDF text extraction requires 'pdftotext' (Poppler) in PATH".to_string()
            } else {
                format!("Failed to start pdftotext: {}", e)
            }
        })?;
    if !output.status.success() {
        return Err(format!(
            "pdftotext failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(windows)]
pub(crate) async fn extract_office_text(path: &Path, extension: &str) -> Result<String, String> {
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Read-Entry($entry) {
  $reader = New-Object System.IO.StreamReader($entry.Open())
  try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}
function Decode-XmlText([string]$value) {
  return [System.Net.WebUtility]::HtmlDecode([regex]::Replace($value, '<[^>]+>', ''))
}
$archive = [System.IO.Compression.ZipFile]::OpenRead($env:GXAGENT_FILE_PATH)
try {
  switch ($env:GXAGENT_OFFICE_KIND) {
    'docx' {
      $entry = $archive.GetEntry('word/document.xml')
      if ($null -eq $entry) { throw 'word/document.xml is missing' }
      $xml = Read-Entry $entry
      $xml = $xml -replace '</w:p>', "`n" -replace '<w:tab[^>]*/>', "`t" -replace '<w:br[^>]*/>', "`n"
      Decode-XmlText $xml
    }
    'pptx' {
      $slides = $archive.Entries | Where-Object { $_.FullName -match '^ppt/slides/slide[0-9]+\.xml$' } | Sort-Object { if ($_.Name -match 'slide([0-9]+)') { [int]$Matches[1] } else { 0 } }
      foreach ($slide in $slides) {
        "`n--- $($slide.Name) ---"
        $xml = (Read-Entry $slide) -replace '</a:p>', "`n"
        Decode-XmlText $xml
      }
    }
    'xlsx' {
      $shared = @()
      $sharedEntry = $archive.GetEntry('xl/sharedStrings.xml')
      if ($null -ne $sharedEntry) {
        $sharedXml = Read-Entry $sharedEntry
        foreach ($item in [regex]::Matches($sharedXml, '(?s)<si(?:\s[^>]*)?>(.*?)</si>')) {
          $parts = [regex]::Matches($item.Groups[1].Value, '(?s)<t(?:\s[^>]*)?>(.*?)</t>') | ForEach-Object { [System.Net.WebUtility]::HtmlDecode($_.Groups[1].Value) }
          $shared += ($parts -join '')
        }
      }
      $sheets = $archive.Entries | Where-Object { $_.FullName -match '^xl/worksheets/sheet[0-9]+\.xml$' } | Sort-Object { if ($_.Name -match 'sheet([0-9]+)') { [int]$Matches[1] } else { 0 } }
      foreach ($sheet in $sheets) {
        "`n--- $($sheet.Name) ---"
        $xml = Read-Entry $sheet
        foreach ($cell in [regex]::Matches($xml, '(?s)<c\b([^>]*)>(.*?)</c>')) {
          $attrs = $cell.Groups[1].Value
          $body = $cell.Groups[2].Value
          $refMatch = [regex]::Match($attrs, '\br="([^"]+)"')
          $typeMatch = [regex]::Match($attrs, '\bt="([^"]+)"')
          $valueMatch = [regex]::Match($body, '(?s)<v>(.*?)</v>')
          $value = ''
          if ($typeMatch.Success -and $typeMatch.Groups[1].Value -eq 'inlineStr') {
            $value = Decode-XmlText $body
          } elseif ($valueMatch.Success) {
            $value = [System.Net.WebUtility]::HtmlDecode($valueMatch.Groups[1].Value)
            if ($typeMatch.Success -and $typeMatch.Groups[1].Value -eq 's') {
              $index = 0
              if ([int]::TryParse($value, [ref]$index) -and $index -lt $shared.Count) { $value = $shared[$index] }
            }
          }
          if ($value -ne '') { "$($refMatch.Groups[1].Value)`t$value" }
        }
      }
    }
  }
} finally {
  $archive.Dispose()
}
"#;

    let mut command = tokio::process::Command::new("powershell");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .env("GXAGENT_FILE_PATH", path)
        .env("GXAGENT_OFFICE_KIND", extension)
        .kill_on_drop(true)
        .creation_flags(0x08000000);
    let output = tokio::time::timeout(std::time::Duration::from_secs(30), command.output())
        .await
        .map_err(|_| "Office extraction timed out after 30s".to_string())?
        .map_err(|e| format!("Failed to start Office extractor: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "Office extraction failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(not(windows))]
pub(crate) async fn extract_office_text(_path: &Path, _extension: &str) -> Result<String, String> {
    Err("Office extraction is currently available on Windows only".to_string())
}

async fn parse_file_detailed(path: &Path) -> Result<ParsedFile, String> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|e| format!("Cannot access '{}': {}", path.display(), e))?;
    if !metadata.is_file() {
        return Err(format!("Not a file: {}", path.display()));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let (kind, mime_type) = file_kind_and_mime(&extension);
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());

    if kind == "image" {
        if metadata.len() > IMAGE_ATTACHMENT_LIMIT {
            return Err(format!(
                "Image exceeds the {} MB attachment limit",
                IMAGE_ATTACHMENT_LIMIT / 1024 / 1024
            ));
        }
        let bytes = tokio::fs::read(path)
            .await
            .map_err(|e| format!("Failed to read image: {}", e))?;
        return Ok(ParsedFile {
            name,
            path: path.to_string_lossy().to_string(),
            kind: kind.to_string(),
            content: BASE64.encode(bytes),
            mime_type: mime_type.to_string(),
            truncated: false,
            warning: None,
        });
    }

    let extracted = match extension.as_str() {
        "pdf" => extract_pdf_text(path).await,
        "docx" | "xlsx" | "pptx" => extract_office_text(path, &extension).await,
        _ => tokio::fs::read_to_string(path)
            .await
            .map_err(|e| format!("File is not readable text: {}", e)),
    };
    let (content, mut warning) = match extracted {
        Ok(content) => (content, None),
        Err(error) if matches!(extension.as_str(), "pdf" | "docx" | "xlsx" | "pptx") => {
            (String::new(), Some(error))
        }
        Err(error) => return Err(error),
    };
    let content = if extension == "json" && !content.trim().is_empty() {
        match serde_json::from_str::<Value>(&content) {
            Ok(value) => serde_json::to_string_pretty(&value).unwrap_or(content),
            Err(error) => {
                warning = Some(format!(
                    "JSON format is invalid ({}); attached as the original text.",
                    error
                ));
                content
            }
        }
    } else {
        content
    };
    let (content, truncated) = limited_content(content);
    Ok(ParsedFile {
        name,
        path: path.to_string_lossy().to_string(),
        kind: kind.to_string(),
        content,
        mime_type: mime_type.to_string(),
        truncated,
        warning,
    })
}

#[tauri::command]
pub async fn parse_file_content_detailed(path: String) -> Result<ParsedFile, String> {
    parse_file_detailed(Path::new(&path)).await
}

#[tauri::command]
pub async fn pick_and_parse_files(app: AppHandle) -> Result<Vec<ParsedFile>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_files(move |paths| {
        let _ = tx.send(paths);
    });
    let paths = rx
        .await
        .map_err(|_| "File picker closed unexpectedly".to_string())?
        .unwrap_or_default();
    let mut parsed = Vec::with_capacity(paths.len());
    let mut image_count = 0usize;
    let mut image_bytes = 0u64;
    for path in paths {
        let path = PathBuf::from(path.to_string());
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let (kind, mime_type) = file_kind_and_mime(&extension);
        if kind == "image" {
            if let Ok(metadata) = tokio::fs::metadata(&path).await {
                if metadata.len() <= IMAGE_ATTACHMENT_LIMIT
                    && (image_count >= IMAGE_ATTACHMENT_COUNT_LIMIT
                        || image_bytes + metadata.len() > IMAGE_ATTACHMENT_TOTAL_LIMIT)
                {
                    parsed.push(ParsedFile {
                        name: path
                            .file_name()
                            .map(|value| value.to_string_lossy().to_string())
                            .unwrap_or_else(|| path.to_string_lossy().to_string()),
                        path: path.to_string_lossy().to_string(),
                        kind: kind.to_string(),
                        content: String::new(),
                        mime_type: mime_type.to_string(),
                        truncated: false,
                        warning: Some(format!(
                            "Image selection exceeds the {} file / {} MB total limit",
                            IMAGE_ATTACHMENT_COUNT_LIMIT,
                            IMAGE_ATTACHMENT_TOTAL_LIMIT / 1024 / 1024
                        )),
                    });
                    continue;
                }
                if metadata.len() <= IMAGE_ATTACHMENT_LIMIT {
                    image_count += 1;
                    image_bytes += metadata.len();
                }
            }
        }
        match parse_file_detailed(&path).await {
            Ok(file) => parsed.push(file),
            Err(error) => {
                parsed.push(ParsedFile {
                    name: path
                        .file_name()
                        .map(|value| value.to_string_lossy().to_string())
                        .unwrap_or_else(|| path.to_string_lossy().to_string()),
                    path: path.to_string_lossy().to_string(),
                    kind: kind.to_string(),
                    content: String::new(),
                    mime_type: mime_type.to_string(),
                    truncated: false,
                    warning: Some(error),
                });
            }
        }
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn invalid_json_is_kept_as_plain_text_with_warning() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("gxagent-invalid-json-{}.json", unique));
        let source = "{ invalid json: true";
        tokio::fs::write(&path, source).await.unwrap();

        let parsed = parse_file_detailed(&path).await.unwrap();
        let _ = tokio::fs::remove_file(&path).await;

        assert_eq!(parsed.content, source);
        assert!(parsed
            .warning
            .as_deref()
            .unwrap_or_default()
            .contains("attached as the original text"));
    }
}
