//! Window plumbing: visibility, placement, and sizing for the mascot window, plus the shared
//! geometry vocabulary that the dock and the renderer both speak.

pub(crate) mod dock;
pub(crate) mod position;

use self::position::{persist_current_window_position, WindowPositionState};
use crate::tray::TrayMenuState;
use serde::{Deserialize, Serialize};
use tauri::{Manager, PhysicalPosition, PhysicalSize};

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DockEdge {
    Left,
    Right,
    Top,
    Bottom,
}

#[derive(Clone)]
pub(crate) enum DockState {
    Docked(DockEdge),
    Revealed(DockEdge),
}

pub(crate) const SIDE_DOCK_VISIBLE_RATIO: f64 = 0.55;

pub(crate) fn set_main_window_visibility<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    visible: bool,
) -> Result<(), String> {
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

#[tauri::command]
pub(crate) fn quit_app<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    persist_current_window_position(&app, true);
    app.exit(0);
}

#[tauri::command]
pub(crate) fn hide_main_window(app: tauri::AppHandle) -> Result<(), String> {
    set_main_window_visibility(&app, false)
}

#[tauri::command]
pub(crate) fn position_main_window<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
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
pub(crate) fn resize_main_window<R: tauri::Runtime>(
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
    let dock_state = app.try_state::<WindowPositionState>().and_then(|state| {
        state
            .0
            .dock_state
            .lock()
            .ok()
            .and_then(|dock_state| dock_state.clone())
    });
    let was_docked = dock_state.is_some();
    window
        .set_size(next_size)
        .map_err(|error| error.to_string())?;
    // Keep an attached window on its edge when the renderer changes its native canvas size.
    let next_position = if let Some(dock_state) = dock_state {
        let (area_position, area_size, _) = monitor_work_area(&window)?;
        let area_right = area_position.x + area_size.width as i32;
        let area_bottom = area_position.y + area_size.height as i32;
        let width = next_size.width as i32;
        let height = next_size.height as i32;
        let clamp_x = |x: i32| x.clamp(area_position.x, area_right - width);
        let clamp_y = |y: i32| y.clamp(area_position.y, area_bottom - height);
        let side_peek = (width as f64 * SIDE_DOCK_VISIBLE_RATIO).round() as i32;
        let peek = (14.0 * scale_factor).round() as i32;
        match dock_state {
            DockState::Docked(edge) => match edge {
                DockEdge::Left => PhysicalPosition::new(
                    area_position.x - width + side_peek,
                    clamp_y(old_position.y),
                ),
                DockEdge::Right => {
                    PhysicalPosition::new(area_right - side_peek, clamp_y(old_position.y))
                }
                DockEdge::Top => PhysicalPosition::new(
                    clamp_x(old_position.x),
                    area_position.y - height / 2 + peek,
                ),
                DockEdge::Bottom => {
                    PhysicalPosition::new(clamp_x(old_position.x), area_bottom - height / 2 - peek)
                }
            },
            DockState::Revealed(edge) => match edge {
                DockEdge::Left => PhysicalPosition::new(area_position.x, clamp_y(old_position.y)),
                DockEdge::Right => {
                    PhysicalPosition::new(area_right - width, clamp_y(old_position.y))
                }
                DockEdge::Top => PhysicalPosition::new(clamp_x(old_position.x), area_position.y),
                DockEdge::Bottom => {
                    PhysicalPosition::new(clamp_x(old_position.x), area_bottom - height)
                }
            },
        }
    } else {
        let delta_x = (next_size.width as i32 - old_size.width as i32) / 2;
        let delta_y = (next_size.height as i32 - old_size.height as i32) / 2;
        PhysicalPosition::new(old_position.x - delta_x, old_position.y - delta_y)
    };
    window
        .set_position(next_position)
        .map_err(|error| error.to_string())?;
    if was_docked {
        persist_current_window_position(&app, true);
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn clamp_context_menu_position<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<PhysicalPosition<i32>, String> {
    let monitor = app
        .monitor_from_point(x as f64, y as f64)
        .map_err(|error| error.to_string())?
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or_else(|| "no monitor is available".to_string())?;
    let area = monitor.work_area();
    let max_x = (area.position.x + area.size.width as i32 - width as i32).max(area.position.x);
    let max_y = (area.position.y + area.size.height as i32 - height as i32).max(area.position.y);
    Ok(PhysicalPosition::new(
        x.clamp(area.position.x, max_x),
        y.clamp(area.position.y, max_y),
    ))
}

pub(crate) fn monitor_work_area<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(tauri::PhysicalPosition<i32>, tauri::PhysicalSize<u32>, f64), String> {
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or_else(|| "no monitor is available".to_string())?;
    Ok((
        monitor.work_area().position,
        monitor.work_area().size,
        monitor.scale_factor(),
    ))
}

/// Keeps the mascot usable across restarts. A login-item launch can inherit a hidden or minimized
/// state from the previous process, and on macOS the accessory policy keeps the app out of the
/// Dock while leaving it in the menu bar.
pub(crate) fn prepare_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focusable(true);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
