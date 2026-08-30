use std::sync::Mutex;
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

struct TrayMenuState {
    visibility_item: tauri::menu::MenuItem<tauri::Wry>,
}

#[derive(Default)]
struct ShortcutBindingsState {
    bindings: Mutex<ShortcutBindings>,
}

#[derive(Default)]
struct ShortcutBindings {
    visibility: Option<u32>,
    dashboard: Option<u32>,
}

fn set_main_window_visibility(app: &tauri::AppHandle, visible: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    if visible {
        window.show()
    } else {
        window.hide()
    }
    .map_err(|error| error.to_string())?;

    if let Some(tray_menu) = app.try_state::<TrayMenuState>() {
        tray_menu
            .visibility_item
            .set_text(if visible { "隐藏" } else { "显示" })
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn quit_app<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    app.exit(0);
}

#[tauri::command]
fn hide_main_window(app: tauri::AppHandle) -> Result<(), String> {
    set_main_window_visibility(&app, false)
}

#[tauri::command]
fn set_global_shortcuts<R: tauri::Runtime>(
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

#[tauri::command]
fn position_main_window<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or_else(|| "no monitor is available".to_string())?;
    let work_area = monitor.work_area();
    let outer_size = window.outer_size().map_err(|error| error.to_string())?;
    let margin = (20.0 * monitor.scale_factor()).round() as i32;
    let x = work_area.position.x + work_area.size.width as i32 - outer_size.width as i32 - margin;
    let y = work_area.position.y + work_area.size.height as i32 - outer_size.height as i32 - margin;
    window
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn resize_main_window<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
    let old_size = window.outer_size().map_err(|error| error.to_string())?;
    let old_position = window.outer_position().map_err(|error| error.to_string())?;
    let next_size = PhysicalSize::new(
        (width * scale_factor).round().max(1.0) as u32,
        (height * scale_factor).round().max(1.0) as u32,
    );
    let delta_x = (next_size.width as i32 - old_size.width as i32) / 2;
    let delta_y = (next_size.height as i32 - old_size.height as i32) / 2;
    window
        .set_size(next_size)
        .map_err(|error| error.to_string())?;
    window
        .set_position(PhysicalPosition::new(
            old_position.x - delta_x,
            old_position.y - delta_y,
        ))
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
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
                    if let Some(window) = app.get_webview_window("main") {
                        let visible = window.is_visible().unwrap_or(true);
                        if visible {
                            let _ = set_main_window_visibility(app, false);
                        } else {
                            let _ = set_main_window_visibility(app, true);
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            app.manage(ShortcutBindingsState::default());
            // Accessory apps stay available from the menu bar without a Dock icon (macOS only).
            #[cfg(target_os = "macos")]
            let _ = app
                .handle()
                .set_activation_policy(tauri::ActivationPolicy::Accessory);
            #[cfg(not(target_os = "macos"))]
            let _ = app.handle();
            let _ = position_main_window(app.handle().clone());
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focusable(true);
            }

            let settings_item =
                tauri::menu::MenuItem::with_id(app, "open-settings", "仪表盘", true, None::<&str>)?;
            let visibility_item =
                tauri::menu::MenuItem::with_id(app, "toggle-pet", "隐藏", true, None::<&str>)?;
            let quit_item =
                tauri::menu::MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(
                app,
                &[&settings_item, &visibility_item, &quit_item],
            )?;
            app.manage(TrayMenuState {
                visibility_item: visibility_item.clone(),
            });

            let mut tray = tauri::tray::TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Desktop Mascot")
                // Keep the full-color mascot mark in the status bar so it matches the app icon.
                .icon_as_template(false)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let _ = tray.app_handle().emit("open-settings", ());
                    }
                })
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open-settings" => {
                        let _ = app.emit("open-settings", ());
                    }
                    "toggle-pet" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let is_visible = window.is_visible().unwrap_or(true);
                            let _ = set_main_window_visibility(app, !is_visible);
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });

            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            tray.build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            quit_app,
            hide_main_window,
            set_global_shortcuts,
            position_main_window,
            resize_main_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
