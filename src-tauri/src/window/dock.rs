//! Screen-edge behaviour: snapping the mascot to an edge, and sliding it back out on demand.

use super::monitor_work_area;
use super::position::{persist_current_window_position, WindowPositionState};
use super::{DockEdge, DockState, SIDE_DOCK_VISIBLE_RATIO};
use tauri::{Manager, PhysicalPosition};

#[tauri::command]
pub(crate) fn dock_main_window_to_edge<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    window_x: i32,
    window_y: i32,
    snap_threshold: Option<i32>,
) -> Result<bool, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    // The renderer computes the exact release position. Use it rather than
    // querying the window again, because the native position update can lag a
    // frame behind the pointer-up event.
    let position = PhysicalPosition::new(window_x, window_y);
    let window_center_x = window_x.saturating_add(size.width as i32 / 2);
    let window_center_y = window_y.saturating_add(size.height as i32 / 2);
    let monitor = app
        .monitor_from_point(window_center_x as f64, window_center_y as f64)
        .map_err(|error| error.to_string())?
        .or_else(|| window.current_monitor().ok().flatten())
        // A window can be fully outside every display while it is dragged.
        // In that case, return it to the nearest work area rather than
        // abandoning the dock request and leaving the mascot inaccessible.
        .or_else(|| {
            app.available_monitors()
                .ok()?
                .into_iter()
                .min_by_key(|monitor| {
                    let area = monitor.work_area();
                    let area_right = area.position.x.saturating_add(area.size.width as i32);
                    let area_bottom = area.position.y.saturating_add(area.size.height as i32);
                    let horizontal_distance = if window_center_x < area.position.x {
                        area.position.x - window_center_x
                    } else if window_center_x > area_right {
                        window_center_x - area_right
                    } else {
                        0
                    };
                    let vertical_distance = if window_center_y < area.position.y {
                        area.position.y - window_center_y
                    } else if window_center_y > area_bottom {
                        window_center_y - area_bottom
                    } else {
                        0
                    };
                    horizontal_distance.saturating_add(vertical_distance)
                })
        })
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or_else(|| "no monitor is available".to_string())?;
    let area = monitor.work_area();
    let (area_position, area_size, scale_factor) =
        (area.position, area.size, monitor.scale_factor());
    let area_right = area_position.x + area_size.width as i32;
    let area_bottom = area_position.y + area_size.height as i32;
    // Use the window bounds for the snap test instead of the cursor alone.
    // A window that has passed an edge must remain in its snap zone; otherwise
    // dragging a little farther than the threshold would cancel the dock.
    // For corners, use the larger overshoot as a deterministic tie-breaker.
    let window_right = position.x.saturating_add(size.width as i32);
    let window_bottom = position.y.saturating_add(size.height as i32);
    let edge_distances = [
        (
            position.x.saturating_sub(area_position.x).max(0),
            area_position.x.saturating_sub(position.x).max(0),
        ),
        (
            area_right.saturating_sub(window_right).max(0),
            window_right.saturating_sub(area_right).max(0),
        ),
        (
            position.y.saturating_sub(area_position.y).max(0),
            area_position.y.saturating_sub(position.y).max(0),
        ),
        (
            area_bottom.saturating_sub(window_bottom).max(0),
            window_bottom.saturating_sub(area_bottom).max(0),
        ),
    ];
    let threshold =
        (snap_threshold.unwrap_or(20).clamp(0, 40) as f64 * scale_factor).round() as i32;
    let Some((edge, (distance, _))) = edge_distances
        .iter()
        .enumerate()
        .min_by_key(|(_, (distance, overshoot))| (*distance, std::cmp::Reverse(*overshoot)))
    else {
        return Ok(false);
    };
    if *distance > threshold {
        if let Some(state) = app.try_state::<WindowPositionState>() {
            if let Ok(mut dock_state) = state.0.dock_state.lock() {
                *dock_state = None;
            }
            persist_current_window_position(&app, true);
        }
        return Ok(false);
    }
    let dock_edge = match edge {
        0 => DockEdge::Left,
        1 => DockEdge::Right,
        2 => DockEdge::Top,
        _ => DockEdge::Bottom,
    };
    // Custom models can occupy only the center of a transparent canvas, so
    // keep a little over half of a side dock visible. This still reads as a
    // peek while ensuring there is always a usable part of the model onscreen.
    let side_peek = (size.width as f64 * SIDE_DOCK_VISIBLE_RATIO).round() as i32;
    let peek = (14.0 * scale_factor).round() as i32;
    let docked = match edge {
        0 => PhysicalPosition::new(
            area_position.x - size.width as i32 + side_peek,
            position
                .y
                .clamp(area_position.y, area_bottom - size.height as i32),
        ),
        1 => PhysicalPosition::new(
            area_right - side_peek,
            position
                .y
                .clamp(area_position.y, area_bottom - size.height as i32),
        ),
        2 => PhysicalPosition::new(
            position
                .x
                .clamp(area_position.x, area_right - size.width as i32),
            area_position.y - size.height as i32 / 2 + peek,
        ),
        _ => PhysicalPosition::new(
            position
                .x
                .clamp(area_position.x, area_right - size.width as i32),
            area_bottom - size.height as i32 / 2 - peek,
        ),
    };
    if docked.x == position.x && docked.y == position.y {
        return Ok(false);
    }
    let Some(state) = app.try_state::<WindowPositionState>() else {
        return Err("window position persistence is unavailable".to_string());
    };
    *state
        .0
        .dock_state
        .lock()
        .map_err(|error| error.to_string())? = Some(DockState::Docked(dock_edge));
    if let Err(error) = window.set_position(docked) {
        if let Ok(mut dock_state) = state.0.dock_state.lock() {
            *dock_state = None;
        }
        return Err(error.to_string());
    }
    persist_current_window_position(&app, true);
    Ok(true)
}

