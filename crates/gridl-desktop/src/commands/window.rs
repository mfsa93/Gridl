//! Windows with unsaved edits: what closing or quitting would lose.

use tauri::{AppHandle, State, Window};

use crate::state::AppState;

/// The UI reports whether the calling window holds edits that closing it would lose.
#[tauri::command]
pub fn set_unsaved(window: Window, state: State<'_, AppState>, unsaved: bool) {
    state.set_unsaved(window.label(), unsaved);
}

/// Quits after the user chose to discard pending edits.
#[tauri::command]
pub fn quit_discarding(app: AppHandle, state: State<'_, AppState>) {
    state.clear_unsaved();
    app.exit(0);
}

/// Closes the calling window after the user chose to discard its pending edits.
#[tauri::command]
pub fn close_discarding(window: Window, state: State<'_, AppState>) -> Result<(), String> {
    state.set_unsaved(window.label(), false);
    window.destroy().map_err(|err| err.to_string())
}
