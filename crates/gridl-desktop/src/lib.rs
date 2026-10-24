mod backup;
mod commands;
#[cfg(test)]
mod integration_tests;
mod menu;
mod state;
mod team;
mod transfer;
mod tunnel;
mod vault;
mod windows;

use tauri::Manager;

/// Starts the desktop shell. The database engine lives in `gridl-core`.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_menu_event(|app, event| {
            let command = event.id().0.clone();
            if matches!(
                command.as_str(),
                "new-connection"
                    | "new-sql-tab"
                    | "quick-open"
                    | "open-connection"
                    | "new-group"
                    | "close-tab"
                    | "reload"
                    | "check-updates"
            ) {
                // Only the window the user is looking at acts on the menu.
                if let Some(label) = windows::focused_label(app) {
                    windows::emit_to_window(app, &label, "gridl-command", command);
                }
            }
        })
        .setup(|app| {
            app.manage(state::AppState::new());
            menu::install(app.handle())?;
            // gridl:// links, whether they start the app or reach it while it runs.
            use tauri_plugin_deep_link::DeepLinkExt;
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    windows::open_link(&handle, &url);
                }
            });
            Ok(())
        })
        .on_window_event(windows::on_window_event)
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
            commands::close_discarding,
            windows::open_connection_window,
            windows::open_home_window,
            team::team_state,
            team::team_link,
            team::team_share,
            team::team_unshare,
            team::team_save_queries,
            transfer::export_query,
            transfer::preview_csv,
            transfer::import_csv,
            backup::backup_database,
            backup::restore_database,
        ])
        .build(tauri::generate_context!())
        .expect("gridl failed to start")
        .run(|app, event| {
            // Cmd+Q and Quit from the menu: same check. `exit(0)` from the UI carries a code and passes.
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = event {
                windows::on_exit_requested(app, &api);
            }
        });
}
