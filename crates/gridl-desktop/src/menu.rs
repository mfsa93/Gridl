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

    let conexiones = Submenu::with_items(
        app,
        "Conexiones",
        true,
        &[
            &MenuItem::with_id(app, "new-connection", "Nueva conexión", true, Some("CmdOrCtrl+N"))?,
            &MenuItem::with_id(app, "new-group", "Nuevo grupo", true, Some("CmdOrCtrl+Shift+G"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "reload", "Recargar datos", true, Some("CmdOrCtrl+R"))?,
        ],
    )?;

    let edit = Submenu::with_items(
        app,
        "Edición",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("Deshacer"))?,
            &PredefinedMenuItem::redo(app, Some("Rehacer"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("Cortar"))?,
            &PredefinedMenuItem::copy(app, Some("Copiar"))?,
            &PredefinedMenuItem::paste(app, Some("Pegar"))?,
            &PredefinedMenuItem::select_all(app, Some("Seleccionar todo"))?,
        ],
    )?;

    let window = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Ventana",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some("Minimizar"))?,
            &PredefinedMenuItem::maximize(app, Some("Zoom"))?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "close-tab", "Cerrar pestaña", true, Some("CmdOrCtrl+W"))?,
        ],
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
                    &PredefinedMenuItem::about(app, Some("Acerca de Gridl"), Some(about))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, Some("Ocultar Gridl"))?,
                    &PredefinedMenuItem::hide_others(app, Some("Ocultar otros"))?,
                    &PredefinedMenuItem::show_all(app, Some("Mostrar todo"))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, Some("Salir de Gridl"))?,
                ],
            )?,
            #[cfg(not(target_os = "macos"))]
            &Submenu::with_items(
                app,
                "Archivo",
                true,
                &[&PredefinedMenuItem::quit(app, Some("Salir"))?],
            )?,
            &conexiones,
            &edit,
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                "Visualización",
                true,
                &[&PredefinedMenuItem::fullscreen(app, Some("Pantalla completa"))?],
            )?,
            &window,
            #[cfg(not(target_os = "macos"))]
            &Submenu::with_items(
                app,
                "Ayuda",
                true,
                &[&PredefinedMenuItem::about(app, Some("Acerca de Gridl"), Some(about))?],
            )?,
        ],
    )?;

    app.set_menu(menu)?;
    Ok(())
}
