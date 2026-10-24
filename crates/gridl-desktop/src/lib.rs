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
            if let Some(main) = app.get_webview_window("main") {
                windows::reveal_later(main);
            }
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
            commands::catalog::list_engines,
            commands::session::connect,
            commands::session::test_connection,
            commands::session::disconnect,
            commands::profiles::list_profiles,
            commands::profiles::save_connection,
            commands::profiles::create_group,
            commands::profiles::delete_group,
            commands::profiles::delete_profile,
            commands::catalog::introspect,
            commands::catalog::describe_relation,
            commands::catalog::table_objects,
            commands::query::execute_query,
            commands::query::cancel_query,
            commands::query::execute_batch,
            commands::catalog::check_sql,
            commands::catalog::foreign_keys,
            commands::export::write_export,
            commands::window::set_unsaved,
            commands::window::quit_discarding,
            commands::window::close_discarding,
            windows::open_connection_window,
            windows::open_home_window,
            team::team_state,
            team::team_link,
            team::team_share,
            team::team_unshare,
            team::team_save_queries,
            transfer::export::export_query,
            transfer::import::preview_csv,
            transfer::import::import_csv,
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
