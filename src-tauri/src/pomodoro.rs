//! The focus timer: a small state machine (idle → running → paused) and the transitions the
//! dashboard can request.
//!
//! Elapsed time and the completed-focus count belong to the scheduler, so a dashboard edit can
//! never silently rewrite a session that is already ticking.

use crate::scheduler;
use crate::storage;
use crate::time::now_epoch;
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

const POMODORO_FILE: &str = "pomodoro.json";

#[derive(Default)]
pub(crate) struct PomodoroManagerState {
    pub(crate) session: Mutex<PomodoroState>,
    pub(crate) data_path: Mutex<Option<PathBuf>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PomodoroState {
    #[serde(default)]
    pub(crate) title: String,
    pub(crate) phase: String,
    pub(crate) status: String,
    pub(crate) focus_minutes: u32,
    pub(crate) short_break_minutes: u32,
    pub(crate) long_break_minutes: u32,
    pub(crate) long_break_every: u32,
    #[serde(default)]
    pub(crate) session_duration_seconds: u32,
    pub(crate) remaining_seconds: u32,
    pub(crate) ends_at: Option<i64>,
    pub(crate) completed_focus_today: u32,
    pub(crate) completed_focus_date: String,
}

impl Default for PomodoroState {
    fn default() -> Self {
        Self {
            title: String::new(),
            phase: "focus".into(),
            status: "idle".into(),
            focus_minutes: 25,
            short_break_minutes: 5,
            long_break_minutes: 15,
            long_break_every: 4,
            session_duration_seconds: 25 * 60,
            remaining_seconds: 25 * 60,
            ends_at: None,
            completed_focus_today: 0,
            completed_focus_date: Local::now().format("%F").to_string(),
        }
    }
}

fn pomodoro_phase_duration(pomodoro: &PomodoroState) -> u32 {
    (match pomodoro.phase.as_str() {
        "shortBreak" => pomodoro.short_break_minutes.clamp(1, 60),
        "longBreak" => pomodoro.long_break_minutes.clamp(1, 120),
        _ => pomodoro.focus_minutes.clamp(1, 120),
    }) * 60
}

pub(crate) fn normalize_pomodoro(mut pomodoro: PomodoroState) -> PomodoroState {
    if !matches!(
        pomodoro.phase.as_str(),
        "focus" | "shortBreak" | "longBreak"
    ) {
        pomodoro.phase = "focus".into();
    }
    if !matches!(pomodoro.status.as_str(), "idle" | "running" | "paused") {
        pomodoro.status = "idle".into();
    }
    pomodoro.focus_minutes = pomodoro.focus_minutes.clamp(1, 120);
    pomodoro.short_break_minutes = pomodoro.short_break_minutes.clamp(1, 60);
    pomodoro.long_break_minutes = pomodoro.long_break_minutes.clamp(1, 120);
    pomodoro.long_break_every = pomodoro.long_break_every.clamp(2, 12);
    pomodoro.title = pomodoro.title.trim().chars().take(80).collect();
    let today = Local::now().format("%F").to_string();
    if pomodoro.completed_focus_date != today {
        pomodoro.completed_focus_date = today;
        pomodoro.completed_focus_today = 0;
    }
    if pomodoro.status == "running" && pomodoro.ends_at.is_none() {
        pomodoro.status = "paused".into();
    }
    if pomodoro.status != "running" {
        pomodoro.ends_at = None;
    }
    if pomodoro.session_duration_seconds == 0 {
        pomodoro.session_duration_seconds = pomodoro_phase_duration(&pomodoro);
    }
    pomodoro.session_duration_seconds = pomodoro.session_duration_seconds.clamp(60, 120 * 60);
    if pomodoro.remaining_seconds == 0 && pomodoro.status != "running" {
        pomodoro.remaining_seconds = pomodoro.session_duration_seconds;
    }
    pomodoro
}

pub(crate) fn advance_pomodoro(pomodoro: &mut PomodoroState, completed: bool) {
    if pomodoro.phase == "focus" {
        if completed {
            pomodoro.completed_focus_today = pomodoro.completed_focus_today.saturating_add(1);
        }
        pomodoro.phase = if completed
            && pomodoro
                .completed_focus_today
                .is_multiple_of(pomodoro.long_break_every)
        {
            "longBreak".into()
        } else {
            "shortBreak".into()
        };
    } else {
        pomodoro.phase = "focus".into();
    }
    pomodoro.status = "idle".into();
    pomodoro.ends_at = None;
    pomodoro.title.clear();
    pomodoro.session_duration_seconds = pomodoro_phase_duration(pomodoro);
    pomodoro.remaining_seconds = pomodoro.session_duration_seconds;
}

/// Restores the last session, so restarting mid-focus resumes with the same phase and counts.
pub(crate) fn init<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let state = PomodoroManagerState::default();
    if let Ok(path) = storage::app_data_file(app, POMODORO_FILE) {
        if let Some(saved) = storage::read_json::<PomodoroState>(&path) {
            if let Ok(mut session) = state.session.lock() {
                *session = normalize_pomodoro(saved);
            }
        }
        if let Ok(mut slot) = state.data_path.lock() {
            *slot = Some(path);
        }
    }
    app.manage(state);
}

