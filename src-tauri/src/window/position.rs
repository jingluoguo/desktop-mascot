//! Remembering where the mascot was left, including whether it was attached to an edge.

use super::{DockEdge, DockState};
use crate::storage;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration as StdDuration, Instant};
use tauri::{Manager, PhysicalPosition, WindowEvent};

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct SavedWindowPosition {
    pub(crate) x: i32,
    pub(crate) y: i32,
    #[serde(default)]
    pub(crate) docked_edge: Option<DockEdge>,
}

/// Shared with the dock and the window commands, which read the attach state directly.
pub(crate) struct WindowPositionPersistence {
    pub(crate) path: PathBuf,
    pub(crate) latest: Mutex<Option<SavedWindowPosition>>,
    pub(crate) last_saved: Mutex<Option<Instant>>,
    pub(crate) dock_state: Mutex<Option<DockState>>,
}

pub(crate) struct WindowPositionState(pub(crate) Arc<WindowPositionPersistence>);

fn read_saved_window_position(path: &Path) -> Option<SavedWindowPosition> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn write_saved_window_position(path: &Path, position: &SavedWindowPosition) {
    if let Ok(contents) = serde_json::to_string(position) {
        let _ = storage::write_atomic(path, contents.as_bytes());
    }
}

fn persist_window_position(
    state: &WindowPositionPersistence,
    mut position: SavedWindowPosition,
    force: bool,
) {
    if let Ok(dock_state) = state.dock_state.lock() {
        position.docked_edge = match &*dock_state {
            Some(DockState::Docked(edge)) | Some(DockState::Revealed(edge)) => Some(*edge),
            _ => None,
        };
    }
    if let Ok(mut latest) = state.latest.lock() {
        *latest = Some(position.clone());
    }
    let should_write = force
        || state
            .last_saved
            .lock()
            .map(|last| last.is_none_or(|time| time.elapsed() >= StdDuration::from_millis(250)))
            .unwrap_or(false);
    if should_write {
        write_saved_window_position(&state.path, &position);
        if let Ok(mut last) = state.last_saved.lock() {
            *last = Some(Instant::now());
        }
    }
}

pub(crate) fn persist_current_window_position<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    force: bool,
) {
    let Some(state) = app.try_state::<WindowPositionState>() else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Ok(position) = window.outer_position() {
        persist_window_position(
            &state.0,
            SavedWindowPosition {
                x: position.x,
                y: position.y,
                docked_edge: None,
            },
            force,
        );
    } else if force {
        if let Ok(latest) = state.0.latest.lock() {
            if let Some(position) = latest.clone() {
                write_saved_window_position(&state.0.path, &position);
            }
        }
    }
}

fn restore_window_position<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    path: &Path,
) -> bool {
    let Some(saved) = read_saved_window_position(path) else {
        return false;
    };
    let Ok(size) = window.outer_size() else {
        return false;
    };
    let Ok(monitors) = window.available_monitors() else {
        return false;
    };
    let visible = monitors.iter().any(|monitor| {
        let area = monitor.work_area();
        let right = saved.x + size.width as i32;
        let bottom = saved.y + size.height as i32;
        saved.x < area.position.x + area.size.width as i32
            && right > area.position.x
            && saved.y < area.position.y + area.size.height as i32
            && bottom > area.position.y
    });
    visible
        && window
            .set_position(PhysicalPosition::new(saved.x, saved.y))
            .is_ok()
}

const POSITION_FILE: &str = "window-position.json";

/// Restores the window to where it was left. With no persistence layer — or nothing saved yet —
/// the mascot falls back to its default corner.
pub(crate) fn init<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let persistence = storage::app_data_file(app, POSITION_FILE).ok().map(|path| {
        let dock_state = read_saved_window_position(&path).and_then(|saved| saved.docked_edge);
        Arc::new(WindowPositionPersistence {
            path,
            latest: Mutex::new(None),
            last_saved: Mutex::new(None),
            dock_state: Mutex::new(dock_state.map(DockState::Docked)),
        })
    });
    let Some(persistence) = persistence else {
        let _ = super::position_main_window(app.clone());
        return;
    };
    app.manage(WindowPositionState(Arc::clone(&persistence)));
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if !restore_window_position(&window, &persistence.path) {
        let _ = super::position_main_window(app.clone());
    }
    window.on_window_event(move |event| {
        if let WindowEvent::Moved(position) = event {
            persist_window_position(
                &persistence,
                SavedWindowPosition {
                    x: position.x,
                    y: position.y,
                    docked_edge: None,
                },
                false,
            );
        }
        if matches!(event, WindowEvent::Destroyed) {
            if let Ok(latest) = persistence.latest.lock() {
                if let Some(position) = latest.clone() {
                    write_saved_window_position(&persistence.path, &position);
                }
            }
        }
    });
}
