//! Reminders: the persisted schedule, the rules that decide when one is due, and the commands the
//! mascot toast and the dashboard talk to.
//!
//! The event log lives here as well. "What happened today" can only be answered from history —
//! a recurring reminder reschedules itself the moment it fires, so its current state says nothing
//! about how often it already went off.

use crate::scheduler;
use crate::storage;
use crate::time::{now_epoch, parse_run_at, start_of_today_epoch};
use chrono::{DateTime, Datelike, Duration, Local, TimeZone, Timelike, Weekday};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

/// Reminder actions the mascot toast can report back. A fired reminder stays pending until the
/// user completes, snoozes, or skips it; recurring reminders keep their own schedule either way.
const REMINDER_ACTION_COMPLETED: &str = "completed";
const REMINDER_ACTION_SNOOZED: &str = "snoozed";
const REMINDER_ACTION_SKIPPED: &str = "skipped";
pub(crate) const REMINDER_ACTION_FIRED: &str = "fired";
const DEFAULT_SNOOZE_MINUTES: u32 = 5;
const MAX_SNOOZE_MINUTES: u32 = 120;
/// The daily review only needs "today", so a short retention window keeps the log small.
const REMINDER_EVENT_RETENTION_SECONDS: i64 = 7 * 24 * 60 * 60;
const REMINDER_EVENT_LIMIT: usize = 500;

fn default_snooze_minutes() -> u32 {
    DEFAULT_SNOOZE_MINUTES
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Reminder {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) enabled: bool,
    pub(crate) schedule: String,
    pub(crate) run_at: String,
    pub(crate) interval_minutes: Option<u32>,
    pub(crate) emotion: String,
    pub(crate) system_notification: bool,
    pub(crate) next_run_at: Option<i64>,
    pub(crate) last_fired_at: Option<i64>,
    /// Set while a reminder is waiting out a snooze so the dashboard can show "snoozed until".
    #[serde(default)]
    pub(crate) snoozed_until: Option<i64>,
    #[serde(default = "default_snooze_minutes")]
    pub(crate) snooze_minutes: u32,
    /// Set once a one-off reminder has fired, so the dashboard can tell a reminder that ran its
    /// course apart from one the user switched off by hand. Clearing it means "armed again".
    #[serde(default)]
    pub(crate) completed_at: Option<i64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReminderEvent {
    id: String,
    reminder_id: String,
    title: String,
    action: String,
    at: i64,
}

const REMINDERS_FILE: &str = "reminders.json";
const REMINDER_EVENTS_FILE: &str = "reminder-events.json";

#[derive(Default)]
pub(crate) struct RemindersState {
    pub(crate) reminders: Mutex<Vec<Reminder>>,
    pub(crate) events: Mutex<Vec<ReminderEvent>>,
    pub(crate) data_path: Mutex<Option<PathBuf>>,
    pub(crate) events_data_path: Mutex<Option<PathBuf>>,
}

pub(crate) fn next_recurring_run(reminder: &Reminder, now: DateTime<Local>) -> Option<i64> {
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
    reminder.snooze_minutes = reminder.snooze_minutes.clamp(1, MAX_SNOOZE_MINUTES);
    let now = Local::now();
    // A snooze that already elapsed while the app was closed falls back to the normal schedule
    // instead of lingering as a stale "snoozed until" label.
    if reminder
        .snoozed_until
        .is_some_and(|until| until <= now.timestamp())
    {
        reminder.snoozed_until = None;
    }
    if !reminder.enabled {
        reminder.next_run_at = None;
        reminder.snoozed_until = None;
        return reminder;
    }
    if reminder.schedule == "once" {
        reminder.next_run_at = parse_run_at(&reminder.run_at)
            .map(|date| date.timestamp())
            .filter(|timestamp| *timestamp > now.timestamp());
        if reminder.next_run_at.is_none() {
            // A one-off reminder that already fired stays armed only while it is waiting out a
            // snooze, so a restart does not silently drop a pending "later".
            match reminder.snoozed_until {
                Some(until) => reminder.next_run_at = Some(until),
                // A one-off reminder whose time has passed cannot be armed again, so it keeps its
                // completion marker instead of falling back to the ambiguous "off" label when the
                // user flips the switch and the backend quietly refuses.
                None => {
                    reminder.enabled = false;
                    return reminder;
                }
            }
        }
    } else {
        reminder.next_run_at = next_recurring_run(&reminder, now);
    }
    // Reaching this point means the reminder is armed again, so a completion left over from an
    // earlier one-off run no longer describes it.
    reminder.completed_at = None;
    reminder
}

pub(crate) fn record_reminder_event(
    state: &RemindersState,
    reminder: &Reminder,
    action: &str,
    at: i64,
) {
    let Ok(mut events) = state.events.lock() else {
        return;
    };
    let id = format!(
        "{at}-{}-{action}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.subsec_nanos())
            .unwrap_or(0),
        reminder.id
    );
    events.push(ReminderEvent {
        id,
        reminder_id: reminder.id.clone(),
        title: reminder.title.clone(),
        action: action.to_string(),
        at,
    });
    let cutoff = at - REMINDER_EVENT_RETENTION_SECONDS;
    events.retain(|event| event.at >= cutoff);
    if events.len() > REMINDER_EVENT_LIMIT {
        let excess = events.len() - REMINDER_EVENT_LIMIT;
        events.drain(0..excess);
    }
}

/// Best-effort OS notification for reminders that opt into a strong alert. A denied permission or
/// a platform without a notification centre must never break the scheduler loop, so errors are
/// dropped instead of bubbling up. Only the title is set: the reminder text is what the user needs
/// to read, and the OS already stamps the app name on the banner.
pub(crate) fn send_system_notification<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    reminder: &Reminder,
) {
    let _ = app
        .notification()
        .builder()
        .title(reminder.title.as_str())
        .show();
}