pub(crate) fn save_pomodoro_state(state: &PomodoroManagerState) -> Result<(), String> {
    let path = state
        .data_path
        .lock()
        .map_err(|error| error.to_string())?
        .clone()
        .ok_or_else(|| "pomodoro storage is unavailable".to_string())?;
    let session = state.session.lock().map_err(|error| error.to_string())?;
    storage::write_json(&path, &*session)
}

fn read_pomodoro<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PomodoroState, String> {
    let state = app.state::<PomodoroManagerState>();
    let mut session = state.session.lock().map_err(|error| error.to_string())?;
    *session = normalize_pomodoro(session.clone());
    Ok(session.clone())
}

#[tauri::command]
pub(crate) fn get_pomodoro<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<PomodoroState, String> {
    read_pomodoro(&app)
}

#[tauri::command]
pub(crate) fn start_pomodoro<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<PomodoroState, String> {
    let state = app.state::<PomodoroManagerState>();
    let next = {
        let mut pomodoro = state.session.lock().map_err(|error| error.to_string())?;
        *pomodoro = normalize_pomodoro(pomodoro.clone());
        if pomodoro.status != "running" {
            if pomodoro.status == "idle" {
                pomodoro.remaining_seconds = pomodoro.session_duration_seconds;
            }
            pomodoro.remaining_seconds = pomodoro.remaining_seconds.max(1);
            pomodoro.ends_at = Some(now_epoch() + i64::from(pomodoro.remaining_seconds));
            pomodoro.status = "running".into();
        }
        pomodoro.clone()
    };
    save_pomodoro_state(&state)?;
    scheduler::start(&app);
    let _ = app.emit("pomodoro-state", next.clone());
    Ok(next)
}

#[tauri::command]
pub(crate) fn pause_pomodoro<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<PomodoroState, String> {
    let state = app.state::<PomodoroManagerState>();
    let next = {
        let mut pomodoro = state.session.lock().map_err(|error| error.to_string())?;
        *pomodoro = normalize_pomodoro(pomodoro.clone());
        if pomodoro.status == "running" {
            pomodoro.remaining_seconds =
                (pomodoro.ends_at.unwrap_or(now_epoch()) - now_epoch()).max(1) as u32;
            pomodoro.ends_at = None;
            pomodoro.status = "paused".into();
        }
        pomodoro.clone()
    };
    save_pomodoro_state(&state)?;
    let _ = app.emit("pomodoro-state", next.clone());
    Ok(next)
}

