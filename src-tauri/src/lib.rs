use chrono::{DateTime, Datelike, Duration, Local, TimeZone, Timelike, Weekday};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration as StdDuration, Instant, SystemTime, UNIX_EPOCH};
use tauri::WindowEvent;
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize};
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_updater::UpdaterExt;

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

#[derive(Clone, Serialize)]
struct UpdateStatus {
    state: String,
    version: Option<String>,
    progress: Option<f64>,
    message: Option<String>,
}

impl UpdateStatus {
    fn idle() -> Self {
        Self {
            state: "idle".into(),
            version: None,
            progress: None,
            message: None,
        }
    }
}

struct DownloadedUpdate {
    version: String,
    bytes: Vec<u8>,
}

struct UpdateSession {
    update: Option<tauri_plugin_updater::Update>,
    downloaded: Option<DownloadedUpdate>,
    download_task: Option<tauri::async_runtime::JoinHandle<()>>,
    generation: u64,
    status: UpdateStatus,
}

impl Default for UpdateSession {
    fn default() -> Self {
        Self {
            update: None,
            downloaded: None,
            download_task: None,
            generation: 0,
            status: UpdateStatus::idle(),
        }
    }
}

#[derive(Default)]
struct UpdateManagerState {
    session: Mutex<UpdateSession>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reminder {
    id: String,
    title: String,
    enabled: bool,
    schedule: String,
    run_at: String,
    interval_minutes: Option<u32>,
    emotion: String,
    system_notification: bool,
    next_run_at: Option<i64>,
    last_fired_at: Option<i64>,
}

#[derive(Default)]
struct ReminderManagerState {
    reminders: Mutex<Vec<Reminder>>,
    pomodoro: Mutex<PomodoroState>,
    timer: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    data_path: Mutex<Option<PathBuf>>,
    pomodoro_data_path: Mutex<Option<PathBuf>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PomodoroState {
    #[serde(default)]
    title: String,
    phase: String,
    status: String,
    focus_minutes: u32,
    short_break_minutes: u32,
    long_break_minutes: u32,
    long_break_every: u32,
    #[serde(default)]
    session_duration_seconds: u32,
    remaining_seconds: u32,
    ends_at: Option<i64>,
    completed_focus_today: u32,
    completed_focus_date: String,
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

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum DockEdge {
    Left,
    Right,
    Top,
    Bottom,
}

#[derive(Clone)]
enum DockState {
    Docked(DockEdge),
    Revealed(DockEdge),
}

const SIDE_DOCK_VISIBLE_RATIO: f64 = 0.55;

#[derive(Clone, Serialize, Deserialize)]
struct SavedWindowPosition {
    x: i32,
    y: i32,
    #[serde(default)]
    docked_edge: Option<DockEdge>,
}

struct WindowPositionPersistence {
    path: PathBuf,
    latest: Mutex<Option<SavedWindowPosition>>,
    last_saved: Mutex<Option<Instant>>,
    dock_state: Mutex<Option<DockState>>,
}

struct WindowPositionState(Arc<WindowPositionPersistence>);

fn window_position_file<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("window-position.json"))
}

fn read_saved_window_position(path: &Path) -> Option<SavedWindowPosition> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn write_saved_window_position(path: &Path, position: &SavedWindowPosition) {
    if let Ok(contents) = serde_json::to_string(position) {
        let _ = fs::write(path, contents);
    }
}

fn persist_window_position(
    state: &WindowPositionPersistence,
    mut position: SavedWindowPosition,
    force: bool,
) {
    if let Ok(dock_state) = state.dock_state.lock() {
        position.docked_edge = match &*dock_state {
            Some(DockState::Docked(edge)) | Some(DockState::Revealed(edge)) => Some(edge.clone()),
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
            .map(|last| last.map_or(true, |time| time.elapsed() >= StdDuration::from_millis(250)))
            .unwrap_or(false);
    if should_write {
        write_saved_window_position(&state.path, &position);
        if let Ok(mut last) = state.last_saved.lock() {
            *last = Some(Instant::now());
        }
    }
}

fn persist_current_window_position<R: tauri::Runtime>(app: &tauri::AppHandle<R>, force: bool) {
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

fn now_epoch() -> i64 {
    Local::now().timestamp()
}

fn parse_run_at(value: &str) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.with_timezone(&Local))
}

fn next_recurring_run(reminder: &Reminder, now: DateTime<Local>) -> Option<i64> {
    let base = parse_run_at(&reminder.run_at)?;
    match reminder.schedule.as_str() {
        "daily" => {
            let mut candidate = Local
                .with_ymd_and_hms(
                    now.year(),
                    now.month(),
                    now.day(),
                    base.hour(),
                    base.minute(),
                    base.second(),
                )
                .single()?;
            if candidate <= now {
                candidate += Duration::days(1);
            }
            Some(candidate.timestamp())
        }
        "weekdays" => {
            for offset in 0..8 {
                let date = now.date_naive() + Duration::days(offset);
                let weekday = date.weekday();
                if matches!(weekday, Weekday::Sat | Weekday::Sun) {
                    continue;
                }
                let candidate = Local
                    .with_ymd_and_hms(
                        date.year(),
                        date.month(),
                        date.day(),
                        base.hour(),
                        base.minute(),
                        base.second(),
                    )
                    .single()?;
                if candidate > now {
                    return Some(candidate.timestamp());
                }
            }
            None
        }
        "interval" => {
            let minutes = i64::from(reminder.interval_minutes.unwrap_or(60).max(1));
            let first = base.timestamp();
            if first > now.timestamp() {
                Some(first)
            } else {
                let elapsed = now.timestamp() - first;
                Some(first + ((elapsed / (minutes * 60)) + 1) * minutes * 60)
            }
        }
        _ => None,
    }
}

fn normalize_reminder(mut reminder: Reminder) -> Reminder {
    if !reminder.enabled {
        reminder.next_run_at = None;
        return reminder;
    }
    let now = Local::now();
    if reminder.schedule == "once" {
        reminder.next_run_at = parse_run_at(&reminder.run_at)
            .map(|date| date.timestamp())
            .filter(|timestamp| *timestamp > now.timestamp());
        if reminder.next_run_at.is_none() {
            reminder.enabled = false;
        }
    } else {
        reminder.next_run_at = next_recurring_run(&reminder, now);
    }
    reminder
}

fn reminders_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("reminders.json"))
}

