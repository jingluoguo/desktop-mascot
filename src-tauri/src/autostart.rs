//! Launch at login. Access is requested once on first run; after that the dashboard owns the
//! setting.

use crate::storage;
use std::fs;
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;

#[tauri::command]
pub(crate) fn check_autostart<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn set_autostart<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    enabled: bool,
) -> Result<bool, String> {
    if cfg!(debug_assertions) && enabled {
        return Err("登录时启动只能在安装后的正式版中启用".into());
    }
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|error| error.to_string())?;
    } else {
        manager.disable().map_err(|error| error.to_string())?;
    }
    manager.is_enabled().map_err(|error| error.to_string())
}

pub(crate) fn request_once<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if cfg!(debug_assertions) {
        return;
    }
    let Ok(data_dir) = storage::app_data_dir(app) else {
        return;
    };
    let marker = data_dir.join("autostart-requested");
    let executable = std::env::current_exe().ok();
    let executable_marker = executable
        .as_ref()
        .map(|path| path.to_string_lossy().into_owned());
    if marker.exists()
        && executable_marker
            .as_deref()
            .is_some_and(|path| fs::read_to_string(&marker).ok().as_deref() == Some(path))
    {
        return;
    }
    if app.autolaunch().enable().is_ok() {
        let _ = fs::create_dir_all(&data_dir);
        if let Some(path) = executable_marker {
            let _ = fs::write(marker, path);
        }
    }
}
