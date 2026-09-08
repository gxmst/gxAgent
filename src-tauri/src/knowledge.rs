use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri_plugin_dialog::DialogExt;

fn hash(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

#[tauri::command]
pub async fn pick_knowledge_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter(
            "Documents",
            &[
                "md", "txt", "markdown", "csv", "json", "rst", "pdf", "docx", "xlsx", "pptx",
            ],
        )
        .pick_files(move |paths| {
            let _ = tx.send(paths);
        });
    let paths = rx.await.map_err(|e| e.to_string())?.unwrap_or_default();
    if paths.len() > 50 {
        return Err("Select at most 50 documents at a time".into());
    }
    paths
        .into_iter()
        .map(|p| {
            p.into_path()
                .map(|p| p.to_string_lossy().into_owned())
                .map_err(|e| e.to_string())
        })
        .collect()
}

fn database() -> Result<Connection, String> {
    let dir = dirs::data_dir()
        .ok_or("No application data directory")?
        .join("gxAgent");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let db = Connection::open(dir.join("knowledge.sqlite3")).map_err(|e| e.to_string())?;
    initialize(&db)?;
    Ok(db)
}

fn initialize(db: &Connection) -> Result<(), String> {
    db.busy_timeout(std::time::Duration::from_secs(10))
        .map_err(|e| e.to_string())?;
    let version: u32 = db
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if version > 1 {
        return Err(format!(
            "Knowledge database version {version} requires a newer gxAgent"
        ));
    }
    db.execute_batch("PRAGMA journal_mode=WAL;
        PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, path TEXT NOT NULL, title TEXT NOT NULL, scope TEXT NOT NULL, hash TEXT NOT NULL, updated INTEGER NOT NULL, chunk_size INTEGER NOT NULL, overlap INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, text TEXT NOT NULL, start_char INTEGER NOT NULL, end_char INTEGER NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(terms, chunk_id UNINDEXED, document_id UNINDEXED, tokenize='unicode61');
        CREATE TABLE IF NOT EXISTS eval_cases(id TEXT PRIMARY KEY, scope TEXT NOT NULL, question TEXT NOT NULL, expected_document_id TEXT);
        CREATE TABLE IF NOT EXISTS eval_runs(id TEXT PRIMARY KEY, scope TEXT NOT NULL, created INTEGER NOT NULL, result TEXT NOT NULL);
        PRAGMA user_version=1;").map_err(|e| e.to_string())
}

fn scope_key(scope: &str) -> Result<String, String> {
    if scope.is_empty() {
        return Ok(String::new());
    }
    let path = std::fs::canonicalize(scope).map_err(|e| format!("Invalid project: {e}"))?;
    if !path.is_dir() {
        return Err("Project must be a directory".into());
    }
    let key = path.to_string_lossy().into_owned();
    Ok(if cfg!(windows) {
        key.to_lowercase()
    } else {
        key
    })
}

// SQLite performs BM25 ranking; CJK bigrams make its Unicode tokenizer useful for Chinese.
fn terms(text: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut word = String::new();
    let mut cjk = Vec::new();
    let flush = |word: &mut String, cjk: &mut Vec<char>, result: &mut Vec<String>| {
        if !word.is_empty() {
            result.push(std::mem::take(word));
        }
        if cjk.len() == 1 {
            result.push(cjk[0].to_string());
        } else {
            result.extend(cjk.windows(2).map(|w| w.iter().collect()));
        }
        cjk.clear();
    };
    for ch in text.to_lowercase().chars() {
        if ('\u{3400}'..='\u{9fff}').contains(&ch) {
            if !word.is_empty() {
                result.push(std::mem::take(&mut word));
            }
            cjk.push(ch);
        } else if ch.is_alphanumeric() || ch == '_' {
            if !cjk.is_empty() {
                flush(&mut word, &mut cjk, &mut result);
            }
            word.push(ch);
        } else {
            flush(&mut word, &mut cjk, &mut result);
        }
    }
    flush(&mut word, &mut cjk, &mut result);
    result
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    id: String,
    path: String,
    title: String,
    scope: String,
    updated_at: i64,
    chunks: i64,
    chunk_size: i64,
    overlap: i64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub chunk_id: String,
    pub document_id: String,
    pub path: String,
    pub title: String,
    pub text: String,
    pub score: f64,
    pub start_char: u32,
    pub end_char: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchReport {
    pub query: String,
    pub hits: Vec<Hit>,
    pub duration_ms: u128,
    pub mode: String,
    pub top_k: usize,
}

fn index_text(
    db: &mut Connection,
    path: &str,
    title: &str,
    scope: &str,
    text: &str,
    chunk_size: usize,
    overlap: usize,
) -> Result<String, String> {
    if !(200..=4000).contains(&chunk_size) || overlap >= chunk_size / 2 {
        return Err("Chunk size must be 200..4000, overlap less than half the chunk size".into());
    }
    if text.trim().is_empty() || text.len() > 8 * 1024 * 1024 {
        return Err("Document must contain text and be at most 8 MB after extraction".into());
    }
    let normalized_path = if cfg!(windows) {
        path.to_lowercase()
    } else {
        path.into()
    };
    let id = hash(&format!("{scope}\0{normalized_path}"));
    let content_hash = hash(text);
    let chars: Vec<char> = text.chars().collect();
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM search_index WHERE document_id=?1", [&id])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM chunks WHERE document_id=?1", [&id])
        .map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO documents VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO UPDATE SET title=excluded.title,hash=excluded.hash,updated=excluded.updated,chunk_size=excluded.chunk_size,overlap=excluded.overlap",
        params![id,path,title,scope,content_hash,chrono::Utc::now().timestamp_millis(),chunk_size as u32,overlap as u32]).map_err(|e| e.to_string())?;
    for (ordinal, start) in (0..chars.len()).step_by(chunk_size - overlap).enumerate() {
        let end = (start + chunk_size).min(chars.len());
        let chunk: String = chars[start..end].iter().collect();
        let chunk_id = format!("{}:{}:{start}", &id[..16], &content_hash[..16]);
        tx.execute(
            "INSERT INTO chunks VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                chunk_id,
                id,
                ordinal as u32,
                chunk,
                start as u32,
                end as u32
            ],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO search_index(terms,chunk_id,document_id) VALUES(?1,?2,?3)",
            params![terms(&format!("{title} {chunk}")).join(" "), chunk_id, id],
        )
        .map_err(|e| e.to_string())?;
        if end == chars.len() {
            break;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub async fn index_knowledge_file(
    path: String,
    scope: String,
    chunk_size: usize,
    overlap: usize,
) -> Result<String, String> {
    let scope = scope_key(&scope)?;
    let path = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > 30 * 1024 * 1024 {
        return Err("Select a document smaller than 30 MB".into());
    }
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let text = match extension.as_str() {
        "pdf" => crate::extract_pdf_text(&path).await?,
        "docx" | "xlsx" | "pptx" => crate::extract_office_text(&path, &extension).await?,
        "md" | "txt" | "markdown" | "csv" | "json" | "rst" => tokio::fs::read_to_string(&path)
            .await
            .map_err(|e| e.to_string())?,
        _ => {
            return Err(
                "Supported documents: md, txt, csv, json, rst, pdf, docx, xlsx, pptx".into(),
            )
        }
    };
    let title = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let path = path.to_string_lossy().into_owned();
    tokio::task::spawn_blocking(move || {
        index_text(
            &mut database()?,
            &path,
            &title,
            &scope,
            &text,
            chunk_size,
            overlap,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn list_knowledge_documents(scope: String) -> Result<Vec<Document>, String> {
    let scope = scope_key(&scope)?;
    let db = database()?;
    let mut statement = db.prepare("SELECT d.id,d.path,d.title,d.scope,d.updated,count(c.id),d.chunk_size,d.overlap FROM documents d LEFT JOIN chunks c ON d.id=c.document_id WHERE d.scope='' OR d.scope=?1 GROUP BY d.id ORDER BY d.updated DESC").map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([scope], |r| {
            Ok(Document {
                id: r.get(0)?,
                path: r.get(1)?,
                title: r.get(2)?,
                scope: r.get(3)?,
                updated_at: r.get(4)?,
                chunks: r.get(5)?,
                chunk_size: r.get(6)?,
                overlap: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_knowledge_document(id: String) -> Result<(), String> {
    let mut db = database()?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM search_index WHERE document_id=?1", [&id])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM documents WHERE id=?1", [&id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

fn search(
    db: &Connection,
    query: &str,
    scope: &str,
    top_k: usize,
    mode: &str,
) -> Result<SearchReport, String> {
    let started = std::time::Instant::now();
    if query.chars().count() > 2000 || query.trim().is_empty() {
        return Err("Search query must contain 1..2000 characters".into());
    }
    if !["any", "all"].contains(&mode) {
        return Err("Invalid retrieval mode".into());
    }
    let top_k = top_k.clamp(1, 20);
    let mut query_terms = terms(query);
    query_terms.sort();
    query_terms.dedup();
    query_terms.truncate(80);
    let expression = query_terms
        .iter()
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(if mode == "all" { " AND " } else { " OR " });
    let mut hits = Vec::new();
    if !expression.is_empty() {
        let mut stmt = db.prepare("SELECT c.id,d.id,d.path,d.title,c.text,-bm25(search_index),c.start_char,c.end_char FROM search_index JOIN chunks c ON c.id=search_index.chunk_id JOIN documents d ON d.id=c.document_id WHERE search_index MATCH ?1 AND (d.scope='' OR d.scope=?2) ORDER BY bm25(search_index),c.id LIMIT ?3").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![expression, scope, top_k as u32], |r| {
                Ok(Hit {
                    chunk_id: r.get(0)?,
                    document_id: r.get(1)?,
                    path: r.get(2)?,
                    title: r.get(3)?,
                    text: r.get(4)?,
                    score: r.get(5)?,
                    start_char: r.get(6)?,
                    end_char: r.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;
        hits = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
    }
    Ok(SearchReport {
        query: query.into(),
        hits,
        duration_ms: started.elapsed().as_millis(),
        mode: mode.into(),
        top_k,
    })
}

#[tauri::command]
pub fn search_knowledge(
    query: String,
    scope: String,
    top_k: usize,
    mode: String,
) -> Result<SearchReport, String> {
    search(&database()?, &query, &scope_key(&scope)?, top_k, &mode)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalCase {
    pub id: String,
    pub question: String,
    pub expected_document_id: Option<String>,
}

fn cases(db: &Connection, scope: &str) -> Result<Vec<EvalCase>, String> {
    let mut statement = db
        .prepare(
            "SELECT id,question,expected_document_id FROM eval_cases WHERE scope=?1 ORDER BY rowid",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([scope], |r| {
            Ok(EvalCase {
                id: r.get(0)?,
                question: r.get(1)?,
                expected_document_id: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn knowledge_evaluations(scope: String) -> Result<Value, String> {
    let scope = scope_key(&scope)?;
    let db = database()?;
    let mut stmt = db
        .prepare("SELECT result FROM eval_runs WHERE scope=?1 ORDER BY created DESC LIMIT 20")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([&scope], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let runs: Vec<Value> = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?
        .iter()
        .filter_map(|s| serde_json::from_str(s).ok())
        .collect();
    Ok(json!({"cases":cases(&db,&scope)?,"runs":runs}))
}

#[tauri::command]
pub fn save_knowledge_case(
    scope: String,
    question: String,
    expected_document_id: Option<String>,
) -> Result<(), String> {
    let scope = scope_key(&scope)?;
    if question.trim().is_empty() || question.chars().count() > 2000 {
        return Err("Question must contain 1..2000 characters".into());
    }
    let db = database()?;
    if cases(&db, &scope)?.len() >= 200 {
        return Err("Maximum 200 evaluation cases per project".into());
    }
    if let Some(id) = &expected_document_id {
        let exists: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM documents WHERE id=?1 AND (scope='' OR scope=?2))",
                params![id, scope],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !exists {
            return Err("Expected document is not in this project".into());
        }
    }
    db.execute(
        "INSERT INTO eval_cases VALUES(?1,?2,?3,?4)",
        params![
            uuid::Uuid::new_v4().to_string(),
            scope,
            question,
            expected_document_id
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_knowledge_case(id: String) -> Result<(), String> {
    database()?
        .execute("DELETE FROM eval_cases WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn run_knowledge_evaluation(
    scope: String,
    top_k: usize,
    mode: String,
) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        evaluate(&mut database()?, &scope_key(&scope)?, top_k, &mode)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn evaluate(db: &mut Connection, scope: &str, top_k: usize, mode: &str) -> Result<Value, String> {
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let cases = cases(&tx, scope)?;
    if cases.is_empty() {
        return Err("Add evaluation questions first".into());
    }
    let mut results = Vec::new();
    let mut reciprocal = 0.0;
    let mut hit_count = 0;
    let mut answerable = 0;
    let mut no_answer_correct = 0;
    for case in &cases {
        if let Some(id) = &case.expected_document_id {
            let exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM documents WHERE id=?1)",
                    [id],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if !exists {
                return Err(format!(
                    "Expected document was removed for question: {}",
                    case.question
                ));
            }
        }
        let report = search(&tx, &case.question, scope, top_k, mode)?;
        let rank = case
            .expected_document_id
            .as_ref()
            .and_then(|id| report.hits.iter().position(|h| &h.document_id == id))
            .map(|i| i + 1);
        if case.expected_document_id.is_some() {
            answerable += 1;
            if let Some(rank) = rank {
                hit_count += 1;
                reciprocal += 1.0 / rank as f64;
            }
        } else if report.hits.is_empty() {
            no_answer_correct += 1;
        }
        results.push(json!({"case":case,"rank":rank,"report":report}));
    }
    let mut stmt = tx.prepare("SELECT id,hash,chunk_size,overlap FROM documents WHERE scope='' OR scope=?1 ORDER BY id").map_err(|e|e.to_string())?;
    let revisions = stmt
        .query_map([&scope], |r| {
            Ok(format!(
                "{}:{}:{}:{}",
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, u32>(2)?,
                r.get::<_, u32>(3)?
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    let id = uuid::Uuid::new_v4().to_string();
    let created = chrono::Utc::now().timestamp_millis();
    let result = json!({"id":id,"createdAt":created,"topK":top_k.clamp(1,20),"mode":mode,"indexRevision":hash(&revisions.join("\n")),"answerable":answerable,"hitRate":if answerable>0 {Some(hit_count as f64/answerable as f64)}else{None},"mrr":if answerable>0 {Some(reciprocal/answerable as f64)}else{None},"unanswerable":cases.len()-answerable,"noAnswerCorrect":no_answer_correct,"results":results});
    tx.execute(
        "INSERT INTO eval_runs VALUES(?1,?2,?3,?4)",
        params![id, scope, created, result.to_string()],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn index_update_scope_and_chinese_retrieval() {
        let mut db = Connection::open_in_memory().unwrap();
        initialize(&db).unwrap();
        let id = index_text(
            &mut db,
            "/docs/a.md",
            "安装指南",
            "a",
            "系统安装完成后，可以使用知识检索功能。",
            200,
            20,
        )
        .unwrap();
        index_text(&mut db, "/docs/b.md", "Other", "b", "知识检索", 200, 20).unwrap();
        let report = search(&db, "知识检索", "a", 5, "all").unwrap();
        assert_eq!(report.hits.len(), 1);
        assert_eq!(report.hits[0].document_id, id);
        index_text(
            &mut db,
            "/docs/a.md",
            "安装指南",
            "a",
            "内容已更新，现在只有部署说明。",
            200,
            20,
        )
        .unwrap();
        assert!(search(&db, "知识检索", "a", 5, "all")
            .unwrap()
            .hits
            .is_empty());
        assert_eq!(
            search(&db, "部署说明", "a", 5, "all").unwrap().hits.len(),
            1
        );
        assert!(search(&db, "\" OR *", "a", 5, "any").is_ok());
    }
    #[test]
    fn invalid_reindex_does_not_destroy_existing_chunks() {
        let mut db = Connection::open_in_memory().unwrap();
        initialize(&db).unwrap();
        index_text(&mut db, "a.txt", "guide", "", "backup restore", 200, 20).unwrap();
        assert!(index_text(&mut db, "a.txt", "guide", "", "", 200, 20).is_err());
        assert_eq!(search(&db, "backup", "", 5, "any").unwrap().hits.len(), 1);
    }

    #[test]
    fn evaluation_persists_metrics_and_detects_corpus_changes() {
        let mut db = Connection::open_in_memory().unwrap();
        initialize(&db).unwrap();
        let id = index_text(
            &mut db,
            "a.txt",
            "Guide",
            "project",
            "backup restore",
            200,
            20,
        )
        .unwrap();
        db.execute(
            "INSERT INTO eval_cases VALUES('hit','project','backup',?1)",
            [&id],
        )
        .unwrap();
        db.execute(
            "INSERT INTO eval_cases VALUES('missing','project','unmatched',?1)",
            [&id],
        )
        .unwrap();
        db.execute(
            "INSERT INTO eval_cases VALUES('none','project','unavailable',NULL)",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO eval_cases VALUES('other','different','backup',NULL)",
            [],
        )
        .unwrap();
        let first = evaluate(&mut db, "project", 5, "any").unwrap();
        assert_eq!(first["hitRate"], 0.5);
        assert_eq!(first["mrr"], 0.5);
        assert_eq!(first["unanswerable"], 1);
        assert_eq!(first["noAnswerCorrect"], 1);
        assert_eq!(first["results"].as_array().unwrap().len(), 3);
        let stored: String = db
            .query_row(
                "SELECT result FROM eval_runs WHERE id=?1",
                [first["id"].as_str().unwrap()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&stored).unwrap(), first);
        index_text(
            &mut db,
            "a.txt",
            "Guide",
            "project",
            "backup restore unmatched",
            200,
            20,
        )
        .unwrap();
        let second = evaluate(&mut db, "project", 5, "any").unwrap();
        assert_ne!(first["indexRevision"], second["indexRevision"]);
        assert_eq!(second["hitRate"], 1.0);
        db.execute("DELETE FROM documents WHERE id=?1", [id])
            .unwrap();
        assert!(evaluate(&mut db, "project", 5, "any")
            .unwrap_err()
            .contains("removed"));
        let count: u32 = db
            .query_row("SELECT COUNT(*) FROM eval_runs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn future_database_version_is_preserved() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA user_version=2").unwrap();
        assert!(initialize(&db).unwrap_err().contains("newer gxAgent"));
        let version: u32 = db
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 2);
    }
}
