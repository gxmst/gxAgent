use crate::text::utf8_prefix;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static LAST_SEARCH_TIME: AtomicU64 = AtomicU64::new(0);
static CONSECUTIVE_FAILURES: AtomicU64 = AtomicU64::new(0);
const MIN_SEARCH_INTERVAL_SECS: u64 = 2;
const MAX_CONSECUTIVE_FAILURES: u64 = 5;
const GXAGENT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 gxAgent/1.4 (Contact: support@gxagent.dev; open-source-client)";

pub(super) async fn run_web_search(
    query: &str,
    provider: &str,
    api_key: &str,
) -> Result<String, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("Search query is missing or empty.".to_string());
    }
    match provider {
        "tavily" => {
            if api_key.is_empty() {
                return Err(
                    "Tavily API Key is missing. Please configure it in settings.".to_string(),
                );
            }
            run_tavily_search(query, api_key).await
        }
        "searxng" => run_searxng_search(query).await,
        _ => {
            let ddg_timeout = std::time::Duration::from_secs(8);
            match tokio::time::timeout(ddg_timeout, run_duckduckgo_search(query)).await {
                Ok(Ok(results)) => Ok(results),
                Ok(Err(e)) => {
                    eprintln!("[search] DuckDuckGo failed: {}, trying fallback", e);
                    if !api_key.is_empty() {
                        eprintln!("[search] Falling back to Tavily");
                        run_tavily_search(query, api_key).await
                    } else {
                        Err(format!("DuckDuckGo search failed: {}. Consider configuring a Tavily API key in settings for more reliable search.", e))
                    }
                }
                Err(_) => {
                    eprintln!("[search] DuckDuckGo timed out after 8s, trying fallback");
                    if !api_key.is_empty() {
                        eprintln!("[search] Falling back to Tavily");
                        run_tavily_search(query, api_key).await
                    } else {
                        Err("DuckDuckGo search timed out. Consider configuring a Tavily API key in settings for more reliable search.".to_string())
                    }
                }
            }
        }
    }
}

pub(super) fn is_safe_url(url: &str) -> bool {
    use std::net::IpAddr;

    let parsed = match url.parse::<reqwest::Url>() {
        Ok(parsed) => parsed,
        Err(_) => return false,
    };

    if !matches!(parsed.scheme(), "http" | "https") {
        return false;
    }

    let Some(host) = parsed.host_str() else {
        return false;
    };
    let host = host.trim_matches(['[', ']']).to_lowercase();

    if host == "localhost"
        || host.ends_with(".localhost")
        || host.chars().all(|c| c.is_ascii_digit())
    {
        return false;
    }

    if let Ok(ip) = host.parse::<IpAddr>() {
        match ip {
            IpAddr::V4(ip) => {
                if ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified()
                {
                    return false;
                }
            }
            IpAddr::V6(ip) => {
                if ip.is_loopback()
                    || ip.is_unspecified()
                    || ip.is_unique_local()
                    || ip.is_unicast_link_local()
                    || ip.to_ipv4_mapped().is_some_and(|mapped| {
                        mapped.is_private()
                            || mapped.is_loopback()
                            || mapped.is_link_local()
                            || mapped.is_unspecified()
                    })
                {
                    return false;
                }
            }
        }
    }

    true
}

async fn run_tavily_search(query: &str, api_key: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .connect_timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;
    let response = client
        .post("https://api.tavily.com/search")
        .bearer_auth(api_key)
        .json(&json!({
            "api_key": api_key,
            "query": query,
            "search_depth": "basic",
            "include_answer": true
        }))
        .send()
        .await
        .map_err(|e| format!("Tavily request failed: {}", e))?;

    let status = response.status();
    let response_text = response
        .text()
        .await
        .map_err(|e| format!("Tavily response read error: {}", e))?;

    if !status.is_success() {
        let detail = tavily_error_detail(&response_text);
        return Err(format!("Tavily API error ({}): {}", status, detail));
    }

    let val: Value = serde_json::from_str(&response_text)
        .map_err(|e| format!("Tavily response parse error: {}", e))?;

    CONSECUTIVE_FAILURES.store(0, Ordering::Relaxed);

    Ok(format_tavily_response(&val))
}

