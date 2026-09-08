use crate::agent::ImageAttachment;
use crate::codex_transport::{response_result, CodexTransport};
use crate::config::AppConfig;
use crate::workspace;
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::time::{Duration, Instant};
use tauri::{Emitter, Window};
use tokio::sync::{mpsc, oneshot, Mutex};

type Reply = oneshot::Sender<Result<(), String>>;
enum Control {
    Interrupt(Reply),
    Steer(String, Reply),
    Answer(String, Value, Reply),
}
struct PendingControl {
    reply: Reply,
    interrupt: bool,
    started: Instant,
}
struct InteractionRoute {
    request_id: String,
    item_id: String,
    question: bool,
    sender: mpsc::Sender<Control>,
}
struct Interaction {
    id: String,
    rpc_id: Value,
    method: String,
    params: Value,
}
static REQUESTS: Lazy<Mutex<HashMap<String, mpsc::Sender<Control>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static INTERACTIONS: Lazy<Mutex<HashMap<String, InteractionRoute>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

async fn during_startup<T>(
    future: impl Future<Output = Result<T, String>>,
    controls: &mut mpsc::Receiver<Control>,
) -> Result<Option<T>, String> {
    tokio::pin!(future);
    loop {
        tokio::select! {
            biased;
            control = controls.recv() => match control.ok_or("Codex control channel closed")? {
                Control::Interrupt(reply) => { let _ = reply.send(Ok(())); return Ok(None); }
                Control::Steer(_, reply) | Control::Answer(_, _, reply) => {
                    let _ = reply.send(Err("Codex is still starting. Retry after the turn starts.".into()));
                }
            },
            result = &mut future => return result.map(Some),
        }
    }
}

async fn finish_controls(rpc: &mut CodexTransport, pending: &mut HashMap<u64, PendingControl>) {
    // A completed turn already satisfies an interrupt, even if its RPC reply arrives later.
    let interrupts: Vec<_> = pending
        .iter()
        .filter_map(|(&id, control)| control.interrupt.then_some(id))
        .collect();
    for id in interrupts {
        if let Some(control) = pending.remove(&id) {
            let _ = control.reply.send(Ok(()));
        }
    }
    while !pending.is_empty() {
        let remaining = pending
            .values()
            .map(|control| Duration::from_secs(30).saturating_sub(control.started.elapsed()))
            .min()
            .unwrap_or_default();
        match tokio::time::timeout(remaining, rpc.next()).await {
            Ok(Ok(message)) if message.get("method").is_none() => {
                if let Some(control) = message["id"].as_u64().and_then(|id| pending.remove(&id)) {
                    let _ = control.reply.send(response_result(message).map(|_| ()));
                }
            }
            Ok(Ok(_)) => {}
            _ => break,
        }
    }
    for (_, control) in pending.drain() {
        let _ = control.reply.send(Err(
            "The turn ended before Codex acknowledged the additional input.".into(),
        ));
    }
}

async fn wait_reply(receiver: oneshot::Receiver<Result<(), String>>) -> Result<(), String> {
    tokio::time::timeout(Duration::from_secs(30), receiver)
        .await
        .map_err(|_| "Codex did not acknowledge the request in time".to_string())?
        .map_err(|_| "The Codex turn has ended".to_string())?
}

pub async fn interrupt(request_id: &str) -> Option<Result<(), String>> {
    let sender = REQUESTS.lock().await.get(request_id).cloned()?;
    let (tx, rx) = oneshot::channel();
    if sender.send(Control::Interrupt(tx)).await.is_err() {
        return Some(Err("The Codex turn has ended".into()));
    }
    Some(wait_reply(rx).await)
}

pub async fn steer(request_id: &str, text: String) -> Option<Result<(), String>> {
    let sender = REQUESTS.lock().await.get(request_id).cloned()?;
    let (tx, rx) = oneshot::channel();
    if sender.send(Control::Steer(text, tx)).await.is_err() {
        return Some(Err("The Codex turn has ended".into()));
    }
    Some(wait_reply(rx).await)
}

pub async fn approve(
    id: &str,
    approved: &[String],
    rejected: &[String],
) -> Option<Result<(), String>> {
    let routes = INTERACTIONS.lock().await;
    let route = routes.get(id)?;
    if route.question
        || approved.len() + rejected.len() != 1
        || approved
            .iter()
            .chain(rejected)
            .any(|item| item != &route.item_id)
    {
        return Some(Err(
            "Approval no longer matches the pending Codex action".into()
        ));
    }
    let sender = route.sender.clone();
    drop(routes);
    Some(
        answer_with(
            sender,
            id,
            json!({"decision":if approved.is_empty() { "decline" } else { "accept" }}),
        )
        .await,
    )
}