#[tauri::command]
pub(crate) fn reveal_main_window<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<bool, String> {
    let Some(state) = app.try_state::<WindowPositionState>() else {
        return Ok(false);
    };
    let dock_state = state
        .0
        .dock_state
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    let Some(DockState::Docked(dock_edge)) = dock_state else {
        return Ok(false);
    };
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    let (area_position, area_size, _) = monitor_work_area(&window)?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let area_right = area_position.x + area_size.width as i32;
    let area_bottom = area_position.y + area_size.height as i32;
    let revealed = match dock_edge {
        DockEdge::Left => PhysicalPosition::new(
            area_position.x,
            position
                .y
                .clamp(area_position.y, area_bottom - size.height as i32),
        ),
        DockEdge::Right => PhysicalPosition::new(
            area_right - size.width as i32,
            position
                .y
                .clamp(area_position.y, area_bottom - size.height as i32),
        ),
        DockEdge::Top => PhysicalPosition::new(
            position
                .x
                .clamp(area_position.x, area_right - size.width as i32),
            area_position.y,
        ),
        DockEdge::Bottom => PhysicalPosition::new(
            position
                .x
                .clamp(area_position.x, area_right - size.width as i32),
            area_bottom - size.height as i32,
        ),
    };
    *state
        .0
        .dock_state
        .lock()
        .map_err(|error| error.to_string())? = Some(DockState::Revealed(dock_edge));
    if let Err(error) = window.set_position(revealed) {
        if let Ok(mut saved_state) = state.0.dock_state.lock() {
            *saved_state = Some(DockState::Docked(dock_edge));
        }
        return Err(error.to_string());
    }
    persist_current_window_position(&app, true);
    Ok(true)
}

#[tauri::command]
pub(crate) fn redock_main_window<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<bool, String> {
    let Some(state) = app.try_state::<WindowPositionState>() else {
        return Ok(false);
    };
    let dock_state = state
        .0
        .dock_state
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    let Some(DockState::Revealed(dock_edge)) = dock_state else {
        return Ok(false);
    };
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    let (area_position, area_size, scale_factor) = monitor_work_area(&window)?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let area_right = area_position.x + area_size.width as i32;
    let area_bottom = area_position.y + area_size.height as i32;
    let side_peek = (size.width as f64 * SIDE_DOCK_VISIBLE_RATIO).round() as i32;
    let peek = (14.0 * scale_factor).round() as i32;
    let docked = match dock_edge {
        DockEdge::Left => {
            PhysicalPosition::new(area_position.x - size.width as i32 + side_peek, position.y)
        }
        DockEdge::Right => PhysicalPosition::new(area_right - side_peek, position.y),
        DockEdge::Top => {
            PhysicalPosition::new(position.x, area_position.y - size.height as i32 / 2 + peek)
        }
        DockEdge::Bottom => {
            PhysicalPosition::new(position.x, area_bottom - size.height as i32 / 2 - peek)
        }
    };
    window
        .set_position(docked)
        .map_err(|error| error.to_string())?;
    *state
        .0
        .dock_state
        .lock()
        .map_err(|error| error.to_string())? = Some(DockState::Docked(dock_edge));
    persist_current_window_position(&app, true);
    Ok(true)
}
