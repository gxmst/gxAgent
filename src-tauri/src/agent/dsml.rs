use super::stream::{new_tool_call_id, AccumulatedToolCall};
use serde_json::json;

pub(super) fn parse_dsml_tool_calls(content: &str) -> Vec<AccumulatedToolCall> {
    let mut calls = Vec::new();
    let dsml_close = "\u{ff5c}\u{ff5c}DSML\u{ff5c}\u{ff5c}";
    let invoke_open = format!("<{}invoke name=\"", dsml_close);
    let invoke_close = format!("</{}invoke>", dsml_close);
    let param_open = format!("<{}parameter name=\"", dsml_close);
    let param_close = format!("</{}parameter>", dsml_close);

    let mut pos = 0;
    while let Some(start) = content[pos..].find(&invoke_open) {
        let abs_start = pos + start;
        let name_start = abs_start + invoke_open.len();
        if let Some(name_end) = content[name_start..].find('"') {
            let name = content[name_start..name_start + name_end].to_string();
            let mut args = serde_json::Map::new();

            let invoke_body_start = name_start + name_end + 1;
            if let Some(invoke_end_offset) = content[invoke_body_start..].find(&invoke_close) {
                let body = &content[invoke_body_start..invoke_body_start + invoke_end_offset];

                let mut param_pos = 0;
                while let Some(p_start) = body[param_pos..].find(&param_open) {
                    let abs_p = param_pos + p_start;
                    let pname_start = abs_p + param_open.len();
                    if let Some(pname_end) = body[pname_start..].find('"') {
                        let pname = body[pname_start..pname_start + pname_end].to_string();
                        let after_name = pname_start + pname_end;
                        if let Some(gt_pos) = body[after_name..].find('>') {
                            let val_start = after_name + gt_pos + 1;
                            if let Some(pc_offset) = body[val_start..].find(&param_close) {
                                let val_end = val_start + pc_offset;
                                if val_end > val_start {
                                    let pval = body[val_start..val_end].to_string();
                                    args.insert(pname, json!(pval));
                                }
                            }
                        }
                        param_pos = pname_start + pname_end + 1;
                    } else {
                        break;
                    }
                }
            }

            calls.push(AccumulatedToolCall {
                id: new_tool_call_id(),
                name,
                arguments: serde_json::Value::Object(args).to_string(),
            });

            pos = name_start + name_end + 1;
        } else {
            break;
        }
    }

    calls
}

pub(super) fn strip_dsml_tags(content: &str) -> String {
    let dsml_close = "\u{ff5c}\u{ff5c}DSML\u{ff5c}\u{ff5c}";
    let mut result = content.to_string();

    // Remove complete DSML tag blocks: <｜｜DSML｜｜tool_calls>...</｜｜DSML｜｜tool_calls>
    let tc_open = format!("<{}tool_calls>", dsml_close);
    let tc_close = format!("</{}tool_calls>", dsml_close);
    while let Some(start) = result.find(&tc_open) {
        if let Some(end) = result[start..].find(&tc_close) {
            result.replace_range(start..start + end + tc_close.len(), "");
        } else {
            result.replace_range(start.., "");
            break;
        }
    }

    // Remove any remaining DSML fragments
    let fragments = [
        format!("<{}tool_calls>", dsml_close),
        format!("</{}tool_calls>", dsml_close),
        format!("<{}invoke", dsml_close),
        format!("</{}invoke>", dsml_close),
        format!("<{}parameter", dsml_close),
        format!("</{}parameter>", dsml_close),
    ];
    for frag in &fragments {
        result = result.replace(frag, "");
    }

    // Remove lines that are only DSML residue (contain DSML markers but no useful content)
    let cleaned: Vec<&str> = result
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            !trimmed.is_empty() && !trimmed.contains("DSML")
        })
        .collect();
    cleaned.join("\n").trim().to_string()
}