#[tauri::command]
pub async fn answer_codex_question(
    interaction_id: String,
    answers: HashMap<String, Vec<String>>,
) -> Result<(), String> {
    let routes = INTERACTIONS.lock().await;
    let route = routes
        .get(&interaction_id)
        .ok_or("This Codex question is no longer pending")?;
    if !route.question {
        return Err("This interaction is not a question".into());
    }
    let sender = route.sender.clone();
    drop(routes);
    let answers: serde_json::Map<String, Value> = answers
        .into_iter()
        .map(|(id, answers)| (id, json!({"answers":answers})))
        .collect();
    answer_with(sender, &interaction_id, json!({"answers":answers})).await
}

async fn answer_with(sender: mpsc::Sender<Control>, id: &str, result: Value) -> Result<(), String> {
    let (tx, rx) = oneshot::channel();
    sender
        .send(Control::Answer(id.into(), result, tx))
        .await
        .map_err(|_| "The Codex turn has ended")?;
    wait_reply(rx).await
}

fn emit(window: &Window, request_id: &str, event: &str, mut payload: Value) {
    payload["requestId"] = json!(request_id);
    let _ = window.emit(event, payload);
}

fn permissions(config: &AppConfig) -> (&'static str, &'static str) {
    let sandbox = if config.plan_mode {
        "read-only"
    } else if config.approval_policy == "unrestricted" {
        "danger-full-access"
    } else {
        "workspace-write"
    };
    let approval = match config.approval_policy.as_str() {
        "strict" => "untrusted",
        "unrestricted" => "never",
        _ => "on-request",
    };
    (sandbox, approval)
}

fn thread_options(config: &AppConfig) -> Value {
    let (sandbox, approval) = permissions(config);
    let mut options = json!({
        "cwd":config.default_work_dir,"sandbox":sandbox,"approvalPolicy":approval,
        "developerInstructions":config.system_prompt,
        "config":{"mcp_servers":config.mcp_servers,"web_search":if config.tools_enabled.iter().any(|tool| tool == "web_search") { "live" } else { "disabled" }},
    });
    if !config.codex_model.trim().is_empty() {
        options["model"] = json!(config.codex_model.trim());
    }
    options
}

fn turn_input(
    prompt: String,
    history: Vec<Value>,
    resumed: bool,
    images: Vec<ImageAttachment>,
) -> Vec<Value> {
    let text = if !resumed && !history.is_empty() {
        format!(
            "<conversation_history>\n{}\n</conversation_history>\n\n{}",
            serde_json::to_string(&history).unwrap_or_default(),
            prompt
        )
    } else {
        prompt
    };
    let mut input = vec![json!({"type":"text","text":text})];
    for image in images {
        let url = if image.data.starts_with("data:") {
            image.data
        } else {
            format!(
                "data:{};base64,{}",
                image.mime_type.as_deref().unwrap_or("image/png"),
                image.data
            )
        };
        input.push(json!({"type":"image","url":url}));
    }
    input
}

#[tauri::command]
pub async fn inspect_codex(executable: String) -> Result<Value, String> {
    let mut rpc = CodexTransport::connect(&executable).await?;
    let result = async {
        let account = rpc.call("account/read", json!({"refreshToken":false})).await?;
        let models = rpc.call("model/list", json!({"limit":100})).await?;
        Ok(json!({"connected":true,"authenticated":!account["account"].is_null() || account["requiresOpenaiAuth"] == false,"models":models["data"]}))
    }.await;
    rpc.close().await;
    result
}

