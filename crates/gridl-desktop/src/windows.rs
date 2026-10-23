//! One connection per window: opening connection windows, focusing the owner
//! of a connection, and routing window-level events.

use std::hash::{BuildHasher, Hasher};

use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::commands::fail;
use crate::state::AppState;

/// Prefix of the error `connect` returns when another window owns the connection.
pub const FOCUSED_PREFIX: &str = "gridl-focused:";
/// Event a window receives when closing it, or quitting, would lose its edits.
pub const CLOSE_REQUESTED: &str = "gridl-close-requested";

/// Shows, unminimizes, and focuses the window `label`. False when it does not exist.
pub fn focus(app: &AppHandle, label: &str) -> bool {
    let Some(window) = app.get_webview_window(label) else {
        return false;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    true
}

/// The focused window, or `main`, or any window when none has focus.
pub fn focused_label(app: &AppHandle) -> Option<String> {
    let windows = app.webview_windows();
    windows
        .iter()
        .find(|(_, window)| window.is_focused().unwrap_or(false))
        .or_else(|| windows.get_key_value("main"))
        .or_else(|| windows.iter().next())
        .map(|(label, _)| label.clone())
}

/// Sends `event` to the window `label` only.
pub fn emit_to_window<S: serde::Serialize + Clone>(
    app: &AppHandle,
    label: &str,
    event: &str,
    payload: S,
) {
    let _ = app.emit_to(label, event, payload);
}

fn new_label(app: &AppHandle) -> String {
    let state = std::collections::hash_map::RandomState::new();
    let mut salt: u64 = 0;
    loop {
        let mut hasher = state.build_hasher();
        hasher.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_nanos()),
        );
        hasher.write_u64(salt);
        let label = format!("conn-{:08x}", hasher.finish() as u32);
        if app.get_webview_window(&label).is_none() {
            return label;
        }
        salt += 1;
    }
}

/// Percent-encodes everything but unreserved URL characters, like `encodeURIComponent`.
fn encode_component(text: &str) -> String {
    let mut encoded = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// Opens a window that connects to `connection_id` on load, or focuses the
/// window that already owns it. Returns the window label.
#[tauri::command]
pub async fn open_connection_window(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<String, String> {
    let id = gridl_core::ConnectionId::new(connection_id).map_err(fail)?;
    if let Some(owner) = state.owner(id.as_str()) {
        if focus(&app, &owner) {
            return Ok(owner);
        }
    }
    let label = new_label(&app);
    let url =
        WebviewUrl::App(format!("index.html#connect={}", encode_component(id.as_str())).into());
    let builder = WebviewWindowBuilder::new(&app, &label, url)
        .title("Gridl")
        .inner_size(1440.0, 900.0)
        .min_inner_size(960.0, 640.0);
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(18.0, 20.0))
        .transparent(true)
        .effects(
            tauri::window::EffectsBuilder::new()
                .effect(tauri::window::Effect::Sidebar)
                .state(tauri::window::EffectState::FollowsWindowActiveState)
                .build(),
        );
    // Claim the connection now so a second request focuses this window
    // instead of opening another one before it connects.
    state.set_owner(id.as_str(), &label);
    if let Err(err) = builder.build() {
        state.clear_owner(id.as_str());
        return Err(err.to_string());
    }
    Ok(label)
}

/// Window events: ask before closing a window with unsaved edits, and close
/// the sessions of a window that is gone.
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let app = window.app_handle();
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let label = window.label();
    match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            if state.is_unsaved(label) {
                api.prevent_close();
                emit_to_window(app, label, CLOSE_REQUESTED, "window");
            }
        }
        tauri::WindowEvent::Destroyed => {
            state.set_unsaved(label, false);
            let owned = state.take_owned(label);
            if owned.is_empty() {
                return;
            }
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let state = app.state::<AppState>();
                for id in owned {
                    // Another window may have claimed it in the meantime.
                    if state.owner(&id).is_none() {
                        crate::commands::close_session(&state, &id).await;
                    }
                }
            });
        }
        _ => {}
    }
}

/// Cmd+Q and Quit: hold the exit while any window has unsaved edits and ask that window.
pub fn on_exit_requested(app: &AppHandle, api: &tauri::ExitRequestApi) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    if let Some(label) = state.first_unsaved() {
        api.prevent_exit();
        focus(app, &label);
        emit_to_window(app, &label, CLOSE_REQUESTED, "app");
    }
}

#[cfg(test)]
mod tests {
    use super::encode_component;

    #[test]
    fn encodes_ids_for_the_url_fragment() {
        assert_eq!(encode_component("abc-123_x.y~z"), "abc-123_x.y~z");
        assert_eq!(encode_component("a#b?c%d"), "a%23b%3Fc%25d");
        assert_eq!(encode_component("ñ"), "%C3%B1");
    }
}
