use super::web_search::is_safe_url;
use crate::text::utf8_prefix;
use futures_util::StreamExt;
use std::time::Duration;

const MAX_FETCH_BYTES: usize = 512 * 1024;
const DEFAULT_MAX_CHARS: usize = 20_000;
const MIN_MAX_CHARS: usize = 500;
const MAX_MAX_CHARS: usize = 50_000;
const MAX_REDIRECTS: usize = 5;
const GXAGENT_FETCH_UA: &str = "gxAgent/1.4 (+https://github.com/gxmst/gxAgent)";

/// Fetch a public HTTP(S) page with SSRF redirect protection and return clean,
/// token-bounded readable text or Markdown.
pub(super) async fn run_web_fetch(url: &str, max_chars: Option<usize>) -> Result<String, String> {
    let url = url.trim();
    if !is_safe_url(url) {
        return Err("Refusing to fetch blocked, private, or non-HTTP(S) URL.".to_string());
    }

    let redirect_policy = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= MAX_REDIRECTS {
            attempt.error("Too many redirects")
        } else if !is_safe_url(attempt.url().as_str()) {
            attempt.error("Redirect target is blocked by URL safety policy")
        } else {
            attempt.follow()
        }
    });

    let client = reqwest::Client::builder()
        .redirect(redirect_policy)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .user_agent(GXAGENT_FETCH_UA)
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let response = client
        .get(url)
        .header(
            reqwest::header::ACCEPT,
            "text/markdown, text/html, application/json, text/plain;q=0.9, */*;q=0.5",
        )
        .send()
        .await
        .map_err(|e| format!("Fetch failed: {}", e))?;

    let final_url = response.url().to_string();
    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP error ({}) fetching {}", status, final_url));
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("text/plain")
        .to_string();
    let ct_lower = content_type.to_ascii_lowercase();
    if !ct_lower.starts_with("text/")
        && !ct_lower.contains("json")
        && !ct_lower.contains("xml")
        && !ct_lower.contains("javascript")
    {
        return Err(format!(
            "Unsupported content-type '{}' for web_fetch.",
            content_type
        ));
    }

    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    let mut byte_capped = false;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream read error: {}", e))?;
        let remaining = MAX_FETCH_BYTES.saturating_sub(bytes.len());
        if chunk.len() > remaining {
            bytes.extend_from_slice(&chunk[..remaining]);
            byte_capped = true;
            break;
        }
        bytes.extend_from_slice(&chunk);
    }

    let raw = String::from_utf8_lossy(&bytes).into_owned();
    let body = if ct_lower.contains("html")
        || raw
            .trim_start()
            .to_ascii_lowercase()
            .starts_with("<!doctype")
        || raw.trim_start().to_ascii_lowercase().starts_with("<html")
    {
        html_to_readable_text(&raw)
    } else {
        raw
    };

    let limit = max_chars
        .unwrap_or(DEFAULT_MAX_CHARS)
        .clamp(MIN_MAX_CHARS, MAX_MAX_CHARS);
    let (content, char_truncated) = if body.len() > limit {
        (utf8_prefix(&body, limit).to_string(), true)
    } else {
        (body, false)
    };

    let mut out = format!(
        "URL: {}\nContent-Type: {}\n\n{}",
        final_url, content_type, content
    );
    if byte_capped || char_truncated {
        out.push_str("\n\n[Content truncated]");
    }
    Ok(out)
}

/// Strip noisy scripts/styles/tags and normalize block breaks & basic entities.
pub(super) fn html_to_readable_text(html: &str) -> String {
    let mut cleaned = html.to_string();
    for tag in ["script", "style", "noscript", "svg"] {
        cleaned = strip_tag_block(&cleaned, tag);
    }
    cleaned = strip_delimited(&cleaned, "<!--", "-->");

    let mut out = String::with_capacity(cleaned.len() / 2);
    let mut in_tag = false;
    let mut tag_buf = String::new();
    for ch in cleaned.chars() {
        if in_tag {
            if ch == '>' {
                in_tag = false;
                let tag = tag_buf.trim().to_ascii_lowercase();
                let name = tag
                    .trim_start_matches('/')
                    .split_whitespace()
                    .next()
                    .unwrap_or("");
                if matches!(
                    name,
                    "br" | "p"
                        | "div"
                        | "section"
                        | "article"
                        | "li"
                        | "tr"
                        | "pre"
                        | "h1"
                        | "h2"
                        | "h3"
                        | "h4"
                        | "h5"
                        | "h6"
                        | "blockquote"
                ) {
                    if !out.ends_with('\n') {
                        out.push('\n');
                    }
                    if tag.starts_with("li") {
                        out.push_str("- ");
                    }
                }
                tag_buf.clear();
            } else {
                tag_buf.push(ch);
            }
        } else if ch == '<' {
            in_tag = true;
        } else {
            out.push(ch);
        }
    }

    let decoded = out
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ");

    let mut lines = Vec::new();
    let mut blank_run = 0usize;
    for line in decoded.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            blank_run += 1;
            if blank_run <= 1 && !lines.is_empty() {
                lines.push(String::new());
            }
        } else {
            blank_run = 0;
            lines.push(trimmed.to_string());
        }
    }
    lines.join("\n").trim().to_string()
}

fn strip_tag_block(input: &str, tag: &str) -> String {
    let open = format!("<{}", tag);
    let close = format!("</{}>", tag);
    let mut result = input.to_string();
    loop {
        let lower = result.to_ascii_lowercase();
        let Some(start) = lower.find(&open) else {
            break;
        };
        let end = lower[start..]
            .find(&close)
            .map(|offset| start + offset + close.len())
            .unwrap_or(result.len());
        result.replace_range(start..end, " ");
    }
    result
}

fn strip_delimited(input: &str, open: &str, close: &str) -> String {
    let mut result = input.to_string();
    while let Some(start) = result.find(open) {
        let end = result[start..]
            .find(close)
            .map(|offset| start + offset + close.len())
            .unwrap_or(result.len());
        result.replace_range(start..end, " ");
    }
    result
}