fn pomodoro_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("pomodoro.json"))
}

fn pomodoro_phase_duration(pomodoro: &PomodoroState) -> u32 {
    (match pomodoro.phase.as_str() {
        "shortBreak" => pomodoro.short_break_minutes.clamp(1, 60),
        "longBreak" => pomodoro.long_break_minutes.clamp(1, 120),
        _ => pomodoro.focus_minutes.clamp(1, 120),
    }) * 60
}

fn normalize_pomodoro(mut pomodoro: PomodoroState) -> PomodoroState {
    if !matches!(pomodoro.phase.as_str(), "focus" | "shortBreak" | "longBreak") {
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

fn save_reminders(state: &ReminderManagerState) -> Result<(), String> {
    let path = state
        .data_path
        .lock()
        .map_err(|error| error.to_string())?
        .clone()
        .ok_or_else(|| "reminder storage is unavailable".to_string())?;
    let reminders = state.reminders.lock().map_err(|error| error.to_string())?;
    let contents = serde_json::to_string_pretty(&*reminders).map_err(|error| error.to_string())?;
    fs::write(path, contents).map_err(|error| error.to_string())
}

fn save_pomodoro_state(state: &ReminderManagerState) -> Result<(), String> {
    let path = state
        .pomodoro_data_path
        .lock()
        .map_err(|error| error.to_string())?
        .clone()
        .ok_or_else(|| "pomodoro storage is unavailable".to_string())?;
    let pomodoro = state.pomodoro.lock().map_err(|error| error.to_string())?;
    fs::write(path, serde_json::to_string_pretty(&*pomodoro).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}

fn read_pomodoro<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PomodoroState, String> {
    let state = app.state::<ReminderManagerState>();
    let mut pomodoro = state.pomodoro.lock().map_err(|error| error.to_string())?;
    *pomodoro = normalize_pomodoro(pomodoro.clone());
    Ok(pomodoro.clone())
}

fn advance_pomodoro(pomodoro: &mut PomodoroState, completed: bool) {
    if pomodoro.phase == "focus" {
        if completed {
            pomodoro.completed_focus_today = pomodoro.completed_focus_today.saturating_add(1);
        }
        pomodoro.phase = if completed && pomodoro.completed_focus_today % pomodoro.long_break_every == 0 {
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

fn start_reminder_scheduler<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let state = app.state::<ReminderManagerState>();
    let has_enabled = state
        .reminders
        .lock()
        .map(|items| {
            items
                .iter()
                .any(|item| item.enabled && item.next_run_at.is_some())
        })
        .unwrap_or(false)
        || state
            .pomodoro
            .lock()
            .map(|pomodoro| pomodoro.status == "running" && pomodoro.ends_at.is_some())
            .unwrap_or(false);
    if !has_enabled {
        return;
    }
    let mut timer = match state.timer.lock() {
        Ok(timer) => timer,
        Err(_) => return,
    };
    if timer.is_some() {
        return;
    }
    let task_app = app.clone();
    *timer = Some(tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            let state = task_app.state::<ReminderManagerState>();
            let now = now_epoch();
            let mut fired = Vec::new();
            let mut should_continue = false;
            if let Ok(mut reminders) = state.reminders.lock() {
                for reminder in reminders.iter_mut() {
                    if !reminder.enabled || reminder.next_run_at.is_none() {
                        continue;
                    }
                    should_continue = true;
                    if reminder.next_run_at.is_some_and(|next| next <= now) {
                        reminder.last_fired_at = Some(now);
                        fired.push(reminder.clone());
                        if reminder.schedule == "once" {
                            reminder.enabled = false;
                            reminder.next_run_at = None;
                        } else if reminder.schedule == "interval" {
                            reminder.next_run_at = Some(
                                now + i64::from(reminder.interval_minutes.unwrap_or(60).max(1))
                                    * 60,
                            );
                        } else {
                            reminder.next_run_at = next_recurring_run(reminder, Local::now());
                        }
                    }
                }
            }
            let mut pomodoro_completed = None;
            if let Ok(mut pomodoro) = state.pomodoro.lock() {
                *pomodoro = normalize_pomodoro(pomodoro.clone());
                if pomodoro.status == "running" && pomodoro.ends_at.is_some_and(|end| end <= now) {
                    advance_pomodoro(&mut pomodoro, true);
                    pomodoro_completed = Some(pomodoro.clone());
                }
                if pomodoro.status == "running" && pomodoro.ends_at.is_some() {
                    should_continue = true;
                }
            }
            if !fired.is_empty() {
                let _ = save_reminders(&state);
                for reminder in fired {
                    let _ = task_app.emit("reminder-fired", reminder);
                }
            }
            if let Some(pomodoro) = pomodoro_completed {
                let _ = save_pomodoro_state(&state);
                let _ = task_app.emit("pomodoro-state", pomodoro.clone());
                let _ = task_app.emit("pomodoro-completed", pomodoro);
            }
            if !should_continue {
                if let Ok(mut slot) = state.timer.lock() {
                    *slot = None;
                }
                break;
            }
        }
    }));
}

#[tauri::command]
fn list_reminders<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<Vec<Reminder>, String> {
    Ok(app
        .state::<ReminderManagerState>()
        .reminders
        .lock()
        .map_err(|error| error.to_string())?
        .clone())
}

#[tauri::command]
fn save_reminder<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    reminder: Reminder,
) -> Result<Vec<Reminder>, String> {
    let state = app.state::<ReminderManagerState>();
    let normalized = normalize_reminder(reminder);
    let mut reminders = state.reminders.lock().map_err(|error| error.to_string())?;
    if let Some(existing) = reminders.iter_mut().find(|item| item.id == normalized.id) {
        *existing = normalized;
    } else {
        reminders.push(normalized);
    }
    drop(reminders);
    save_reminders(&state)?;
    start_reminder_scheduler(&app);
    list_reminders(app)
}

#[tauri::command]
fn delete_reminder<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    id: String,
) -> Result<Vec<Reminder>, String> {
    let state = app.state::<ReminderManagerState>();
    let mut reminders = state.reminders.lock().map_err(|error| error.to_string())?;
    reminders.retain(|item| item.id != id);
    drop(reminders);
    save_reminders(&state)?;
    list_reminders(app)
}

