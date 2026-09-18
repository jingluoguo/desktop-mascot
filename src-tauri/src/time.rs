//! Time helpers shared by the reminder and focus-timer domains.

use chrono::{DateTime, Datelike, Local, TimeZone};

pub(crate) fn now_epoch() -> i64 {
    Local::now().timestamp()
}

pub(crate) fn parse_run_at(value: &str) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.with_timezone(&Local))
}

pub(crate) fn start_of_today_epoch() -> i64 {
    let now = Local::now();
    Local
        .with_ymd_and_hms(now.year(), now.month(), now.day(), 0, 0, 0)
        .single()
        .map(|date| date.timestamp())
        .unwrap_or_else(|| now.timestamp())
}
