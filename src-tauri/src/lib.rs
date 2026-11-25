mod agent;
mod app_paths;
mod audit;
mod codex;
mod codex_transport;
mod commands;
mod config;
mod context;
mod crypto;
mod knowledge;
mod mcp;
mod policy;
mod provider;
mod skills;
mod storage;
mod text;
mod tools;
mod workspace;

use tauri::{Emitter, Listener, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();
    if app_paths::isolated_root().is_some() {
        for window in &mut context.config_mut().app.windows {
            window.create = false;
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            if let Some(root) = app_paths::isolated_root() {
                for window in &app.config().app.windows {
                    tauri::WebviewWindowBuilder::from_config(app, window)?
                        .data_directory(root.join("webview"))
                        .build()?;
                }
            }
            // System tray icon with menu
            let icon = app
                .default_window_icon()
                .cloned()
                .unwrap_or_else(|| tauri::image::Image::new_owned(vec![], 0, 0));

            let show = tauri::menu::MenuItemBuilder::with_id("show", "显示窗口").build(app)?;
            let settings = tauri::menu::MenuItemBuilder::with_id("settings", "设置").build(app)?;
            let quit = tauri::menu::MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = tauri::menu::MenuBuilder::new(app)
                .item(&show)
                .item(&settings)
                .separator()
                .item(&quit)
                .build()?;

            let tray = tauri::tray::TrayIconBuilder::new()
                .icon(icon)
                .tooltip("gxAgent Studio")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "settings" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                            let _ = window.emit("open-settings", ());
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;
            let _ = tray;

            // Register global shortcut: Ctrl+Shift+G to toggle window
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            let gs = app.global_shortcut();
            if let Err(error) = gs.register("CommandOrControl+Shift+G") {
                eprintln!(
                    "Global shortcut CommandOrControl+Shift+G is unavailable; continuing without it: {error}"
                );
            }

            let app_handle = app.handle().clone();
            app.listen("plugin:global-shortcut:shortcut-pressed", move |event| {
                let payload = event.payload();
                if payload.contains("CommandOrControl+Shift+G") {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        if window.is_visible().unwrap_or(false) {
                            let _ = window.hide();
                        } else {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::agent::start_agent_session,
            skills::list_skills,
            skills::read_skill_resource,
            knowledge::index_knowledge_file,
            knowledge::pick_knowledge_files,
            knowledge::list_knowledge_documents,
            knowledge::remove_knowledge_document,
            knowledge::search_knowledge,
            knowledge::knowledge_evaluations,
            knowledge::save_knowledge_case,
            knowledge::delete_knowledge_case,
            knowledge::run_knowledge_evaluation,
            mcp::inspect_mcp_tools,
            mcp::call_mcp_debug,
            storage::list_session_backups,
            storage::create_session_backup,
            storage::read_session_backup,
            storage::session_storage_issues,
            storage::repair_session_backup,
            codex::inspect_codex,
            codex::answer_codex_question,
            commands::agent::resolve_tool_approval,
            commands::agent::cancel_agent_session,
            commands::agent::fetch_models,
            commands::config::get_provider_presets,
            commands::config::get_default_config,
            commands::config::save_config,
            commands::config::load_config,
            commands::files::read_file_content,
            workspace::validate_workspace,
            workspace::list_directory_tree,
            workspace::get_git_status,
            workspace::get_git_diff,
            workspace::get_git_run_review,
            workspace::restore_git_path,
            workspace::create_git_checkpoint,
            workspace::list_git_checkpoints,
            workspace::delete_git_checkpoint,
            workspace::restore_git_checkpoint,
            commands::config::add_trusted_patterns,
            commands::config::remove_trusted_pattern,
            commands::agent::check_python_available,
            commands::config::save_profile,
            commands::config::delete_profile,
            storage::save_session,
            storage::save_sessions,
            storage::load_session,
            storage::load_sessions,
            storage::list_sessions,
            storage::delete_session,
            commands::config::set_active_profile,
            commands::config::clear_active_profile,
            commands::compaction::generate_session_title,
            commands::compaction::compact_history,
            commands::config::save_mcp_server,
            commands::config::delete_mcp_server,
            commands::config::test_mcp_server,
            commands::agent::fetch_ollama_models,
            commands::agent::push_steering_message,
            commands::config::export_config,
            commands::config::import_config,
            commands::config::clear_all_sessions,
            commands::files::save_code_file,
            commands::files::pick_workspace_directory,
            commands::files::parse_file_content_detailed,
            commands::files::pick_and_parse_files,
            commands::window::toggle_always_on_top,
        ])
        .run(context)
        .expect("error while running tauri application");
}