#[tauri::command]
fn get_pomodoro<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<PomodoroState, String> {
    read_pomodoro(&app)
}

#[tauri::command]
fn start_pomodoro<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<PomodoroState, String> {
    let state = app.state::<ReminderManagerState>();
    let next = {
        let mut pomodoro = state.pomodoro.lock().map_err(|error| error.to_string())?;
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
    start_reminder_scheduler(&app);
    let _ = app.emit("pomodoro-state", next.clone());
    Ok(next)
}

#[tauri::command]
fn pause_pomodoro<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<PomodoroState, String> {
    let state = app.state::<ReminderManagerState>();
    let next = {
        let mut pomodoro = state.pomodoro.lock().map_err(|error| error.to_string())?;
        *pomodoro = normalize_pomodoro(pomodoro.clone());
        if pomodoro.status == "running" {
            pomodoro.remaining_seconds = (pomodoro.ends_at.unwrap_or(now_epoch()) - now_epoch()).max(1) as u32;
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
fn reset_pomodoro<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<PomodoroState, String> {
    let state = app.state::<ReminderManagerState>();
    let next = {
        let mut pomodoro = state.pomodoro.lock().map_err(|error| error.to_string())?;
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
fn skip_pomodoro<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<PomodoroState, String> {
    let state = app.state::<ReminderManagerState>();
    let next = {
        let mut pomodoro = state.pomodoro.lock().map_err(|error| error.to_string())?;
        *pomodoro = normalize_pomodoro(pomodoro.clone());
        advance_pomodoro(&mut pomodoro, false);
        pomodoro.clone()
    };
    save_pomodoro_state(&state)?;
    let _ = app.emit("pomodoro-state", next.clone());
    Ok(next)
}

#[tauri::command]
fn save_pomodoro<R: tauri::Runtime>(app: tauri::AppHandle<R>, pomodoro: PomodoroState) -> Result<PomodoroState, String> {
    let state = app.state::<ReminderManagerState>();
    let next = {
        let mut current = state.pomodoro.lock().map_err(|error| error.to_string())?;
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

fn emit_update_status<R: tauri::Runtime>(app: &tauri::AppHandle<R>, status: &UpdateStatus) {
    let _ = app.emit("update-status", status);
}

fn set_update_error<R: tauri::Runtime>(app: &tauri::AppHandle<R>, message: String) {
    let state = app.state::<UpdateManagerState>();
    let Ok(mut session) = state.session.lock() else {
        return;
    };
    session.status = UpdateStatus {
        state: "error".into(),
        version: session.update.as_ref().map(|update| update.version.clone()),
        progress: None,
        message: Some(message),
    };
    emit_update_status(app, &session.status);
}

#[tauri::command]
fn get_update_status<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<UpdateStatus, String> {
    let state = app.state::<UpdateManagerState>();
    let status = state
        .session
        .lock()
        .map_err(|error| error.to_string())?
        .status
        .clone();
    Ok(status)
}

#[tauri::command]
fn mark_up_to_date<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<UpdateStatus, String> {
    let state = app.state::<UpdateManagerState>();
    let mut session = state.session.lock().map_err(|error| error.to_string())?;
    if session.download_task.is_some() {
        return Ok(session.status.clone());
    }
    session.status = UpdateStatus {
        state: "up-to-date".into(),
        version: Some(app.package_info().version.to_string()),
        progress: None,
        message: None,
    };
    let status = session.status.clone();
    emit_update_status(&app, &status);
    Ok(status)
}

#[tauri::command]
async fn check_for_update<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<UpdateStatus, String> {
    {
        let state = app.state::<UpdateManagerState>();
        let mut session = state.session.lock().map_err(|error| error.to_string())?;
        if session.download_task.is_some() {
            return Ok(session.status.clone());
        }
        session.status = UpdateStatus {
            state: "checking".into(),
            version: None,
            progress: None,
            message: None,
        };
        emit_update_status(&app, &session.status);
    }

    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => {
            let message = error.to_string();
            set_update_error(&app, message.clone());
            return Err(message);
        }
    };
    let update = match updater.check().await {
        Ok(update) => update,
        Err(error) => {
            let message = error.to_string();
            set_update_error(&app, message.clone());
            return Err(message);
        }
    };
    let state = app.state::<UpdateManagerState>();
    let mut session = state.session.lock().map_err(|error| error.to_string())?;
    session.generation += 1;
    session.status = if let Some(update) = update {
        let version = update.version.clone();
        session.update = Some(update);
        if session
            .downloaded
            .as_ref()
            .is_some_and(|download| download.version == version)
        {
            UpdateStatus {
                state: "ready".into(),
                version: Some(version),
                progress: Some(100.0),
                message: None,
            }
        } else {
            session.downloaded = None;
            UpdateStatus {
                state: "available".into(),
                version: Some(version),
                progress: None,
                message: None,
            }
        }
    } else {
        session.update = None;
        session.downloaded = None;
        UpdateStatus {
            state: "up-to-date".into(),
            version: None,
            progress: None,
            message: None,
        }
    };
    let status = session.status.clone();
    emit_update_status(&app, &status);
    Ok(status)
}

#[tauri::command]
fn start_update_download<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<UpdateStatus, String> {
    let (update, version, generation) = {
        let state = app.state::<UpdateManagerState>();
        let mut session = state.session.lock().map_err(|error| error.to_string())?;
        if session.download_task.is_some() {
            return Ok(session.status.clone());
        }
        let update = session
            .update
            .clone()
            .ok_or_else(|| "没有可下载的更新".to_string())?;
        let version = update.version.clone();
        if session
            .downloaded
            .as_ref()
            .is_some_and(|download| download.version == version)
        {
            session.status = UpdateStatus {
                state: "ready".into(),
                version: Some(version),
                progress: Some(100.0),
                message: None,
            };
            return Ok(session.status.clone());
        }
        session.generation += 1;
        let generation = session.generation;
        session.status = UpdateStatus {
            state: "downloading".into(),
            version: Some(version.clone()),
            progress: Some(0.0),
            message: None,
        };
        (update, version, generation)
    };
    let state = app.state::<UpdateManagerState>();
    let initial_status = state
        .session
        .lock()
        .map_err(|error| error.to_string())?
        .status
        .clone();
    emit_update_status(&app, &initial_status);

    let task_app = app.clone();
    let task_version = version.clone();
    let task = tauri::async_runtime::spawn(async move {
        let mut downloaded = 0_u64;
        let result = update
            .download(
                |chunk_length, total| {
                    downloaded += chunk_length as u64;
                    let progress =
                        total.map(|total| (downloaded as f64 / total as f64 * 100.0).min(100.0));
                    let state = task_app.state::<UpdateManagerState>();
                    let Ok(session) = state.session.lock() else {
                        return;
                    };
                    if session.generation != generation {
                        return;
                    }
                    drop(session);
                    emit_update_status(
                        &task_app,
                        &UpdateStatus {
                            state: "downloading".into(),
                            version: Some(task_version.clone()),
                            progress,
                            message: None,
                        },
                    );
                },
                || {},
            )
            .await;
        let state = task_app.state::<UpdateManagerState>();
        let Ok(mut session) = state.session.lock() else {
            return;
        };
        if session.generation != generation {
            return;
        }
        session.download_task = None;
        session.status = match result {
            Ok(bytes) => {
                session.downloaded = Some(DownloadedUpdate {
                    version: task_version.clone(),
                    bytes,
                });
                UpdateStatus {
                    state: "ready".into(),
                    version: Some(task_version.clone()),
                    progress: Some(100.0),
                    message: None,
                }
            }
            Err(error) => UpdateStatus {
                state: "error".into(),
                version: Some(task_version.clone()),
                progress: None,
                message: Some(error.to_string()),
            },
        };
        emit_update_status(&task_app, &session.status);
    });
    let state = app.state::<UpdateManagerState>();
    let mut session = state.session.lock().map_err(|error| error.to_string())?;
    if session.generation == generation && session.status.state == "downloading" {
        session.download_task = Some(task);
    }
    Ok(session.status.clone())
}

#[tauri::command]
fn pause_update_download<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<UpdateStatus, String> {
    let state = app.state::<UpdateManagerState>();
    let mut session = state.session.lock().map_err(|error| error.to_string())?;
    let version = session.status.version.clone();
    if let Some(task) = session.download_task.take() {
        task.abort();
        session.generation += 1;
        session.status = UpdateStatus {
            state: "paused".into(),
            version,
            progress: session.status.progress,
            message: Some("下载已暂停，继续下载时会重新开始。".into()),
        };
    }
    let status = session.status.clone();
    emit_update_status(&app, &status);
    Ok(status)
}

#[tauri::command]
fn install_downloaded_update<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    let state = app.state::<UpdateManagerState>();
    let session = state.session.lock().map_err(|error| error.to_string())?;
    let update = session
        .update
        .clone()
        .ok_or_else(|| "没有可安装的更新".to_string())?;
    let download = session
        .downloaded
        .as_ref()
        .ok_or_else(|| "更新尚未下载完成".to_string())?;
    if update.version != download.version {
        return Err("下载的更新版本与当前版本不一致".into());
    }
    update
        .install(&download.bytes)
        .map_err(|error| error.to_string())
}

#[derive(Debug, Serialize)]
struct CustomModelSummary {
    id: String,
    name: String,
    version: String,
    author: String,
}

#[derive(Debug, Serialize)]
struct CustomModelSources {
    id: String,
    model_js: String,
    model_css: String,
    model_json: String,
}

#[derive(Debug, Deserialize)]
struct CustomModelUpload {
    id: String,
    model_js: String,
    model_css: String,
    model_json: String,
}

fn custom_models_dir<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<std::path::PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("models");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

#[tauri::command]
fn check_autostart<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_autostart<R: tauri::Runtime>(
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

fn request_autostart_once<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if cfg!(debug_assertions) {
        return;
    }
    let Ok(data_dir) = app.path().app_data_dir() else {
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

fn valid_model_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn is_builtin_model_id(id: &str) -> bool {
    matches!(id, "sprout" | "cat" | "robot" | "ghost" | "jelly")
}

fn validate_model_source(label: &str, source: &str) -> Result<(), String> {
    const FORBIDDEN: &[&str] = &[
        "fetch(",
        "xmlhttprequest",
        "websocket",
        "eventsource",
        "import(",
        "eval(",
        "new function(",
        "__tauri__",
        "__tauri_internal__",
        "invoke(",
        "window.open",
        "document.cookie",
        "navigator.",
        "localstorage",
        "sessionstorage",
    ];
    let normalized = source.to_ascii_lowercase();
    if normalized.contains("http://")
        || normalized.contains("https://")
        || normalized.contains("javascript:")
        || normalized.contains("data:text/html")
    {
        return Err(format!("{label} may not contain remote or executable URLs"));
    }
    if let Some(token) = FORBIDDEN.iter().find(|token| normalized.contains(**token)) {
        return Err(format!("{label} contains forbidden capability: {token}"));
    }
    Ok(())
}

fn validate_model_interactions(manifest: &serde_json::Value) -> Result<(), String> {
    let Some(interactions) = manifest.get("interactions") else {
        return Ok(());
    };
    let interactions = interactions
        .as_object()
        .ok_or_else(|| "model.json interactions must be an object".to_string())?;
    for (trigger, actions) in interactions {
        if !matches!(trigger.as_str(), "click" | "doubleClick" | "hover" | "drag") {
            return Err(format!("model.json has an unsupported interaction trigger: {trigger}"));
        }
        let actions = actions
            .as_array()
            .ok_or_else(|| format!("model.json interaction {trigger} must be an array"))?;
        if actions.iter().any(|action| {
            action
                .as_str()
                .map(|value| value.is_empty() || value.len() > 40)
                .unwrap_or(true)
        }) {
            return Err(format!("model.json interaction {trigger} contains an invalid emotion id"));
        }
    }
    Ok(())
}

fn model_summary_from_manifest(path: &Path) -> Result<CustomModelSummary, String> {
    let manifest = serde_json::from_str::<serde_json::Value>(
        &fs::read_to_string(path.join("model.json")).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("model.json is invalid: {error}"))?;
    let id = manifest
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let presentation = manifest.get("presentation");
    let name = manifest
        .get("name")
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            presentation
                .and_then(|value| value.get("labels"))
                .and_then(|value| value.get("en"))
                .and_then(serde_json::Value::as_str)
        })
        .or_else(|| {
            presentation
                .and_then(|value| value.get("labels"))
                .and_then(|value| value.get("zh"))
                .and_then(serde_json::Value::as_str)
        })
        .unwrap_or(&id)
        .trim()
        .to_string();
    let version = manifest
        .get("version")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let author = manifest
        .get("author")
        .and_then(|value| {
            value
                .as_str()
                .or_else(|| value.get("name").and_then(serde_json::Value::as_str))
        })
        .unwrap_or_default()
        .trim()
        .to_string();
    if !valid_model_id(&id)
        || name.is_empty()
        || name.len() > 160
        || version.len() > 40
        || author.len() > 160
    {
        return Err("model.json must contain a valid id and name".to_string());
    }
    Ok(CustomModelSummary {
        id,
        name,
        version,
        author,
    })
}

#[tauri::command]
fn list_custom_models<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Vec<CustomModelSummary>, String> {
    let directory = custom_models_dir(&app)?;
    let mut models = fs::read_dir(directory)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .filter_map(|entry| model_summary_from_manifest(&entry.path()).ok())
        .collect::<Vec<_>>();
    models.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(models)
}

#[tauri::command]
fn read_custom_model<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    id: String,
) -> Result<CustomModelSources, String> {
    if !valid_model_id(&id) {
        return Err("invalid model id".to_string());
    }
    let directory = custom_models_dir(&app)?.join(&id);
    let summary = model_summary_from_manifest(&directory)?;
    Ok(CustomModelSources {
        id: summary.id,
        model_js: fs::read_to_string(directory.join("model.js"))
            .map_err(|error| error.to_string())?,
        model_css: fs::read_to_string(directory.join("model.css"))
            .map_err(|error| error.to_string())?,
        model_json: fs::read_to_string(directory.join("model.json"))
            .map_err(|error| error.to_string())?,
    })
}

#[tauri::command]
fn delete_custom_model<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    id: String,
) -> Result<(), String> {
    if !valid_model_id(&id) {
        return Err("invalid model id".to_string());
    }
    if is_builtin_model_id(&id) {
        return Err("built-in models cannot be deleted".to_string());
    }
    let directory = custom_models_dir(&app)?.join(id);
    if !directory.exists() {
        return Err("custom model does not exist".to_string());
    }
    fs::remove_dir_all(directory).map_err(|error| error.to_string())
}

#[tauri::command]
fn install_custom_model<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    upload: CustomModelUpload,
) -> Result<CustomModelSummary, String> {
    const MAX_SOURCE_SIZE: usize = 2 * 1024 * 1024;
    if !valid_model_id(&upload.id) || upload.id.is_empty() {
        return Err(
            "model id must contain only letters, numbers, hyphens, or underscores".to_string(),
        );
    }
    if is_builtin_model_id(&upload.id) {
        return Err("built-in model ids cannot be replaced".to_string());
    }
    if [
        upload.model_js.len(),
        upload.model_css.len(),
        upload.model_json.len(),
    ]
    .iter()
    .any(|size| *size > MAX_SOURCE_SIZE)
    {
        return Err("model files are too large (2 MB maximum each)".to_string());
    }
    if !upload.model_js.contains("defineModel") {
        return Err("model.js is not a lively-mascot 0.3 model".to_string());
    }
    validate_model_source("model.js", &upload.model_js)?;
    validate_model_source("model.css", &upload.model_css)?;
    let manifest = serde_json::from_str::<serde_json::Value>(&upload.model_json)
        .map_err(|error| format!("model.json is invalid: {error}"))?;
    validate_model_interactions(&manifest)?;
    let manifest_id = manifest
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim();
    if manifest_id != upload.id {
        return Err("the selected model id does not match model.json".to_string());
    }
    let models_root = custom_models_dir(&app)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let staging = models_root.join(format!(
        ".{}.staging-{}-{}",
        upload.id,
        std::process::id(),
        stamp
    ));
    fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
    let result = (|| {
        fs::write(staging.join("model.js"), upload.model_js).map_err(|error| error.to_string())?;
        fs::write(staging.join("model.css"), upload.model_css)
            .map_err(|error| error.to_string())?;
        fs::write(staging.join("model.json"), upload.model_json)
            .map_err(|error| error.to_string())?;
        let summary = model_summary_from_manifest(&staging)?;
        let directory = models_root.join(&upload.id);
        let backup = models_root.join(format!(
            ".{}.backup-{}-{}",
            upload.id,
            std::process::id(),
            stamp
        ));
        let had_existing = directory.exists();
        if had_existing {
            fs::rename(&directory, &backup).map_err(|error| error.to_string())?;
        }
        if let Err(error) = fs::rename(&staging, &directory) {
            if had_existing {
                let _ = fs::rename(&backup, &directory);
            }
            return Err(error.to_string());
        }
        if had_existing {
            let _ = fs::remove_dir_all(&backup);
        }
        Ok(summary)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
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
    persist_current_window_position(&app, true);
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
fn clamp_context_menu_position<R: tauri::Runtime>(
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

fn monitor_work_area<R: tauri::Runtime>(
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

#[tauri::command]
fn dock_main_window_to_edge<R: tauri::Runtime>(
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
fn reveal_main_window<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<bool, String> {
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
        .map_err(|error| error.to_string())? = Some(DockState::Revealed(dock_edge.clone()));
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
fn redock_main_window<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<bool, String> {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("Desktop Mascot")
                .build(),
        )
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            app.manage(UpdateManagerState::default());
            let reminder_state = ReminderManagerState::default();
            let reminder_path = reminders_file(app.handle()).ok();
            let pomodoro_path = pomodoro_file(app.handle()).ok();
            if let Some(path) = reminder_path.clone() {
                if let Ok(contents) = fs::read_to_string(&path) {
                    if let Ok(items) = serde_json::from_str::<Vec<Reminder>>(&contents) {
                        if let Ok(mut reminders) = reminder_state.reminders.lock() {
                            *reminders = items.into_iter().map(normalize_reminder).collect();
                        }
                    }
                }
            }
            if let Ok(mut path_slot) = reminder_state.data_path.lock() {
                *path_slot = reminder_path;
            }
            if let Some(path) = pomodoro_path.clone() {
                if let Ok(contents) = fs::read_to_string(&path) {
                    if let Ok(saved) = serde_json::from_str::<PomodoroState>(&contents) {
                        if let Ok(mut pomodoro) = reminder_state.pomodoro.lock() {
                            *pomodoro = normalize_pomodoro(saved);
                        }
                    }
                }
            }
            if let Ok(mut path_slot) = reminder_state.pomodoro_data_path.lock() {
                *path_slot = pomodoro_path;
            }
            app.manage(reminder_state);
            start_reminder_scheduler(app.handle());
            let position_state = window_position_file(app.handle()).ok().map(|path| {
                let dock_state =
                    read_saved_window_position(&path).and_then(|saved| saved.docked_edge);
                Arc::new(WindowPositionPersistence {
                    path,
                    latest: Mutex::new(None),
                    last_saved: Mutex::new(None),
                    dock_state: Mutex::new(dock_state.map(DockState::Docked)),
                })
            });
            if let Some(position_state) = position_state {
                app.manage(WindowPositionState(Arc::clone(&position_state)));
                if let Some(window) = app.get_webview_window("main") {
                    let restored = restore_window_position(&window, &position_state.path);
                    if !restored {
                        let _ = position_main_window(app.handle().clone());
                    }
                    let persistence = Arc::clone(&position_state);
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
            } else {
                let _ = position_main_window(app.handle().clone());
            }
            // Request login-item access once; later changes are controlled from the dashboard.
            request_autostart_once(app.handle());
            // Accessory apps stay available from the menu bar without a Dock icon (macOS only).
            #[cfg(target_os = "macos")]
            let _ = app
                .handle()
                .set_activation_policy(tauri::ActivationPolicy::Accessory);
            #[cfg(not(target_os = "macos"))]
            let _ = app.handle();
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focusable(true);
                // Login-item launches can inherit a hidden/minimized state from the
                // previous process. Always restore the mascot window on startup.
                let _ = window.unminimize();
                let _ = window.show();
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
                    "quit" => {
                        persist_current_window_position(app, true);
                        app.exit(0);
                    }
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
            check_autostart,
            set_autostart,
            get_update_status,
            mark_up_to_date,
            check_for_update,
            start_update_download,
            pause_update_download,
            install_downloaded_update,
            position_main_window,
            resize_main_window,
            clamp_context_menu_position,
            dock_main_window_to_edge,
            reveal_main_window,
            redock_main_window,
            list_custom_models,
            read_custom_model,
            delete_custom_model,
            install_custom_model,
            list_reminders,
            save_reminder,
            delete_reminder,
            get_pomodoro,
            start_pomodoro,
            pause_pomodoro,
            reset_pomodoro,
            skip_pomodoro,
            save_pomodoro
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{advance_pomodoro, is_builtin_model_id, normalize_pomodoro, valid_model_id, validate_model_interactions, validate_model_source, PomodoroState};

    #[test]
    fn completed_focus_advances_to_the_configured_long_break() {
        let mut pomodoro = PomodoroState { long_break_every: 2, completed_focus_today: 1, ..PomodoroState::default() };
        advance_pomodoro(&mut pomodoro, true);
        assert_eq!(pomodoro.completed_focus_today, 2);
        assert_eq!(pomodoro.phase, "longBreak");
        assert_eq!(pomodoro.status, "idle");
        assert!(pomodoro.title.is_empty());
        assert_eq!(pomodoro.session_duration_seconds, pomodoro.long_break_minutes * 60);
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

    #[test]
    fn accepts_skill_style_model_source() {
        assert!(valid_model_id("fox-model_01"));
        assert!(validate_model_source(
            "model.js",
            "LivelyMascot.defineModel({ render: function (model, container) {} });"
        )
        .is_ok());
        assert!(
            validate_model_source("model.css", ".lively-mascot--fox-model { color: red; }").is_ok()
        );
        assert!(is_builtin_model_id("ghost"));
        assert!(!is_builtin_model_id("fox-model_01"));
    }

    #[test]
    fn rejects_external_and_host_capabilities() {
        assert!(validate_model_source("model.js", "fetch('https://example.com')").is_err());
        assert!(
            validate_model_source("model.js", "window.__TAURI_INTERNAL__.invoke('x')").is_err()
        );
        assert!(
            validate_model_source("model.css", "@import url('https://example.com/model.css')")
                .is_err()
        );
    }

    #[test]
    fn validates_declared_model_interactions() {
        let valid = serde_json::json!({
            "interactions": {
                "click": ["10", "16"],
                "drag": ["38"]
            }
        });
        assert!(validate_model_interactions(&valid).is_ok());
        assert!(validate_model_interactions(&serde_json::json!({
            "interactions": { "tap": ["10"] }
        }))
        .is_err());
        assert!(validate_model_interactions(&serde_json::json!({
            "interactions": { "click": "10" }
        }))
        .is_err());
    }
}