/// Loads reminders and the event log, re-running the same normalization used at runtime so a
/// hand-edited file can never arm the scheduler with an impossible schedule.
pub(crate) fn init<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let state = RemindersState::default();
    if let Ok(path) = storage::app_data_file(app, REMINDERS_FILE) {
        if let Some(items) = storage::read_json::<Vec<Reminder>>(&path) {
            if let Ok(mut reminders) = state.reminders.lock() {
                *reminders = items.into_iter().map(normalize_reminder).collect();
            }
        }
        if let Ok(mut slot) = state.data_path.lock() {
            *slot = Some(path);
        }
    }
    if let Ok(path) = storage::app_data_file(app, REMINDER_EVENTS_FILE) {
        if let Some(items) = storage::read_json::<Vec<ReminderEvent>>(&path) {
            let cutoff = now_epoch() - REMINDER_EVENT_RETENTION_SECONDS;
            if let Ok(mut events) = state.events.lock() {
                *events = items
                    .into_iter()
                    .filter(|event| event.at >= cutoff)
                    .collect();
            }
        }
        if let Ok(mut slot) = state.events_data_path.lock() {
            *slot = Some(path);
        }
    }
    app.manage(state);
}

pub(crate) fn save_reminders(state: &RemindersState) -> Result<(), String> {
    let path = state
        .data_path
        .lock()
        .map_err(|error| error.to_string())?
        .clone()
        .ok_or_else(|| "reminder storage is unavailable".to_string())?;
    let reminders = state.reminders.lock().map_err(|error| error.to_string())?;
    storage::write_json(&path, &*reminders)
}

pub(crate) fn save_reminder_events(state: &RemindersState) -> Result<(), String> {
    let path = state
        .events_data_path
        .lock()
        .map_err(|error| error.to_string())?
        .clone()
        .ok_or_else(|| "reminder event storage is unavailable".to_string())?;
    let events = state.events.lock().map_err(|error| error.to_string())?;
    storage::write_json(&path, &*events)
}