#[allow(clippy::too_many_arguments)]
pub async fn run(
    window: Window,
    request_id: String,
    mut prompt: String,
    mut config: AppConfig,
    history: Vec<Value>,
    thread_id: Option<String>,
    images: Vec<ImageAttachment>,
    retrieval_query: String,
) -> Result<(), String> {
    let (sender, mut controls) = mpsc::channel(32);
    {
        let mut requests = REQUESTS.lock().await;
        if requests.contains_key(&request_id) {
            return Err("This Codex request is already running".into());
        }
        requests.insert(request_id.clone(), sender.clone());
    }
    let result = async {
        let Some(()) = during_startup(
            crate::context::enrich(
                &window,
                &request_id,
                &retrieval_query,
                &mut prompt,
                &mut config,
            ),
            &mut controls,
        )
        .await?
        else {
            emit(
                &window,
                &request_id,
                "agent-complete",
                json!({"status":"cancelled"}),
            );
            return Ok(());
        };
        run_inner(
            &window,
            &request_id,
            prompt,
            &config,
            history,
            thread_id,
            images,
            sender,
            &mut controls,
        )
        .await
    }
    .await;
    REQUESTS.lock().await.remove(&request_id);
    controls.close();
    while let Ok(control) = controls.try_recv() {
        match control {
            Control::Interrupt(reply) => {
                let _ = reply.send(Ok(()));
            }
            Control::Steer(_, reply) | Control::Answer(_, _, reply) => {
                let _ = reply.send(Err("The Codex turn has ended".into()));
            }
        }
    }
    INTERACTIONS
        .lock()
        .await
        .retain(|_, route| route.request_id != request_id);
    emit(
        &window,
        &request_id,
        "agent-codex-question",
        json!({"question":null}),
    );
    result
}

#[allow(clippy::too_many_arguments)]
async fn run_inner(
    window: &Window,
    request_id: &str,
    prompt: String,
    config: &AppConfig,
    history: Vec<Value>,
    thread_id: Option<String>,
    images: Vec<ImageAttachment>,
    sender: mpsc::Sender<Control>,
    controls: &mut mpsc::Receiver<Control>,
) -> Result<(), String> {
    let started = Instant::now();
    let Some(mut rpc) =
        during_startup(CodexTransport::connect(&config.codex_executable), controls).await?
    else {
        emit(
            window,
            request_id,
            "agent-complete",
            json!({"status":"cancelled"}),
        );
        return Ok(());
    };
    let result = async {
        let resumed = thread_id.is_some();
        let mut options = thread_options(config);
        let method = if let Some(id) = thread_id { options["threadId"] = json!(id); "thread/resume" } else { "thread/start" };
        let Some(thread) = during_startup(rpc.call(method, options), controls).await? else {
            return Ok("cancelled");
        };
        let thread_id = thread["thread"]["id"].as_str().ok_or("Codex did not return a thread id")?.to_string();
        if let Ok(checkpoint) = workspace::create_checkpoint_internal(&config.default_work_dir, Some("before Codex turn".into())).await {
            emit(window, request_id, "agent-checkpoint", json!({"status":"created","reference":checkpoint.reference,"commit":checkpoint.commit,"createdAt":checkpoint.created_at,"label":checkpoint.label}));
        }
        let mut turn_options = json!({"threadId":thread_id,"input":turn_input(prompt, history, resumed, images),"effort":config.thinking_level});
        crate::context::emit_snapshot(window, request_id, "codex-input", 1, &[json!({"role":"developer","content":config.system_prompt}),json!({"role":"user","content":turn_options["input"]})], &[]);
        if !config.codex_model.is_empty() { turn_options["model"] = json!(config.codex_model); }
        let Some(turn) = during_startup(rpc.call("turn/start", turn_options), controls).await? else {
            return Ok("cancelled");
        };
        let turn_id = turn["turn"]["id"].as_str().ok_or("Codex did not return a turn id")?.to_string();
        emit(window, request_id, "agent-codex-thread", json!({"threadId":thread_id,"workDir":config.default_work_dir,"model":thread["model"]}));
        drive_turn(&|event, payload| emit(window, request_id, event, payload), request_id, &mut rpc, &thread_id, &turn_id, started, sender, controls).await
    }.await;
    rpc.close().await;
    if let Ok(status) = result.as_ref() {
        emit(
            window,
            request_id,
            "agent-complete",
            json!({"status":status}),
        );
    }
    result.map(|_| ())
}

