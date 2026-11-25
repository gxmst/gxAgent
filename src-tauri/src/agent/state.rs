use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;
use tokio::sync::{watch, Mutex, Semaphore};

pub(super) const AGENT_CANCELLED_ERROR: &str = "__GX_AGENT_CANCELLED__";
pub(super) const AGENT_STEERING_INTERRUPTED_OUTPUT: &str =
    "Tool interrupted by user steering. Re-evaluate the request before taking another action.";

// Steering messages are keyed by request_id so concurrent sessions/requests
// never cross-contaminate each other's intervention queues.
type SteeringQueue = HashMap<String, Vec<String>>;

static STEERING_QUEUE: once_cell::sync::Lazy<Arc<Mutex<SteeringQueue>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(SteeringQueue::new())));

type SteeringInterruptMap = HashMap<String, watch::Sender<bool>>;

static STEERING_INTERRUPTS: once_cell::sync::Lazy<Arc<Mutex<SteeringInterruptMap>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(SteeringInterruptMap::new())));

type CancellationMap = HashMap<String, watch::Sender<bool>>;

static AGENT_CANCELLATIONS: once_cell::sync::Lazy<Arc<Mutex<CancellationMap>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(CancellationMap::new())));

pub(super) static CHECKPOINTED_REQUESTS: once_cell::sync::Lazy<Arc<Mutex<HashSet<String>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));

/// Subagents are deliberately shallow and bounded. They are a focused
/// read-only helper, not a second unbounded agent tree.
pub(super) static SUBAGENT_SLOTS: once_cell::sync::Lazy<Arc<Semaphore>> =
    once_cell::sync::Lazy::new(|| Arc::new(Semaphore::new(3)));

/// Global pending approvals store: request_id -> watch::Sender channel
type ApprovalMap = HashMap<String, watch::Sender<Option<Vec<(String, bool)>>>>;

static PENDING_APPROVALS: once_cell::sync::Lazy<Arc<Mutex<ApprovalMap>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(ApprovalMap::new())));

pub(crate) async fn register_cancellation(request_id: &str) -> watch::Receiver<bool> {
    let (tx, rx) = watch::channel(false);
    let mut cancellations = AGENT_CANCELLATIONS.lock().await;
    cancellations.insert(request_id.to_string(), tx);
    rx
}

pub(super) async fn register_steering_interrupt(request_id: &str) -> watch::Receiver<bool> {
    let (tx, rx) = watch::channel(false);
    STEERING_INTERRUPTS
        .lock()
        .await
        .insert(request_id.to_string(), tx);
    rx
}

pub(crate) async fn unregister_cancellation(request_id: &str) {
    {
        let mut cancellations = AGENT_CANCELLATIONS.lock().await;
        cancellations.remove(request_id);
    }
    STEERING_INTERRUPTS.lock().await.remove(request_id);
    CHECKPOINTED_REQUESTS.lock().await.remove(request_id);
}

pub async fn cancel_agent_request(request_id: &str) -> Result<(), String> {
    let cancellations = AGENT_CANCELLATIONS.lock().await;
    let tx = cancellations
        .get(request_id)
        .ok_or_else(|| format!("No active agent request found: {}", request_id))?;
    tx.send(true)
        .map_err(|_| "Failed to signal agent cancellation".to_string())
}

fn is_cancelled(cancel_rx: &watch::Receiver<bool>) -> bool {
    *cancel_rx.borrow()
}

pub(super) fn ensure_not_cancelled(cancel_rx: &watch::Receiver<bool>) -> Result<(), String> {
    if is_cancelled(cancel_rx) {
        Err(AGENT_CANCELLED_ERROR.to_string())
    } else {
        Ok(())
    }
}

pub(super) fn is_agent_cancelled_error(err: &str) -> bool {
    err == AGENT_CANCELLED_ERROR
}

pub(crate) async fn wait_for_cancellation(cancel_rx: &mut watch::Receiver<bool>) {
    if *cancel_rx.borrow() {
        return;
    }
    while cancel_rx.changed().await.is_ok() {
        if *cancel_rx.borrow() {
            return;
        }
    }
}

pub(super) async fn await_with_cancel<T, F>(
    cancel_rx: &watch::Receiver<bool>,
    future: F,
) -> Result<T, String>
where
    F: Future<Output = T>,
{
    let mut cancel_rx = cancel_rx.clone();
    tokio::select! {
        _ = wait_for_cancellation(&mut cancel_rx) => Err(AGENT_CANCELLED_ERROR.to_string()),
        value = future => Ok(value),
    }
}

