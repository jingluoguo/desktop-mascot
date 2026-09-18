//! Desktop Mascot's Tauri backend.
//!
//! Each module owns one concern and exposes the commands the renderer calls; `run` only wires them
//! together. Shared plumbing lives in `storage` (files in the app data directory) and `time`.

mod autostart;
mod models;
mod pomodoro;
mod reminders;
mod scheduler;
mod shortcuts;
mod storage;
mod time;
mod tray;
mod updater;
mod window;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Registered first, as the plugin requires. A second launch is handed to the running
        // instance instead of starting a rival one that would drive its own scheduler and write
        // its own copy of the JSON documents over the first one's.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Re-launching is a request to see the mascot, so surface it even if it was hidden
            // or docked to a screen edge.
            window::prepare_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("Desktop Mascot")
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    shortcuts::on_shortcut(app, shortcut, event.state());
                })
                .build(),
        )
        .setup(|app| {
            app.manage(shortcuts::ShortcutBindingsState::default());
            app.manage(updater::UpdateManagerState::default());
            app.manage(scheduler::SchedulerState::default());
            reminders::init(app.handle());
            pomodoro::init(app.handle());
            window::position::init(app.handle());
            // Started last so both domains have something to tick against.
            scheduler::start(app.handle());
            window::prepare_main_window(app.handle());
            autostart::request_once(app.handle());
            tray::setup(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            window::quit_app,
            window::hide_main_window,
            shortcuts::set_global_shortcuts,
            autostart::check_autostart,
            autostart::set_autostart,
            updater::get_update_status,
            updater::mark_up_to_date,
            updater::check_for_update,
            updater::start_update_download,
            updater::pause_update_download,
            updater::install_downloaded_update,
            window::position_main_window,
            window::resize_main_window,
            window::clamp_context_menu_position,
            window::dock::dock_main_window_to_edge,
            window::dock::reveal_main_window,
            window::dock::redock_main_window,
            models::list_custom_models,
            models::read_custom_model,
            models::delete_custom_model,
            models::install_custom_model,
            reminders::list_reminders,
            reminders::save_reminder,
            reminders::delete_reminder,
            reminders::resolve_reminder,
            reminders::list_reminder_events,
            pomodoro::get_pomodoro,
            pomodoro::start_pomodoro,
            pomodoro::pause_pomodoro,
            pomodoro::reset_pomodoro,
            pomodoro::skip_pomodoro,
            pomodoro::save_pomodoro
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