#[allow(clippy::too_many_arguments)]
async fn drive_turn(
    events: &(impl Fn(&str, Value) + Send + Sync),
    request_id: &str,
    rpc: &mut CodexTransport,
    thread_id: &str,
    turn_id: &str,
    started: Instant,
    sender: mpsc::Sender<Control>,
    controls: &mut mpsc::Receiver<Control>,
) -> Result<&'static str, String> {
    let mut text_items: Vec<(String, String)> = Vec::new();
    let mut items: HashMap<String, Value> = HashMap::new();
    let mut interactions: VecDeque<Interaction> = VecDeque::new();
    let mut pending_controls: HashMap<u64, PendingControl> = HashMap::new();
    let mut interrupt_started: Option<Instant> = None;
    let mut timer = tokio::time::interval(Duration::from_secs(1));
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        let message = tokio::select! {
            control = controls.recv() => {
                match control.ok_or("Codex control channel closed")? {
                    Control::Interrupt(reply) => {
                        let id = rpc.request("turn/interrupt", json!({"threadId":thread_id,"turnId":turn_id})).await?;
                        pending_controls.insert(id, PendingControl { reply, interrupt: true, started: Instant::now() });
                        interrupt_started = Some(Instant::now());
                    }
                    Control::Steer(text, reply) => {
                        let id = rpc.request("turn/steer", json!({"threadId":thread_id,"expectedTurnId":turn_id,"input":[{"type":"text","text":text}]})).await?;
                        pending_controls.insert(id, PendingControl { reply, interrupt: false, started: Instant::now() });
                    }
                    Control::Answer(id, result, reply) => {
                        if interactions.front().is_some_and(|interaction| interaction.id == id) {
                            let interaction = interactions.pop_front().expect("checked pending interaction");
                            rpc.send(json!({"id":interaction.rpc_id,"result":result})).await?;
                            INTERACTIONS.lock().await.remove(&id);
                            if interaction.method != "item/tool/requestUserInput" {
                                events("agent-tool-approval-resolved", json!({"approvalRequestId":id,"itemId":interaction.params["itemId"],"approved":result["decision"] == "accept"}));
                            }
                            events("agent-codex-question", json!({"question":null}));
                            if let Some(next) = interactions.front() { publish_interaction(events, request_id, next, &sender, &items).await; }
                            let _ = reply.send(Ok(()));
                        } else { let _ = reply.send(Err("This interaction has already ended".into())); }
                    }
                }
                continue;
            }
            message = rpc.next() => message?,
            _ = timer.tick() => {
                if interrupt_started.is_some_and(|time| time.elapsed() >= Duration::from_secs(10)) {
                    return Err("Codex did not finish interrupting within 10 seconds; its connection was closed.".into());
                }
                let expired: Vec<_> = pending_controls.iter().filter_map(|(&id, control)| (control.started.elapsed() >= Duration::from_secs(30)).then_some(id)).collect();
                for id in expired {
                    if let Some(control) = pending_controls.remove(&id) { let _ = control.reply.send(Err("Codex did not acknowledge the request in time".into())); }
                }
                continue;
            }
        };
        if message.get("method").is_none() {
            if let Some(control) = message["id"]
                .as_u64()
                .and_then(|id| pending_controls.remove(&id))
            {
                let result = response_result(message).map(|_| ());
                if control.interrupt && result.is_err() {
                    interrupt_started = None;
                }
                let _ = control.reply.send(result);
            }
            continue;
        }
        let method = message["method"].as_str().unwrap_or_default();
        let params = &message["params"];
        if params["threadId"]
            .as_str()
            .is_some_and(|id| id != thread_id)
            || params["turnId"].as_str().is_some_and(|id| id != turn_id)
            || params["turn"]["id"]
                .as_str()
                .is_some_and(|id| id != turn_id)
        {
            continue;
        }
        if let Some(id) = message.get("id") {
            if matches!(
                method,
                "item/commandExecution/requestApproval"
                    | "item/fileChange/requestApproval"
                    | "item/tool/requestUserInput"
            ) {
                let interaction = Interaction {
                    id: format!("codex-{request_id}-{}", uuid::Uuid::new_v4()),
                    rpc_id: id.clone(),
                    method: method.into(),
                    params: params.clone(),
                };
                if interactions.is_empty() {
                    publish_interaction(events, request_id, &interaction, &sender, &items).await;
                }
                interactions.push_back(interaction);
            } else {
                rpc.send(json!({"id":id,"error":{"code":-32601,"message":format!("gxAgent does not support this Codex interaction: {method}")}})).await?;
            }
            continue;
        }
        match method {
            "serverRequest/resolved" => {
                if let Some(index) = interactions
                    .iter()
                    .position(|interaction| interaction.rpc_id == params["requestId"])
                {
                    let interaction = interactions.remove(index).expect("located interaction");
                    INTERACTIONS.lock().await.remove(&interaction.id);
                    if index == 0 {
                        if interaction.method == "item/tool/requestUserInput" {
                            events("agent-codex-question", json!({"question":null}));
                        } else {
                            events(
                                "agent-tool-approval-cancelled",
                                json!({"approvalRequestId":interaction.id}),
                            );
                        }
                        if let Some(next) = interactions.front() {
                            publish_interaction(events, request_id, next, &sender, &items).await;
                        }
                    }
                }
            }
            "item/agentMessage/delta" => {
                let id = params["itemId"].as_str().unwrap_or_default();
                let delta = params["delta"].as_str().unwrap_or_default();
                if let Some((_, text)) = text_items.iter_mut().find(|(item, _)| item == id) {
                    text.push_str(delta);
                } else {
                    if !text_items.is_empty() {
                        events("agent-stream-chunk", json!({"content":"\n\n"}));
                    }
                    text_items.push((id.into(), delta.into()));
                }
                events("agent-stream-chunk", json!({"content":delta}));
            }
            "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
                events("agent-reasoning-chunk", json!({"content":params["delta"]}))
            }
            "item/started" | "item/completed" => {
                let item = &params["item"];
                let id = item["id"].as_str().unwrap_or_default();
                items.insert(id.into(), item.clone());
                if item["type"] == "agentMessage" && method == "item/completed" {
                    let text = item["text"].as_str().unwrap_or_default();
                    if let Some((_, content)) =
                        text_items.iter_mut().find(|(item_id, _)| item_id == id)
                    {
                        *content = text.into();
                    } else {
                        text_items.push((id.into(), text.into()));
                    }
                } else if let Some((name, arguments, output)) = tool_item(item) {
                    let payload = json!({"id":id,"name":name,"arguments":arguments.to_string(),"output":output});
                    events(
                        if method == "item/started" {
                            "agent-tool-executing"
                        } else {
                            "agent-tool-output"
                        },
                        payload,
                    );
                }
            }
            "item/commandExecution/outputDelta" => events(
                "agent-tool-output-chunk",
                json!({"id":params["itemId"],"name":"execute_command","stream":"stdout","content":params["delta"]}),
            ),
            "turn/plan/updated" => {
                let output = json!({"explanation":params["explanation"],"plan":params["plan"]});
                events(
                    "agent-tool-executing",
                    json!({"id":format!("plan-{turn_id}"),"name":"todo_write","arguments":output.to_string()}),
                );
                events(
                    "agent-tool-output",
                    json!({"id":format!("plan-{turn_id}"),"name":"todo_write","output":output.to_string()}),
                );
            }
            "thread/tokenUsage/updated" => {
                let usage = &params["tokenUsage"]["last"];
                let total = &params["tokenUsage"]["total"];
                events(
                    "agent-usage",
                    json!({"prompt_tokens":usage["inputTokens"].as_u64().unwrap_or(0),"completion_tokens":usage["outputTokens"].as_u64().unwrap_or(0),"total_prompt_tokens":total["inputTokens"].as_u64().unwrap_or(0),"total_completion_tokens":total["outputTokens"].as_u64().unwrap_or(0),"loop_count":1,"response_time_ms":started.elapsed().as_millis(),"ttft_ms":0}),
                );
            }
            "turn/completed" => {
                let status = params["turn"]["status"].as_str().unwrap_or("failed");
                finish_controls(rpc, &mut pending_controls).await;
                events(
                    "agent-stream-done",
                    json!({"content":text_items.into_iter().map(|(_, text)| text).collect::<Vec<_>>().join("\n\n"),"authoritative":true,"loopCount":1,"responseTimeMs":started.elapsed().as_millis(),"ttftMs":0}),
                );
                if !matches!(status, "completed" | "interrupted") {
                    return Err(params["turn"]["error"]["message"]
                        .as_str()
                        .unwrap_or("Codex turn failed")
                        .into());
                }
                return Ok(if status == "interrupted" {
                    "cancelled"
                } else {
                    "completed"
                });
            }
            _ => {}
        }
    }
}

