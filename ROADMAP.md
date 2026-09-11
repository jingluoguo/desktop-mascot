**English** | [简体中文](./ROADMAP.zh-CN.md)

# Roadmap

Desktop Mascot is headed from a configurable desktop pet toward a local desktop tool that stays out of the way of your work while still offering the right kind of company.

This roadmap describes current intent rather than a release commitment for every item; priorities will shift with user feedback, platform support, and model capabilities.

## Near term: better for everyday use

### Focus mode and Pomodoro (done)

- [x] Support focus, short break, and long break cycles.
- [x] Let the pet switch expressions, motions, and reminder bubbles according to the current cycle.
- [x] Show the number of focus sessions completed today, sharing scheduling with the existing timed reminders.

### Scenario presets

- Provide presets such as Work, Break, Minimal, and Demo.
- A single preset can save pet size, cursor following, edge snapping, reminders, and visibility together.
- Support creating, editing, importing, and exporting personal presets.

### Richer interactions (done)

- [x] Support distinct reactions for click, double click, hover, and drag.
- [x] Let models declare which actions they support, with unimplemented models degrading gracefully to expression feedback.
- [x] Provide more direct shortcuts for switching accessories and expressions.

## Mid term: less intrusive, more contextual

### Desktop state awareness

- Change the pet's state based on local time, system light / dark mode, and how long the user has been idle.
- Automatically hide or go quiet during full-screen presentations, meetings, or screen sharing.
- Provide clear toggles and status explanations, with every judgment made locally.

### Completable reminders and lightweight tasks

- Add complete, snooze, and skip actions to reminders.
- Let the pet give measured feedback on completion.
- Provide a brief review of the day's reminders and focus sessions.

### Multiple monitors and multiple pets

- Remember position, snapping state, and visibility per monitor.
- Support multiple independent character instances, each keeping its own appearance and behavior configuration.
- Provide a unified management and quick-hide entry point for multiple pets.

## Long term: expanding the character ecosystem

### Model discovery and sharing

- Provide a curated model catalog showing previews, authors, versions, and capability tags.
- Support one-click install, update, and sharing of `.livelymodel` packages.
- Keep model script safety validation and origin hints so the local security boundary is not weakened.

### Optional local-first conversation

- Open a minimal input box from the right-click menu and let the pet respond with short bubbles and expressions.
- Let users configure their own OpenAI API-compatible service or a local model.
- Collect no conversation content by default; networking, model keys, and data retention scope must be explicitly configured by the user.

## Design principles

- The pet must always be easy to ignore: it never steals focus, never blocks important actions, and can be hidden quickly.
- Local-first by default: position, behavior, reminders, and model data stay on the device.
- Progressive enhancement: when a custom model lacks a capability, core interactions must still work.
- Raise everyday value first, then expand the model ecosystem and external service integrations.