pub(super) fn format_tavily_response(val: &Value) -> String {
    let answer = val["answer"].as_str().unwrap_or("").trim();
    if let Some(results) = val["results"].as_array() {
        let items: Vec<String> = results
            .iter()
            .take(5)
            .filter_map(|r| {
                let title = r["title"].as_str().unwrap_or("");
                let url = r["url"].as_str().unwrap_or("");
                let content = r["content"].as_str().unwrap_or("");
                if !is_safe_url(url) {
                    return None;
                }
                if title.is_empty() && content.is_empty() {
                    None
                } else {
                    Some(format!(
                        "Title: {}\nLink: {}\nSnippet: {}",
                        title, url, content
                    ))
                }
            })
            .collect();
        if !items.is_empty() {
            let sources = items.join("\n---\n");
            return if answer.is_empty() {
                sources
            } else {
                format!("Answer: {}\n---\n{}", answer, sources)
            };
        }
    }

    if answer.is_empty() {
        "No results found.".to_string()
    } else {
        format!("Answer: {}", answer)
    }
}

pub(super) fn tavily_error_detail(body: &str) -> String {
    let parsed = serde_json::from_str::<Value>(body).ok();
    let detail = parsed
        .as_ref()
        .and_then(|value| {
            value["detail"]
                .as_str()
                .or_else(|| value["message"].as_str())
                .or_else(|| value["error"].as_str())
        })
        .unwrap_or(body)
        .trim();
    if detail.is_empty() {
        "No error details returned.".to_string()
    } else {
        utf8_prefix(detail, 500).to_string()
    }
}

async fn run_searxng_search(query: &str) -> Result<String, String> {
    let instances = [
        "https://searx.be",
        "https://search.sapti.me",
        "https://searxng.ch",
    ];

    let client = reqwest::Client::builder()
        .user_agent(GXAGENT_UA)
        .timeout(std::time::Duration::from_secs(5))
        .connect_timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let encoded = urlencoding::encode(query);

    for instance in &instances {
        let url = format!(
            "{}/search?q={}&format=json&categories=general",
            instance, encoded
        );
        match client.get(&url).send().await {
            Ok(response) => {
                if !response.status().is_success() {
                    continue;
                }
                match response.json::<Value>().await {
                    Ok(val) => {
                        if let Some(results) = val["results"].as_array() {
                            let items: Vec<String> = results
                                .iter()
                                .take(5)
                                .filter_map(|r| {
                                    let title = r["title"].as_str().unwrap_or("");
                                    let url = r["url"].as_str().unwrap_or("");
                                    let snippet = r["content"].as_str().unwrap_or("");
                                    if !is_safe_url(url) {
                                        return None;
                                    }
                                    if title.is_empty() && snippet.is_empty() {
                                        None
                                    } else {
                                        Some(format!(
                                            "Title: {}\nLink: {}\nSnippet: {}",
                                            title, url, snippet
                                        ))
                                    }
                                })
                                .collect();
                            if !items.is_empty() {
                                return Ok(items.join("\n---\n"));
                            }
                        }
                    }
                    Err(_) => continue,
                }
            }
            Err(_) => continue,
        }
    }

    Err("All search services unavailable. Please try Tavily API or check your network.".to_string())
}

fn check_search_rate_limit() -> Result<(), String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let failures = CONSECUTIVE_FAILURES.load(Ordering::Relaxed);
    if failures >= MAX_CONSECUTIVE_FAILURES {
        return Err("Search service is temporarily unavailable due to rate limiting. Please try again later or use Tavily API for a more reliable experience.".to_string());
    }

    let last = LAST_SEARCH_TIME.load(Ordering::Relaxed);
    if now.saturating_sub(last) < MIN_SEARCH_INTERVAL_SECS {
        return Err("Search rate limit: please wait a moment before searching again.".to_string());
    }

    LAST_SEARCH_TIME.store(now, Ordering::Relaxed);
    Ok(())
}