async fn publish_interaction(
    events: &(impl Fn(&str, Value) + Send + Sync),
    request_id: &str,
    interaction: &Interaction,
    sender: &mpsc::Sender<Control>,
    items: &HashMap<String, Value>,
) {
    let item_id = interaction.params["itemId"]
        .as_str()
        .unwrap_or(&interaction.id)
        .to_string();
    let question = interaction.method == "item/tool/requestUserInput";
    INTERACTIONS.lock().await.insert(
        interaction.id.clone(),
        InteractionRoute {
            request_id: request_id.into(),
            item_id: item_id.clone(),
            question,
            sender: sender.clone(),
        },
    );
    if question {
        events(
            "agent-codex-question",
            json!({"question":{"interactionId":interaction.id,"questions":interaction.params["questions"]}}),
        );
    } else {
        let mut detail = interaction.params.clone();
        if let Some(item) = items.get(&item_id) {
            detail["item"] = item.clone();
        }
        events(
            "agent-tool-approval-request",
            json!({"source":"codex","request_id":interaction.id,"tool_calls":[{"id":item_id,"name":if interaction.method.contains("fileChange") { "edit_file" } else { "execute_command" },"arguments":serde_json::to_string_pretty(&detail).unwrap_or_default(),"approval_level":"confirm"}]}),
        );
    }
}