#[tauri::command]
pub(crate) fn list_reminders<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Vec<Reminder>, String> {
    Ok(app
        .state::<RemindersState>()
        .reminders
        .lock()
        .map_err(|error| error.to_string())?
        .clone())
}

#[tauri::command]
pub(crate) fn save_reminder<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    reminder: Reminder,
) -> Result<Vec<Reminder>, String> {
    let state = app.state::<RemindersState>();
    let normalized = normalize_reminder(reminder);
    let mut reminders = state.reminders.lock().map_err(|error| error.to_string())?;
    if let Some(existing) = reminders.iter_mut().find(|item| item.id == normalized.id) {
        *existing = normalized;
    } else {
        reminders.push(normalized);
    }
    drop(reminders);
    save_reminders(&state)?;
    scheduler::start(&app);
    list_reminders(app)
}

#[tauri::command]
pub(crate) fn delete_reminder<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    id: String,
) -> Result<Vec<Reminder>, String> {
    let state = app.state::<RemindersState>();
    let mut reminders = state.reminders.lock().map_err(|error| error.to_string())?;
    reminders.retain(|item| item.id != id);
    drop(reminders);
    save_reminders(&state)?;
    list_reminders(app)
}

#[tauri::command]
pub(crate) fn resolve_reminder<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    id: String,
    action: String,
    snooze_minutes: Option<u32>,
) -> Result<Vec<Reminder>, String> {
    let state = app.state::<RemindersState>();
    let now = now_epoch();
    let resolved = {
        let mut reminders = state.reminders.lock().map_err(|error| error.to_string())?;
        let Some(reminder) = reminders.iter_mut().find(|item| item.id == id) else {
            return Err("reminder not found".to_string());
        };
        match action.as_str() {
            REMINDER_ACTION_SNOOZED => {
                // A snoozed reminder is armed again, including a one-off reminder that had just
                // disabled itself after firing. Completing or skipping only records the outcome,
                // because recurring reminders already queued their next run when they fired.
                let minutes = snooze_minutes
                    .unwrap_or(reminder.snooze_minutes)
                    .clamp(1, MAX_SNOOZE_MINUTES);
                let until = now + i64::from(minutes) * 60;
                reminder.snooze_minutes = minutes;
                reminder.snoozed_until = Some(until);
                reminder.next_run_at = Some(until);
                reminder.enabled = true;
                // Snoozing a one-off reminder that just ran its course arms it again, so the
                // completion marker has to go with it.
                reminder.completed_at = None;
            }
            REMINDER_ACTION_COMPLETED | REMINDER_ACTION_SKIPPED => {}
            other => return Err(format!("unsupported reminder action: {other}")),
        }
        reminder.clone()
    };
    record_reminder_event(&state, &resolved, &action, now);
    save_reminders(&state)?;
    save_reminder_events(&state)?;
    scheduler::start(&app);
    // The dashboard may be open while the mascot toast is answered, so it needs a nudge to
    // refresh both the reminder list and the daily review counters.
    let _ = app.emit("reminder-resolved", &resolved);
    list_reminders(app)
}

