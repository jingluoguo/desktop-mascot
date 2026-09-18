//! The small JSON documents the app keeps in the OS data directory: where a file lives, and how
//! it is read and written. Every persisted feature goes through here, so a new file never needs
//! its own path plumbing.

use serde::de::DeserializeOwned;
use serde::Serialize;
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::Manager;

static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// The app data directory, created on first use. Every persisted document lives inside it.
pub(crate) fn app_data_dir<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

/// A file inside the app data directory.
pub(crate) fn app_data_file<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    name: &str,
) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join(name))
}

/// A subdirectory of the app data directory, created on first use.
pub(crate) fn app_data_subdir<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    name: &str,
) -> Result<PathBuf, String> {
    let directory = app_data_dir(app)?.join(name);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

/// Reads a JSON document, treating a missing or unreadable file as "no data yet". Callers always
/// fall back to defaults, and a corrupt file must never stop the app from starting.
pub(crate) fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    let contents = fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

/// Writes a document atomically: the bytes land in a sibling temp file first, and only a completed
/// write is renamed over the target. A crash, a full disk, or a power loss therefore leaves behind
/// either the previous document or the new one — never a truncated file, which the next launch
/// would read as "no data yet" and silently replace with defaults.
pub(crate) fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or_else(|| "path has no parent directory".to_string())?;
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let file_name = path
        .file_name()
        .ok_or_else(|| "path has no file name".to_string())?
        .to_string_lossy()
        .into_owned();
    // The temp file sits next to the target so the rename stays inside one filesystem and is
    // therefore atomic. A leading dot keeps it out of the directory listings the UI reads.
    // `create_new` matters here: several scheduler/window tasks can persist at once, and a
    // process-only name would let one writer truncate another writer's temp file.
    let (temporary, mut file) = (0..32)
        .find_map(|_| {
            let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let candidate = directory.join(format!(
                ".{file_name}.{}-{sequence}.tmp",
                std::process::id()
            ));
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&candidate)
            {
                Ok(file) => Some(Ok((candidate, file))),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                Err(error) => Some(Err(error.to_string())),
            }
        })
        .ok_or_else(|| "could not create a unique temporary file".to_string())??;
    if let Err(error) = file.write_all(contents).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    drop(file);
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    Ok(())
}

pub(crate) fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let contents = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    write_atomic(path, contents.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(label: &str) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("desktop-mascot-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("scratch directory");
        directory
    }

    #[test]
    fn write_json_replaces_the_document_without_leaving_temp_files() {
        let directory = scratch_dir("storage-write-json");
        let path = directory.join("document.json");
        write_json(&path, &serde_json::json!({ "value": 1 })).expect("first write");
        write_json(&path, &serde_json::json!({ "value": 2 })).expect("second write");

        let saved = read_json::<serde_json::Value>(&path).expect("document is readable");
        assert_eq!(saved["value"], 2);
        let leftovers = fs::read_dir(&directory)
            .expect("scratch directory is readable")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);

        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn write_atomic_creates_a_missing_directory() {
        let directory = scratch_dir("storage-missing-dir").join("nested");
        let path = directory.join("document.json");
        write_atomic(&path, b"{}").expect("write into a missing directory");
        assert_eq!(fs::read_to_string(&path).expect("document exists"), "{}");
    }

    #[test]
    fn concurrent_writes_keep_each_temp_file_isolated() {
        let directory = scratch_dir("storage-concurrent");
        let path = directory.join("document.json");
        let workers = (0..8)
            .map(|index| {
                let path = path.clone();
                std::thread::spawn(move || {
                    write_atomic(&path, format!("{{\"value\":{index}}}").as_bytes())
                        .expect("concurrent write");
                })
            })
            .collect::<Vec<_>>();
        for worker in workers {
            worker.join().expect("writer thread");
        }

        let saved = read_json::<serde_json::Value>(&path).expect("document is readable");
        assert!(saved["value"].as_u64().is_some());
        let leftovers = fs::read_dir(&directory)
            .expect("scratch directory is readable")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);

        let _ = fs::remove_dir_all(&directory);
    }
}
