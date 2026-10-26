use gridl_core::tr;
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu, WINDOW_SUBMENU_ID};
use tauri::{AppHandle, Runtime};

/// Installs the menu bar and enables the standard editing commands.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let pkg = app.package_info();
    let about = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        ..Default::default()
    };

    let connections = Submenu::with_items(
        app,
        tr!("Connections", "Conexiones"),
        true,
        &[
            &MenuItem::with_id(
                app,
                "new-connection",
                tr!("New Connection", "Nueva conexión"),
                true,
                Some("CmdOrCtrl+N"),
            )?,
            &MenuItem::with_id(
                app,
                "quick-open",
                tr!("Open Object…", "Abrir objeto…"),
                true,
                Some("CmdOrCtrl+P"),
            )?,
            &MenuItem::with_id(
                app,
                "new-sql-tab",
                tr!("New SQL Tab", "Nueva pestaña SQL"),
                true,
                Some("CmdOrCtrl+T"),
            )?,
            &MenuItem::with_id(
                app,
                "open-connection",
                tr!("Open Connection…", "Abrir conexión…"),
                true,
                Some("CmdOrCtrl+O"),
            )?,
            &MenuItem::with_id(
                app,
                "new-group",
                tr!("New Group", "Nuevo grupo"),
                true,
                Some("CmdOrCtrl+Shift+G"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "reload",
                tr!("Reload Data", "Recargar datos"),
                true,
                Some("CmdOrCtrl+R"),
            )?,
        ],
    )?;

    let edit = Submenu::with_items(
        app,
        tr!("Edit", "Edición"),
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(&tr!("Undo", "Deshacer")))?,
            &PredefinedMenuItem::redo(app, Some(&tr!("Redo", "Rehacer")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some(&tr!("Cut", "Cortar")))?,
            &PredefinedMenuItem::copy(app, Some(&tr!("Copy", "Copiar")))?,
            &PredefinedMenuItem::paste(app, Some(&tr!("Paste", "Pegar")))?,
            &PredefinedMenuItem::select_all(app, Some(&tr!("Select All", "Seleccionar todo")))?,
        ],
    )?;

    let window = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        tr!("Window", "Ventana"),
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(&tr!("Minimize", "Minimizar")))?,
            &PredefinedMenuItem::maximize(app, Some("Zoom"))?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "close-tab",
                tr!("Close Tab", "Cerrar pestaña"),
                true,
                Some("CmdOrCtrl+W"),
            )?,
        ],
    )?;

    let export_errors = MenuItem::with_id(
        app,
        "export-errors",
        tr!("Export Error Log…", "Exportar registro de errores…"),
        true,
        None::<&str>,
    )?;

    let menu = Menu::with_items(
        app,
        &[
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                pkg.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(
                        app,
                        Some(&tr!("About Gridl", "Acerca de Gridl")),
                        Some(about),
                    )?,
                    &MenuItem::with_id(
                        app,
                        "check-updates",
                        tr!("Check for Updates…", "Buscar actualizaciones…"),
                        true,
                        None::<&str>,
                    )?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, Some(&tr!("Hide Gridl", "Ocultar Gridl")))?,
                    &PredefinedMenuItem::hide_others(
                        app,
                        Some(&tr!("Hide Others", "Ocultar otros")),
                    )?,
                    &PredefinedMenuItem::show_all(app, Some(&tr!("Show All", "Mostrar todo")))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, Some(&tr!("Quit Gridl", "Salir de Gridl")))?,
                ],
            )?,
            #[cfg(not(target_os = "macos"))]
            &Submenu::with_items(
                app,
                tr!("File", "Archivo"),
                true,
                &[&PredefinedMenuItem::quit(app, Some(&tr!("Quit", "Salir")))?],
            )?,
            &connections,
            &edit,
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                tr!("View", "Visualización"),
                true,
                &[&PredefinedMenuItem::fullscreen(
                    app,
                    Some(&tr!("Enter Full Screen", "Pantalla completa")),
                )?],
            )?,
            &window,
            #[cfg(target_os = "macos")]
            &Submenu::with_items(app, tr!("Help", "Ayuda"), true, &[&export_errors])?,
            #[cfg(not(target_os = "macos"))]
            &Submenu::with_items(
                app,
                tr!("Help", "Ayuda"),
                true,
                &[
                    &PredefinedMenuItem::about(
                        app,
                        Some(&tr!("About Gridl", "Acerca de Gridl")),
                        Some(about),
                    )?,
                    &MenuItem::with_id(
                        app,
                        "check-updates",
                        tr!("Check for Updates…", "Buscar actualizaciones…"),
                        true,
                        None::<&str>,
                    )?,
                    &PredefinedMenuItem::separator(app)?,
                    &export_errors,
                ],
            )?,
        ],
    )?;

    app.set_menu(menu)?;
    Ok(())
}
