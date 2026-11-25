use super::fs::resolve_path;

/// How an `edit_file` needle was located in the haystack.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum EditMatchKind {
    Exact,
    /// Matched after normalizing trailing whitespace on every line.
    TrailingWhitespace,
    /// Matched after removing the common leading indentation from the needle;
    /// the replacement is re-indented to the depth found in the file.
    Reindented,
}

impl EditMatchKind {
    fn note(self) -> &'static str {
        match self {
            EditMatchKind::Exact => "",
            EditMatchKind::TrailingWhitespace => " (matched ignoring trailing whitespace)",
            EditMatchKind::Reindented => " (matched ignoring indentation; replacement re-indented)",
        }
    }
}

/// A located edit: the byte ranges in the original text that must be replaced,
/// paired with the exact replacement string for each range.
pub(super) struct EditMatches {
    pub(super) kind: EditMatchKind,
    /// `(start, end, replacement)` triples, in ascending, non-overlapping order.
    pub(super) spans: Vec<(usize, usize, String)>,
}

/// Width of the whitespace prefix shared by every non-blank line.
pub(super) fn common_indent(text: &str) -> usize {
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.len() - l.trim_start_matches([' ', '\t']).len())
        .min()
        .unwrap_or(0)
}

/// Remove `width` leading whitespace characters from each line, tolerating
/// lines that are shorter (blank lines).
fn dedent_by(text: &str, width: usize) -> String {
    text.lines()
        .map(|line| {
            let strippable = line.len() - line.trim_start_matches([' ', '\t']).len();
            &line[strippable.min(width)..]
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Prefix every non-blank line with `indent`.
fn reindent(text: &str, indent: &str) -> String {
    let mut out = String::with_capacity(text.len() + indent.len() * 4);
    for (i, line) in text.lines().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        if !line.trim().is_empty() {
            out.push_str(indent);
        }
        out.push_str(line);
    }
    if text.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// Byte offsets of every occurrence of `needle` in `haystack`.
fn find_all(haystack: &str, needle: &str) -> Vec<usize> {
    if needle.is_empty() {
        return Vec::new();
    }
    let mut hits = Vec::new();
    let mut from = 0;
    while let Some(rel) = haystack[from..].find(needle) {
        let at = from + rel;
        hits.push(at);
        from = at + needle.len();
    }
    hits
}

/// Map a line index in `text` to its starting byte offset.
fn line_start_offsets(text: &str) -> Vec<usize> {
    let mut offsets = vec![0];
    for (i, b) in text.bytes().enumerate() {
        if b == b'\n' {
            offsets.push(i + 1);
        }
    }
    offsets
}

/// Locate `old_string` in `original`, escalating through fallback strategies.
pub(super) fn locate_edit(
    original: &str,
    old_string: &str,
    new_string: &str,
) -> Option<EditMatches> {
    let exact = find_all(original, old_string);
    if !exact.is_empty() {
        return Some(EditMatches {
            kind: EditMatchKind::Exact,
            spans: exact
                .into_iter()
                .map(|at| (at, at + old_string.len(), new_string.to_string()))
                .collect(),
        });
    }

    let needle_lines: Vec<String> = old_string
        .lines()
        .map(|l| l.trim_end_matches([' ', '\t']).to_string())
        .collect();
    if !needle_lines.is_empty() {
        let hay_lines: Vec<&str> = original.lines().collect();
        let starts = line_start_offsets(original);
        let mut spans = Vec::new();
        let mut i = 0;
        while i + needle_lines.len() <= hay_lines.len() {
            let window = &hay_lines[i..i + needle_lines.len()];
            let same = window
                .iter()
                .zip(&needle_lines)
                .all(|(h, n)| h.trim_end_matches([' ', '\t']) == n);
            if same {
                let start = starts[i];
                let last = i + needle_lines.len() - 1;
                let end = starts[last] + hay_lines[last].len();
                spans.push((start, end, new_string.to_string()));
                i += needle_lines.len();
            } else {
                i += 1;
            }
        }
        if !spans.is_empty() {
            return Some(EditMatches {
                kind: EditMatchKind::TrailingWhitespace,
                spans,
            });
        }
    }

    let dedented = dedent_by(old_string, common_indent(old_string));
    let needle_lines: Vec<&str> = dedented.lines().collect();
    if needle_lines.is_empty() {
        return None;
    }
    let hay_lines: Vec<&str> = original.lines().collect();
    let starts = line_start_offsets(original);
    let new_dedent = common_indent(new_string);
    let new_body = dedent_by(new_string, new_dedent);
    let mut spans = Vec::new();
    let mut i = 0;
    while i + needle_lines.len() <= hay_lines.len() {
        let window = &hay_lines[i..i + needle_lines.len()];
        let same = window.iter().zip(&needle_lines).all(|(h, n)| {
            h.trim_start_matches([' ', '\t'])
                .trim_end_matches([' ', '\t'])
                == n.trim_start_matches([' ', '\t'])
                    .trim_end_matches([' ', '\t'])
        });
        if same {
            let first = window[0];
            let indent = &first[..first.len() - first.trim_start_matches([' ', '\t']).len()];
            let start = starts[i];
            let last = i + needle_lines.len() - 1;
            let end = starts[last] + hay_lines[last].len();
            spans.push((start, end, reindent(&new_body, indent)));
            i += needle_lines.len();
        } else {
            i += 1;
        }
    }
    if spans.is_empty() {
        return None;
    }
    Some(EditMatches {
        kind: EditMatchKind::Reindented,
        spans,
    })
}

/// Build a diagnostic hint pointing at the closest thing to `old_string` in the file.
pub(super) fn nearest_match_hint(original: &str, old_string: &str) -> String {
    let needle = match old_string.lines().find(|l| !l.trim().is_empty()) {
        Some(l) => l.trim(),
        None => return String::new(),
    };
    let needle_tokens: Vec<&str> = needle.split_whitespace().collect();
    if needle_tokens.is_empty() {
        return String::new();
    }

    let mut best: Option<(f32, usize, &str)> = None;
    for (idx, line) in original.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let hits = needle_tokens
            .iter()
            .filter(|t| trimmed.contains(*t))
            .count();
        if hits == 0 {
            continue;
        }
        let score = hits as f32 / needle_tokens.len() as f32;
        if best.is_none_or(|(b, _, _)| score > b) {
            best = Some((score, idx + 1, trimmed));
        }
    }

    match best {
        Some((score, line_no, text)) if score >= 0.5 => {
            let preview: String = text.chars().take(160).collect();
            format!(
                " The closest line in the file is line {}: `{}`. Read the file again and copy the exact text.",
                line_no, preview
            )
        }
        _ => String::new(),
    }
}

/// Precise in-place edit: replace an exact `old_string` with `new_string`.
pub(super) async fn run_edit_file(
    path: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
    work_dir: &str,
) -> Result<String, String> {
    if old_string.is_empty() {
        return Err("old_string must not be empty. Use write_file to create a new file.".into());
    }
    if old_string == new_string {
        return Err("old_string and new_string are identical — nothing to change.".into());
    }

    let full_path = resolve_path(path, work_dir)?;
    let original = tokio::fs::read_to_string(&full_path)
        .await
        .map_err(|e| format!("Failed to read file for editing: {}", e))?;

    let located = locate_edit(&original, old_string, new_string).ok_or_else(|| {
        format!(
            "old_string not found in the file, even allowing for differing trailing whitespace and indentation.{}",
            nearest_match_hint(&original, old_string)
        )
    })?;

    let occurrences = located.spans.len();
    if !replace_all && occurrences > 1 {
        return Err(format!(
            "old_string is not unique — it matches {} places. Add more surrounding context to make it unique, or set replace_all: true.",
            occurrences
        ));
    }

    let spans = if replace_all {
        located.spans.as_slice()
    } else {
        &located.spans[..1]
    };
    let mut updated = original.clone();
    for (start, end, replacement) in spans.iter().rev() {
        updated.replace_range(*start..*end, replacement);
    }

    if updated == original {
        return Err("The edit would leave the file unchanged — old_string and new_string resolve to the same text.".into());
    }

    tokio::fs::write(&full_path, &updated)
        .await
        .map_err(|e| format!("Failed to write edited file: {}", e))?;

    let replaced = spans.len();
    Ok(format!(
        "Edited {} ({} replacement{}).{}",
        path,
        replaced,
        if replaced == 1 { "" } else { "s" },
        located.kind.note()
    ))
}
