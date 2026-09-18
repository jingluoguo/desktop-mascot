//! One heartbeat for everything time-driven: firing due reminders and advancing the focus timer.
//!
//! Both live in a single loop on purpose. A tick has to see the same "now" for every domain, and
//! splitting it would let a session be advanced twice, or drift apart from the reminder schedule.

use crate::pomodoro::{self, PomodoroManagerState};
use crate::reminders::{self, RemindersState, REMINDER_ACTION_FIRED};
use crate::time::now_epoch;
use chrono::Local;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[derive(Default)]
pub(crate) struct SchedulerState {
    timer: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

/// Starts the heartbeat when something needs watching and it is not already running. Reminders and
/// the focus timer share the task, so either domain can ask for it.
pub(crate) fn start<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let (Some(reminders), Some(pomodoro), Some(scheduler)) = (
        app.try_state::<RemindersState>(),
        app.try_state::<PomodoroManagerState>(),
        app.try_state::<SchedulerState>(),
    ) else {
        return;
    };
    let reminders_armed = reminders
        .reminders
        .lock()
        .map(|items| {
            items
                .iter()
                .any(|item| item.enabled && item.next_run_at.is_some())
        })
        .unwrap_or(false);
    let session_running = pomodoro
        .session
        .lock()
        .map(|session| session.status == "running" && session.ends_at.is_some())
        .unwrap_or(false);
    if !reminders_armed && !session_running {
        return;
    }
    let Ok(mut timer) = scheduler.timer.lock() else {
        return;
    };
    if timer.is_some() {
        return;
    }
    let task_app = app.clone();
    *timer = Some(tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            let (Some(reminder_state), Some(pomodoro_state)) = (
                task_app.try_state::<RemindersState>(),
                task_app.try_state::<PomodoroManagerState>(),
            ) else {
                break;
            };
            let now = now_epoch();
            let mut fired = Vec::new();
            let mut should_continue = false;
            if let Ok(mut reminders) = reminder_state.reminders.lock() {
                for reminder in reminders.iter_mut() {
                    if !reminder.enabled || reminder.next_run_at.is_none() {
                        continue;
                    }
                    should_continue = true;
                    if reminder.next_run_at.is_some_and(|next| next <= now) {
                        reminder.last_fired_at = Some(now);
                        // The snooze label only describes the pending firing, so it is cleared
                        // the moment the reminder actually fires.
                        reminder.snoozed_until = None;
                        fired.push(reminder.clone());
                        if reminder.schedule == "once" {
                            reminder.enabled = false;
                            reminder.next_run_at = None;
                            reminder.completed_at = Some(now);
                        } else if reminder.schedule == "interval" {
                            reminder.next_run_at = Some(
                                now + i64::from(reminder.interval_minutes.unwrap_or(60).max(1))
                                    * 60,
                            );
                        } else {
                            reminder.next_run_at =
                                reminders::next_recurring_run(reminder, Local::now());
                        }
                    }
                }
            }
            let mut pomodoro_completed = None;
            if let Ok(mut session) = pomodoro_state.session.lock() {
                *session = pomodoro::normalize_pomodoro(session.clone());
                if session.status == "running" && session.ends_at.is_some_and(|end| end <= now) {
                    pomodoro::advance_pomodoro(&mut session, true);
                    pomodoro_completed = Some(session.clone());
                }
                if session.status == "running" && session.ends_at.is_some() {
                    should_continue = true;
                }
            }
            if !fired.is_empty() {
                let _ = reminders::save_reminders(&reminder_state);
                for reminder in fired {
                    reminders::record_reminder_event(
                        &reminder_state,
                        &reminder,
                        REMINDER_ACTION_FIRED,
                        now,
                    );
                    // A "strong" reminder mirrors the mascot toast into the OS notification centre,
                    // so it still lands while the pet is covered or on another space.
                    if reminder.system_notification {
                        reminders::send_system_notification(&task_app, &reminder);
                    }
                    let _ = task_app.emit("reminder-fired", reminder);
                }
                let _ = reminders::save_reminder_events(&reminder_state);
            }
            if let Some(session) = pomodoro_completed {
                let _ = pomodoro::save_pomodoro_state(&pomodoro_state);
                let _ = task_app.emit("pomodoro-state", session.clone());
                let _ = task_app.emit("pomodoro-completed", session);
            }
            if !should_continue {
                if let Some(scheduler) = task_app.try_state::<SchedulerState>() {
                    if let Ok(mut slot) = scheduler.timer.lock() {
                        *slot = None;
                    }
                }
                break;
            }
        }
    }));
}
