**English** | [简体中文](./CHANGELOG.zh-CN.md)

# Changelog

## [Unreleased]

### Added

- Scheduled reminders with one-off, daily, weekday, and interval schedules, surfaced as a bubble on the desktop pet.
- A focus mode with a pomodoro timer, including per-stage skipping.
- Configurable reactions for click, double-click, hover, and drag, with the context menu listing the shortcuts currently bound.
- Edge docking with a configurable trigger distance and an automatic return to the docked edge.
- A pet window that remembers its position across sessions and can be clicked through, so only the mascot itself responds to the mouse.
- A landing page published through GitHub Pages.
- Reminders that can be completed, snoozed, or skipped from the mascot toast, with the snooze delay configured per reminder.
- A daily review on the reminders tab: how often reminders fired, how they were answered, and how many focus sessions were completed.
- A "Persistent reminder" toggle that sends a real system notification, so a reminder still lands while the mascot is covered or on another desktop.

### Changed

- The context menu and pet hints follow the dashboard language.
- Reminder bubbles wait for a manual acknowledgement, which also retracts the docked pet.
- The mascot plays a short reaction when a reminder is completed, snoozed, or skipped, then returns to its previous state.
- A one-off reminder that ran its course now shows "done" on its card instead of the same label used for reminders switched off by hand.
- The dashboard reuses shared controls and design tokens, and character previews are cached.
- The cursor-following loop polls less often and caches window coordinates.
- The emotion grid no longer prints the numeric emotion id.
- README, ROADMAP, and CHANGELOG are bilingual, with English as the default.

### Fixed

- Fixed interaction reactions overriding a reminder expression.
- Fixed the docking position after a window resize, and kept the context menu inside the visible area.
- Fixed a one-off reminder losing its snooze across restarts.

## [0.2.0] - 2026-09-07

### Added

- Support importing, exporting, overwriting, and deleting custom character models, with user models saved to the system app data directory.
- The dashboard now supports a launch-at-login setting, plus Chinese / English and light / dark themes.
- Added in-app update checks, automatic download, download progress, pause / resume, and the install flow.

### Changed

- Refactored the dashboard and the desktop pet window to support centralized management of character appearance, accessories, expressions, and shortcuts.
- The desktop pet window can now be moved by dragging, with improved window positioning and on-startup restore behavior.
- Upgraded `lively-mascot` to 0.3.1 and refreshed character previews and dashboard visuals.

### Fixed

- Fixed the desktop pet window sometimes starting hidden or minimized when launched at login.