async fn run_duckduckgo_search(query: &str) -> Result<String, String> {
    check_search_rate_limit()?;

    let client = reqwest::Client::builder()
        .user_agent(GXAGENT_UA)
        .timeout(std::time::Duration::from_secs(7))
        .connect_timeout(std::time::Duration::from_secs(4))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let encoded = urlencoding::encode(query);
    let url = format!("https://html.duckduckgo.com/html/?q={}", encoded);

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Search request failed: {}", e))?;

    let status = response.status();
    if status.as_u16() == 403 || status.as_u16() == 503 {
        let failures = CONSECUTIVE_FAILURES.fetch_add(1, Ordering::Relaxed) + 1;
        if failures >= MAX_CONSECUTIVE_FAILURES {
            return Err("Search service is temporarily busy. Please proceed with current context or try again later. Consider using Tavily API for reliable search.".to_string());
        }
        return Err(format!(
            "Search service returned {} (attempt {}/{}). Please try again or use Tavily API.",
            status, failures, MAX_CONSECUTIVE_FAILURES
        ));
    }

    if !status.is_success() {
        return Err(format!("Search request failed with status: {}", status));
    }

    let html = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    CONSECUTIVE_FAILURES.store(0, Ordering::Relaxed);

    parse_duckduckgo_results(&html)
}

fn parse_duckduckgo_results(html: &str) -> Result<String, String> {
    use scraper::{Html, Selector};

    let document = Html::parse_document(html);

    let result_selector =
        Selector::parse(".result").unwrap_or_else(|_| Selector::parse("div").unwrap());
    let title_selector =
        Selector::parse(".result__a").unwrap_or_else(|_| Selector::parse("a").unwrap());
    let snippet_selector =
        Selector::parse(".result__snippet").unwrap_or_else(|_| Selector::parse("span").unwrap());

    let mut results = Vec::new();

    for result_el in document.select(&result_selector) {
        if results.len() >= 5 {
            break;
        }

        let title = result_el
            .select(&title_selector)
            .next()
            .map(|el| el.text().collect::<String>())
            .unwrap_or_default()
            .trim()
            .to_string();

        let raw_link = result_el
            .select(&title_selector)
            .next()
            .and_then(|el| el.value().attr("href"))
            .unwrap_or("")
            .to_string();

        let link = if raw_link.contains("uddg=") {
            raw_link
                .split("uddg=")
                .nth(1)
                .and_then(|s| s.split('&').next())
                .and_then(|s| urlencoding::decode(s).ok())
                .map(|s| s.to_string())
                .unwrap_or(raw_link.clone())
        } else if raw_link.contains("duckduckgo.com/y.js")
            || raw_link.contains("duckduckgo.com/d.js")
            || raw_link.contains("duckduckgo.com/l/")
            || raw_link.starts_with("/")
            || (raw_link.contains("duckduckgo.com") && !raw_link.starts_with("http"))
        {
            String::new()
        } else {
            raw_link.clone()
        };

        let snippet = result_el
            .select(&snippet_selector)
            .next()
            .map(|el| el.text().collect::<String>())
            .unwrap_or_default()
            .trim()
            .to_string();

        if !link.is_empty() && !is_safe_url(&link) {
            continue;
        }

        if !title.is_empty() && !link.is_empty() {
            results.push(format!(
                "Title: {}\nLink: {}\nSnippet: {}",
                title, link, snippet
            ));
        } else if !title.is_empty() || !snippet.is_empty() {
            results.push(format!("Title: {}\nSnippet: {}", title, snippet));
        }
    }

    if results.is_empty() {
        Ok("No results found.".to_string())
    } else {
        Ok(results.join("\n---\n"))
    }
}