pub async fn push_steering_message(request_id: String, msg: String) {
    let mut queue = STEERING_QUEUE.lock().await;
    queue.entry(request_id.clone()).or_default().push(msg);
    drop(queue);
    if let Some(sender) = STEERING_INTERRUPTS.lock().await.get(&request_id) {
        let _ = sender.send(true);
    }
}

pub(super) async fn clear_steering_interrupt(request_id: &str) {
    if let Some(sender) = STEERING_INTERRUPTS.lock().await.get(request_id) {
        let _ = sender.send(false);
    }
}

pub(super) async fn wait_for_steering_interrupt(receiver: &mut watch::Receiver<bool>) {
    if *receiver.borrow() {
        return;
    }
    while receiver.changed().await.is_ok() {
        if *receiver.borrow() {
            return;
        }
    }
}

pub(super) async fn drain_steering_messages(request_id: &str) -> Vec<String> {
    let mut queue = STEERING_QUEUE.lock().await;
    match queue.get_mut(request_id) {
        Some(msgs) => std::mem::take(msgs),
        None => Vec::new(),
    }
}

/// Remove any steering queue for a finished request so the map doesn't grow
/// unbounded across many requests.
pub(super) async fn clear_steering_messages(request_id: &str) {
    let mut queue = STEERING_QUEUE.lock().await;
    queue.remove(request_id);
}

pub(super) async fn register_approval_wait(
    request_id: &str,
) -> watch::Receiver<Option<Vec<(String, bool)>>> {
    let mut pending = PENDING_APPROVALS.lock().await;
    let (tx, rx) = watch::channel(None::<Vec<(String, bool)>>);
    pending.insert(request_id.to_string(), tx);
    rx
}

pub(super) async fn cancel_registered_approval(request_id: &str) {
    PENDING_APPROVALS.lock().await.remove(request_id);
}

/// Wait for frontend to resolve a tool approval request.
/// The timeout is a leak backstop, not a UX pace-setter: killing a whole run
/// because the user stepped away for ten minutes is far worse than a stale
/// approval card, so it is deliberately generous. Cancellation (stop button,
/// closing the session) still tears the wait down immediately.
pub(super) async fn wait_for_registered_approval(
    request_id: &str,
    mut rx: watch::Receiver<Option<Vec<(String, bool)>>>,
    cancel_rx: &watch::Receiver<bool>,
) -> Result<Vec<(String, bool)>, String> {
    const APPROVAL_TIMEOUT_SECS: u64 = 3600; // 1 hour

    // Wait for the value to change from None to Some, with timeout
    let timeout = tokio::time::sleep(std::time::Duration::from_secs(APPROVAL_TIMEOUT_SECS));
    tokio::pin!(timeout);
    let mut cancel_rx = cancel_rx.clone();

    loop {
        tokio::select! {
            result = rx.changed() => {
                result.map_err(|_| "Approval channel closed unexpectedly".to_string())?;
                let result = rx.borrow().clone();
                if let Some(results) = result {
                    return Ok(results);
                }
            }
            _ = &mut timeout => {
                // Clean up the orphaned entry
                let mut pending = PENDING_APPROVALS.lock().await;
                pending.remove(request_id);
                return Err(format!(
                    "Approval request timed out after {} seconds",
                    APPROVAL_TIMEOUT_SECS
                ));
            }
            _ = wait_for_cancellation(&mut cancel_rx) => {
                let mut pending = PENDING_APPROVALS.lock().await;
                pending.remove(request_id);
                return Err(AGENT_CANCELLED_ERROR.to_string());
            }
        }
    }
}

/// Called by the frontend to resolve a pending approval
pub async fn resolve_approval(
    request_id: &str,
    results: Vec<(String, bool)>,
) -> Result<(), String> {
    let mut pending = PENDING_APPROVALS.lock().await;
    if let Some(tx) = pending.remove(request_id) {
        tx.send(Some(results))
            .map_err(|_| "Failed to send approval result".to_string())?;
        Ok(())
    } else {
        Err(format!(
            "No pending approval found for request: {}",
            request_id
        ))
    }
}

#[cfg(test)]
mod cancellation_tests {
    use super::*;

    #[tokio::test]
    async fn registered_request_can_be_cancelled_and_unregistered() {
        let request_id = format!("cancellation-test-{}", uuid::Uuid::new_v4());
        let mut cancel_rx = register_cancellation(&request_id).await;

        cancel_agent_request(&request_id).await.unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            wait_for_cancellation(&mut cancel_rx),
        )
        .await
        .expect("cancellation signal should be observed");

        unregister_cancellation(&request_id).await;
        let error = cancel_agent_request(&request_id).await.unwrap_err();
        assert!(error.contains("No active agent request found"));
    }
}
