//! The menu-bar icon and its menu. Left-clicking the icon reopens the dashboard, matching the
//! "open-settings" event the settings window listens for.

use crate::window::set_main_window_visibility;
use tauri::{Emitter, Manager};

pub(crate) struct TrayMenuState {
    pub(crate) visibility_item: tauri::menu::MenuItem<tauri::Wry>,
}

pub(crate) fn setup(app: &mut tauri::App) -> tauri::Result<()> {
    let settings_item =
        tauri::menu::MenuItem::with_id(app, "open-settings", "仪表盘", true, None::<&str>)?;
    let visibility_item =
        tauri::menu::MenuItem::with_id(app, "toggle-pet", "隐藏", true, None::<&str>)?;
    let quit_item = tauri::menu::MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = tauri::menu::Menu::with_items(app, &[&settings_item, &visibility_item, &quit_item])?;
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
            "quit" => {
                crate::window::position::persist_current_window_position(app, true);
                app.exit(0);
            }
            _ => {}
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.build(app)?;
    Ok(())
}
