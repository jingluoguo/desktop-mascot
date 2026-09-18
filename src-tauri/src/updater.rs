//! Self-update: a state machine (idle → checking → downloading → ready) surfaced to the dashboard,
//! with the download on its own task so the user can pause or cancel it.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

#[derive(Clone, Serialize)]
pub(crate) struct UpdateStatus {
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

pub(crate) struct DownloadedUpdate {
    version: String,
    bytes: Vec<u8>,
}

pub(crate) struct UpdateSession {
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
pub(crate) struct UpdateManagerState {
    session: Mutex<UpdateSession>,
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
pub(crate) fn get_update_status<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<UpdateStatus, String> {
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
pub(crate) fn mark_up_to_date<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<UpdateStatus, String> {
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
pub(crate) async fn check_for_update<R: tauri::Runtime>(
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
pub(crate) fn start_update_download<R: tauri::Runtime>(
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
pub(crate) fn pause_update_download<R: tauri::Runtime>(
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
pub(crate) fn install_downloaded_update<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
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