#[tauri::command]
pub(crate) fn reset_pomodoro<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<PomodoroState, String> {
    let state = app.state::<PomodoroManagerState>();
    let next = {
        let mut pomodoro = state.session.lock().map_err(|error| error.to_string())?;
        *pomodoro = normalize_pomodoro(pomodoro.clone());
        pomodoro.status = "idle".into();
        pomodoro.ends_at = None;
        pomodoro.remaining_seconds = pomodoro.session_duration_seconds;
        pomodoro.clone()
    };
    save_pomodoro_state(&state)?;
    let _ = app.emit("pomodoro-state", next.clone());
    Ok(next)
}

#[tauri::command]
pub(crate) fn skip_pomodoro<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<PomodoroState, String> {
    let state = app.state::<PomodoroManagerState>();
    let next = {
        let mut pomodoro = state.session.lock().map_err(|error| error.to_string())?;
        *pomodoro = normalize_pomodoro(pomodoro.clone());
        advance_pomodoro(&mut pomodoro, false);
        pomodoro.clone()
    };
    save_pomodoro_state(&state)?;
    let _ = app.emit("pomodoro-state", next.clone());
    Ok(next)
}

#[tauri::command]
pub(crate) fn save_pomodoro<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    pomodoro: PomodoroState,
) -> Result<PomodoroState, String> {
    let state = app.state::<PomodoroManagerState>();
    let next = {
        let mut current = state.session.lock().map_err(|error| error.to_string())?;
        let mut next = normalize_pomodoro(pomodoro);
        // The scheduler owns elapsed time and completion counts. A new session may be prepared
        // only while idle, so an active timer cannot be silently rewritten from the dashboard.
        next.status = current.status.clone();
        next.ends_at = current.ends_at;
        next.completed_focus_today = current.completed_focus_today;
        next.completed_focus_date = current.completed_focus_date.clone();
        if next.status == "running" || next.status == "paused" {
            next.phase = current.phase.clone();
            next.title = current.title.clone();
            next.session_duration_seconds = current.session_duration_seconds;
            next.remaining_seconds = current.remaining_seconds;
        } else {
            next.remaining_seconds = next.session_duration_seconds;
        }
        *current = next.clone();
        next
    };
    save_pomodoro_state(&state)?;
    let _ = app.emit("pomodoro-state", next.clone());
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completed_focus_advances_to_the_configured_long_break() {
        let mut pomodoro = PomodoroState {
            long_break_every: 2,
            completed_focus_today: 1,
            ..PomodoroState::default()
        };
        advance_pomodoro(&mut pomodoro, true);
        assert_eq!(pomodoro.completed_focus_today, 2);
        assert_eq!(pomodoro.phase, "longBreak");
        assert_eq!(pomodoro.status, "idle");
        assert!(pomodoro.title.is_empty());
        assert_eq!(
            pomodoro.session_duration_seconds,
            pomodoro.long_break_minutes * 60
        );
        assert_eq!(pomodoro.remaining_seconds, pomodoro.long_break_minutes * 60);
    }

    #[test]
    fn invalid_saved_pomodoro_state_is_normalized() {
        let pomodoro = normalize_pomodoro(PomodoroState {
            title: "  A focused task  ".into(),
            phase: "invalid".into(),
            status: "unknown".into(),
            focus_minutes: 0,
            short_break_minutes: 99,
            long_break_minutes: 0,
            long_break_every: 1,
            session_duration_seconds: 0,
            remaining_seconds: 0,
            ends_at: Some(1),
            completed_focus_today: 0,
            completed_focus_date: String::new(),
        });
        assert_eq!(pomodoro.phase, "focus");
        assert_eq!(pomodoro.status, "idle");
        assert_eq!(pomodoro.focus_minutes, 1);
        assert_eq!(pomodoro.short_break_minutes, 60);
        assert_eq!(pomodoro.long_break_every, 2);
        assert_eq!(pomodoro.title, "A focused task");
        assert_eq!(pomodoro.session_duration_seconds, 60);
        assert_eq!(pomodoro.remaining_seconds, 60);
        assert_eq!(pomodoro.ends_at, None);
    }
}
