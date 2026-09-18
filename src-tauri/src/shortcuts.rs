//! Global shortcuts: the bindings currently in effect, and how a key press is routed.

use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Default)]
pub(crate) struct ShortcutBindingsState {
    bindings: Mutex<ShortcutBindings>,
}

#[derive(Default)]
struct ShortcutBindings {
    visibility: Option<u32>,
    dashboard: Option<u32>,
}

/// Routes a key press to its action. Bindings are read at press time, so the dashboard can rebind a
/// shortcut without restarting the app.
pub(crate) fn on_shortcut<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    shortcut: &Shortcut,
    state: ShortcutState,
) {
    if state != ShortcutState::Pressed {
        return;
    }
    let bindings_state = app.state::<ShortcutBindingsState>();
    let Ok(bindings) = bindings_state.bindings.lock() else {
        return;
    };
    let visibility_matches = bindings.visibility == Some(shortcut.id());
    let dashboard_matches = bindings.dashboard == Some(shortcut.id());
    drop(bindings);
    if dashboard_matches {
        let _ = app.emit("open-settings", ());
        return;
    }
    if !visibility_matches {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.is_visible().unwrap_or(true) {
        let _ = crate::window::set_main_window_visibility(app, false);
    } else {
        let _ = crate::window::set_main_window_visibility(app, true);
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub(crate) fn set_global_shortcuts<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    bindings_state: tauri::State<'_, ShortcutBindingsState>,
    visibility_shortcut: String,
    dashboard_shortcut: String,
) -> Result<(), String> {
    let parse = |value: &str| -> Result<Option<Shortcut>, String> {
        if value.trim().is_empty() {
            Ok(None)
        } else {
            value
                .parse::<Shortcut>()
                .map(Some)
                .map_err(|error| error.to_string())
        }
    };
    let visibility = parse(&visibility_shortcut)?;
    let dashboard = parse(&dashboard_shortcut)?;
    if visibility.map(|shortcut| shortcut.id()) == dashboard.map(|shortcut| shortcut.id())
        && visibility.is_some()
    {
        return Err("shortcut is already assigned to another action".to_string());
    }

    let manager = app.global_shortcut();
    manager
        .unregister_all()
        .map_err(|error| error.to_string())?;
    for shortcut in [visibility, dashboard].into_iter().flatten() {
        if let Err(error) = manager.register(shortcut) {
            let _ = manager.unregister_all();
            return Err(error.to_string());
        }
    }
    *bindings_state
        .bindings
        .lock()
        .map_err(|error| error.to_string())? = ShortcutBindings {
        visibility: visibility.map(|shortcut| shortcut.id()),
        dashboard: dashboard.map(|shortcut| shortcut.id()),
    };
    Ok(())
}
