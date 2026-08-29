use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize};
use tauri_plugin_opener::OpenerExt;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn open_author_page<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    app.opener()
        .open_url("https://github.com/jingluoguo", None::<&str>)
        .map_err(|error| error.to_string())
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
        .setup(|app| {
            // Accessory apps stay available from the menu bar without a Dock icon.
            let _ = app
                .handle()
                .set_activation_policy(tauri::ActivationPolicy::Accessory);
            let _ = position_main_window(app.handle().clone());

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

            let visibility_item_for_handler = visibility_item.clone();
            let mut tray = tauri::tray::TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Desktop Mascot")
                // Keep the full-color mascot mark in the status bar so it matches the app icon.
                .icon_as_template(false)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open-settings" => {
                        let _ = app.emit("open-settings", ());
                    }
                    "toggle-pet" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let is_visible = window.is_visible().unwrap_or(true);
                            if is_visible {
                                let _ = window.hide();
                                let _ = visibility_item_for_handler.set_text("显示");
                            } else {
                                let _ = window.show();
                                let _ = visibility_item_for_handler.set_text("隐藏");
                            }
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
            open_author_page,
            position_main_window,
            resize_main_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
