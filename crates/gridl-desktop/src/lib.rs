mod commands;
mod menu;
mod state;
mod tunnel;
mod vault;

use tauri::{Emitter, Manager};

/// Starts the desktop shell. The database engine lives in `gridl-core`.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .on_menu_event(|app, event| {
            let command = event.id().0.clone();
            if matches!(command.as_str(), "new-connection" | "new-group" | "close-tab" | "reload") {
                let _ = app.emit("gridl-command", command);
            }
        })
        .setup(|app| {
            app.manage(state::AppState::new());
            menu::install(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // The red close button: hold it while the UI has unsaved edits.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if has_unsaved(window.app_handle()) {
                    api.prevent_close();
                    let _ = window.app_handle().emit("gridl-quit-requested", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::connect,
            commands::test_connection,
            commands::disconnect,
            commands::list_profiles,
            commands::save_connection,
            commands::create_group,
            commands::delete_group,
            commands::delete_profile,
            commands::introspect,
            commands::execute_query,
            commands::cancel_query,
            commands::execute_batch,
            commands::check_sql,
            commands::foreign_keys,
            commands::write_export,
            commands::set_unsaved,
            commands::quit_discarding,
        ])
        .build(tauri::generate_context!())
        .expect("gridl failed to start")
        .run(|app, event| {
            // Cmd+Q and Quit from the menu: same check. `exit(0)` from the UI carries a code and passes.
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = event {
                if has_unsaved(app) {
                    api.prevent_exit();
                    let _ = app.emit("gridl-quit-requested", ());
                }
            }
        });
}

fn has_unsaved(app: &tauri::AppHandle) -> bool {
    app.try_state::<state::AppState>()
        .is_some_and(|state| state.unsaved.load(std::sync::atomic::Ordering::Relaxed))
}