fn tool_item(item: &Value) -> Option<(String, Value, String)> {
    let (name, args, output) = match item["type"].as_str()? {
        "commandExecution" => (
            "execute_command".into(),
            json!({"command":item["command"],"cwd":item["cwd"]}),
            item["aggregatedOutput"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
        ),
        "fileChange" => (
            "edit_file".into(),
            json!({"changes":item["changes"]}),
            serde_json::to_string_pretty(&item["changes"]).unwrap_or_default(),
        ),
        "mcpToolCall" => (
            format!(
                "mcp_{}_{}",
                item["server"].as_str().unwrap_or_default(),
                item["tool"].as_str().unwrap_or_default()
            ),
            item["arguments"].clone(),
            item.get("result").unwrap_or(&Value::Null).to_string(),
        ),
        "webSearch" => (
            "web_search".into(),
            json!({"query":item["query"]}),
            item.to_string(),
        ),
        "collabAgentToolCall" => (
            "spawn_agent".into(),
            item.clone(),
            item["agentsStates"].to_string(),
        ),
        "plan" => (
            "todo_write".into(),
            json!({"plan":item["text"]}),
            item["text"].as_str().unwrap_or_default().into(),
        ),
        _ => return None,
    };
    let failed = matches!(item["status"].as_str(), Some("failed" | "declined"))
        || item["exitCode"].as_i64().is_some_and(|code| code != 0)
        || !item["error"].is_null();
    Some((
        name,
        args,
        if failed {
            format!("Error: {output}\n{}", item["error"])
        } else {
            output
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{
        AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, Lines, ReadHalf, WriteHalf,
    };

    struct Fixture {
        request_id: String,
        reader: Lines<BufReader<ReadHalf<DuplexStream>>>,
        writer: WriteHalf<DuplexStream>,
        events: mpsc::UnboundedReceiver<(String, Value)>,
        task: tokio::task::JoinHandle<Result<(), String>>,
    }

    impl Fixture {
        async fn new() -> Self {
            let (client, server) = tokio::io::duplex(64 * 1024);
            let (input, output) = tokio::io::split(client);
            let (reader, writer) = tokio::io::split(server);
            let mut rpc = CodexTransport::from_io(output, input);
            let (sender, mut controls) = mpsc::channel(32);
            let (events_tx, events) = mpsc::unbounded_channel();
            let request_id = format!("fixture-{}", uuid::Uuid::new_v4());
            REQUESTS
                .lock()
                .await
                .insert(request_id.clone(), sender.clone());
            let task_request = request_id.clone();
            let task = tokio::spawn(async move {
                let emit = |event: &str, payload: Value| {
                    let _ = events_tx.send((event.into(), payload));
                };
                let result = drive_turn(
                    &emit,
                    &task_request,
                    &mut rpc,
                    "thread",
                    "turn",
                    Instant::now(),
                    sender,
                    &mut controls,
                )
                .await;
                REQUESTS.lock().await.remove(&task_request);
                INTERACTIONS
                    .lock()
                    .await
                    .retain(|_, route| route.request_id != task_request);
                rpc.close().await;
                if let Ok(status) = result.as_ref() {
                    emit("agent-complete", json!({"status":status}));
                }
                result.map(|_| ())
            });
            Self {
                request_id,
                reader: BufReader::new(reader).lines(),
                writer,
                events,
                task,
            }
        }

        async fn send(&mut self, message: Value) {
            let mut bytes = serde_json::to_vec(&message).unwrap();
            bytes.push(b'\n');
            self.writer.write_all(&bytes).await.unwrap();
        }

        async fn read(&mut self) -> Value {
            let line = tokio::time::timeout(Duration::from_secs(3), self.reader.next_line())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            serde_json::from_str(&line).unwrap()
        }

        async fn event(&mut self, name: &str) -> Value {
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    let (event, payload) = self
                        .events
                        .recv()
                        .await
                        .expect("driver ended before the expected event");
                    if event == name {
                        return payload;
                    }
                }
            })
            .await
            .unwrap()
        }

        async fn completed(&mut self, status: &str) {
            self.send(json!({"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","status":status}}})).await;
        }

        async fn finish(self) {
            tokio::time::timeout(Duration::from_secs(3), self.task)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
        }
    }

    #[tokio::test]
    async fn startup_can_be_cancelled_while_the_server_is_not_replying() {
        let (sender, mut controls) = mpsc::channel(4);
        let (steer_tx, steer_rx) = oneshot::channel();
        sender
            .send(Control::Steer("additional".into(), steer_tx))
            .await
            .unwrap();
        let (stop_tx, stop_rx) = oneshot::channel();
        sender.send(Control::Interrupt(stop_tx)).await.unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            during_startup(std::future::pending::<Result<(), String>>(), &mut controls),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(result.is_none());
        assert!(steer_rx.await.unwrap().is_err());
        assert!(stop_rx.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn terminal_items_reconcile_deltas_and_missing_deltas_and_ignore_old_turns() {
        let mut fixture = Fixture::new().await;
        fixture.send(json!({"method":"item/agentMessage/delta","params":{"threadId":"thread","turnId":"turn","itemId":"first","delta":"draft"}})).await;
        fixture.send(json!({"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"old-turn","status":"completed"}}})).await;
        for (id, text) in [("first", "corrected"), ("second", "final-only")] {
            fixture.send(json!({"method":"item/completed","params":{"threadId":"thread","turnId":"turn","item":{"type":"agentMessage","id":id,"text":text}}})).await;
        }
        fixture.send(json!({"method":"thread/tokenUsage/updated","params":{"threadId":"thread","tokenUsage":{"last":{"inputTokens":11,"outputTokens":7},"total":{"inputTokens":23,"outputTokens":13}}}})).await;
        let usage = fixture.event("agent-usage").await;
        assert_eq!(usage["total_prompt_tokens"], 23);
        assert_eq!(usage["completion_tokens"], 7);
        assert_eq!(usage["loop_count"], 1);
        fixture.completed("completed").await;
        let final_text = fixture.event("agent-stream-done").await;
        assert_eq!(final_text["content"], "corrected\n\nfinal-only");
        assert_eq!(final_text["authoritative"], true);
        fixture.finish().await;
    }

    #[tokio::test]
    async fn approvals_and_questions_are_serialized_and_unknown_requests_are_rejected() {
        let mut fixture = Fixture::new().await;
        for (id, method, item) in [
            (101, "item/commandExecution/requestApproval", "command"),
            (102, "item/fileChange/requestApproval", "file"),
            (103, "item/tool/requestUserInput", "question"),
        ] {
            fixture.send(json!({"id":id,"method":method,"params":{"threadId":"thread","turnId":"turn","itemId":item,"questions":[{"id":"scope","question":"Choose scope"}]}})).await;
        }
        fixture.send(json!({"id":104,"method":"item/tool/call","params":{"threadId":"thread","turnId":"turn"}})).await;
        assert_eq!(fixture.read().await["error"]["code"], -32601);
        let first = fixture.event("agent-tool-approval-request").await;
        let first_id = first["request_id"].as_str().unwrap();
        assert!(approve(first_id, &["wrong-item".into()], &[])
            .await
            .unwrap()
            .is_err());
        assert!(approve(first_id, &["command".into()], &[])
            .await
            .unwrap()
            .is_ok());
        assert_eq!(
            fixture.read().await,
            json!({"id":101,"result":{"decision":"accept"}})
        );
        assert_eq!(
            fixture.event("agent-tool-approval-resolved").await["approved"],
            true
        );
        let second = fixture.event("agent-tool-approval-request").await;
        assert!(approve(
            second["request_id"].as_str().unwrap(),
            &[],
            &["file".into()]
        )
        .await
        .unwrap()
        .is_ok());
        assert_eq!(
            fixture.read().await,
            json!({"id":102,"result":{"decision":"decline"}})
        );
        let question = loop {
            let event = fixture.event("agent-codex-question").await;
            if !event["question"].is_null() {
                break event["question"].clone();
            }
        };
        answer_codex_question(
            question["interactionId"].as_str().unwrap().into(),
            HashMap::from([("scope".into(), vec!["project".into()])]),
        )
        .await
        .unwrap();
        assert_eq!(
            fixture.read().await,
            json!({"id":103,"result":{"answers":{"scope":{"answers":["project"]}}}})
        );
        fixture.completed("completed").await;
        fixture.finish().await;
    }

    #[tokio::test]
    async fn server_resolution_removes_stale_interactions_and_publishes_the_next() {
        let mut fixture = Fixture::new().await;
        fixture.send(json!({"id":"stale","method":"item/commandExecution/requestApproval","params":{"threadId":"thread","turnId":"turn","itemId":"command"}})).await;
        let first = fixture.event("agent-tool-approval-request").await;
        fixture.send(json!({"id":"next","method":"item/tool/requestUserInput","params":{"threadId":"thread","turnId":"turn","itemId":"question","questions":[]}})).await;
        fixture.send(json!({"method":"serverRequest/resolved","params":{"threadId":"thread","requestId":"stale"}})).await;
        assert_eq!(
            fixture.event("agent-tool-approval-cancelled").await["approvalRequestId"],
            first["request_id"]
        );
        assert!(approve(
            first["request_id"].as_str().unwrap(),
            &["command".into()],
            &[]
        )
        .await
        .is_none());
        assert!(!fixture.event("agent-codex-question").await["question"].is_null());
        fixture.completed("interrupted").await;
        fixture.finish().await;
    }

    #[tokio::test]
    async fn completion_acknowledges_interrupts_before_the_rpc_response_arrives() {
        let mut fixture = Fixture::new().await;
        let request = fixture.request_id.clone();
        let stop = tokio::spawn(async move { interrupt(&request).await.unwrap() });
        let message = fixture.read().await;
        assert_eq!(message["method"], "turn/interrupt");
        fixture.completed("interrupted").await;
        assert!(tokio::time::timeout(Duration::from_secs(1), stop)
            .await
            .unwrap()
            .unwrap()
            .is_ok());
        assert_eq!(fixture.event("agent-complete").await["status"], "cancelled");
        fixture.finish().await;
    }

    #[tokio::test]
    async fn steering_waits_for_an_acknowledgement_even_when_completion_arrives_first() {
        let mut fixture = Fixture::new().await;
        let request = fixture.request_id.clone();
        let steer = tokio::spawn(async move {
            super::steer(&request, "Also check the tests".into())
                .await
                .unwrap()
        });
        let message = fixture.read().await;
        assert_eq!(message["method"], "turn/steer");
        assert_eq!(message["params"]["expectedTurnId"], "turn");
        fixture.completed("completed").await;
        fixture
            .send(
                json!({"id":message["id"],"error":{"code":-32600,"message":"Turn already ended"}}),
            )
            .await;
        assert_eq!(steer.await.unwrap().unwrap_err(), "Turn already ended");
        fixture.finish().await;
    }

    #[test]
    fn planning_never_grants_write_access_even_with_trust_enabled() {
        let config = AppConfig {
            plan_mode: true,
            approval_policy: "unrestricted".into(),
            ..AppConfig::default()
        };
        assert_eq!(permissions(&config), ("read-only", "never"));
        assert_eq!(
            permissions(&AppConfig::default()),
            ("workspace-write", "on-request")
        );
    }

    #[test]
    fn failed_commands_and_mcp_errors_remain_errors_in_the_existing_ui() {
        let (_, _, output) = tool_item(&json!({"type":"commandExecution","command":"test","exitCode":1,"aggregatedOutput":"failed test"})).unwrap();
        assert!(output.starts_with("Error:"));
        let (_, _, output) =
            tool_item(&json!({"type":"mcpToolCall","error":{"message":"offline"}})).unwrap();
        assert!(output.contains("offline"));
    }

    #[test]
    fn resumed_threads_do_not_resubmit_the_entire_history() {
        let history = vec![json!({"role":"user","content":"old"})];
        assert_eq!(
            turn_input("new".into(), history.clone(), true, vec![])[0]["text"],
            "new"
        );
        assert!(turn_input("new".into(), history, false, vec![])[0]["text"]
            .as_str()
            .unwrap()
            .contains("conversation_history"));
    }
}
