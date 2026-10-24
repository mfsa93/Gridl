//! Rows the UI already holds, written to a file the user picked.

use std::path::PathBuf;

use gridl_core::tr;

/// Extensions the export commands may write. The path comes from a save dialog.
const EXPORT_EXTENSIONS: [&str; 5] = ["csv", "tsv", "json", "sql", "txt"];
/// Upper bound for one exported file.
const MAX_EXPORT_BYTES: usize = 512 * 1024 * 1024;

/// Writes exported rows to a path the user picked in the save dialog.
#[tauri::command]
pub async fn write_export(path: String, contents: String) -> Result<(), String> {
    let path = export_path(&path)?;
    if contents.len() > MAX_EXPORT_BYTES {
        return Err(tr!("the file is larger than 512 MiB", "el archivo supera 512 MiB"));
    }
    tokio::task::spawn_blocking(move || std::fs::write(&path, contents.as_bytes()))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())
}

/// Checks a save-dialog path for an export: an allowed extension, not a folder.
pub(crate) fn export_path(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !EXPORT_EXTENSIONS.contains(&extension.as_str()) {
        return Err(tr!(
            "extension not allowed: .{extension}",
            "extensión no permitida: .{extension}"
        ));
    }
    if path.is_dir() {
        return Err(tr!("the path is a folder", "la ruta es una carpeta"));
    }
    Ok(path)
}