#[tauri::command]
pub(crate) fn list_reminder_events<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Vec<ReminderEvent>, String> {
    let state = app.state::<RemindersState>();
    let events = state.events.lock().map_err(|error| error.to_string())?;
    let since = start_of_today_epoch();
    Ok(events
        .iter()
        .filter(|event| event.at >= since)
        .cloned()
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time::start_of_today_epoch;
    use chrono::Local;

    fn sample_reminder() -> Reminder {
        Reminder {
            id: "reminder-1".into(),
            title: "Stand up".into(),
            enabled: true,
            schedule: "daily".into(),
            run_at: Local::now().to_rfc3339(),
            interval_minutes: None,
            emotion: "10".into(),
            system_notification: false,
            next_run_at: None,
            last_fired_at: None,
            snoozed_until: None,
            snooze_minutes: 5,
            completed_at: None,
        }
    }

    #[test]
    fn normalizes_snooze_settings_and_clamps_the_snooze_window() {
        let reminder = normalize_reminder(Reminder {
            snooze_minutes: 0,
            ..sample_reminder()
        });
        assert_eq!(reminder.snooze_minutes, 1);
        assert_eq!(reminder.snoozed_until, None);

        let reminder = normalize_reminder(Reminder {
            snooze_minutes: 9999,
            ..sample_reminder()
        });
        assert_eq!(reminder.snooze_minutes, 120);
    }

    #[test]
    fn keeps_a_pending_snooze_and_drops_an_elapsed_one() {
        let pending = Local::now().timestamp() + 600;
        let reminder = normalize_reminder(Reminder {
            snoozed_until: Some(pending),
            ..sample_reminder()
        });
        assert_eq!(reminder.snoozed_until, Some(pending));

        let reminder = normalize_reminder(Reminder {
            snoozed_until: Some(Local::now().timestamp() - 60),
            ..sample_reminder()
        });
        assert_eq!(reminder.snoozed_until, None);
    }

    #[test]
    fn disabled_reminders_lose_their_snooze_state() {
        let reminder = normalize_reminder(Reminder {
            enabled: false,
            snoozed_until: Some(Local::now().timestamp() + 600),
            ..sample_reminder()
        });
        assert_eq!(reminder.snoozed_until, None);
        assert_eq!(reminder.next_run_at, None);
    }

    #[test]
    fn a_completed_one_off_reminder_keeps_its_marker_until_it_is_armed_again() {
        let finished = Local::now().timestamp() - 120;
        // Still disabled, so the dashboard keeps showing "completed" after a restart instead of
        // falling back to the ambiguous "paused" label.
        let reminder = normalize_reminder(Reminder {
            enabled: false,
            completed_at: Some(finished),
            ..sample_reminder()
        });
        assert_eq!(reminder.completed_at, Some(finished));

        // Switched back on, so the marker no longer describes the reminder.
        let reminder = normalize_reminder(Reminder {
            enabled: true,
            completed_at: Some(finished),
            ..sample_reminder()
        });
        assert_eq!(reminder.completed_at, None);

        // Flipping the switch on a finished one-off reminder cannot arm it again, so the marker has
        // to survive instead of degrading into a plain "off" the moment the user touches it.
        let reminder = normalize_reminder(Reminder {
            enabled: true,
            schedule: "once".into(),
            run_at: (Local::now() - chrono::Duration::minutes(30)).to_rfc3339(),
            completed_at: Some(finished),
            ..sample_reminder()
        });
        assert!(!reminder.enabled);
        assert_eq!(reminder.completed_at, Some(finished));
    }

    #[test]
    fn a_fired_one_off_reminder_stays_armed_while_snoozed() {
        let past = Local::now() - chrono::Duration::minutes(30);
        let until = Local::now().timestamp() + 300;
        let snoozed = normalize_reminder(Reminder {
            schedule: "once".into(),
            run_at: past.to_rfc3339(),
            snoozed_until: Some(until),
            ..sample_reminder()
        });
        assert!(snoozed.enabled);
        assert_eq!(snoozed.next_run_at, Some(until));

        let settled = normalize_reminder(Reminder {
            schedule: "once".into(),
            run_at: past.to_rfc3339(),
            ..sample_reminder()
        });
        assert!(!settled.enabled);
        assert_eq!(settled.next_run_at, None);
    }

    #[test]
    fn daily_review_window_starts_at_local_midnight() {
        let start = start_of_today_epoch();
        let now = Local::now().timestamp();
        assert!(start <= now);
        assert!(now - start < 24 * 60 * 60);
    }
}
