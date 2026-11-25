/// Toggle window always-on-top
#[tauri::command]
pub async fn toggle_always_on_top(window: tauri::Window) -> Result<bool, String> {
    let is_top = window.is_always_on_top().map_err(|e| e.to_string())?;
    window
        .set_always_on_top(!is_top)
        .map_err(|e| e.to_string())?;
    Ok(!is_top)
}
