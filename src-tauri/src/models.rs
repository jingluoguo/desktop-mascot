//! User-authored mascot models. An uploaded model is plain JavaScript and CSS, so installation
//! validates the source instead of trusting it: no network access, no host capabilities.

use crate::storage;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize)]
pub(crate) struct CustomModelSummary {
    id: String,
    name: String,
    version: String,
    author: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct CustomModelSources {
    id: String,
    model_js: String,
    model_css: String,
    model_json: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CustomModelUpload {
    id: String,
    model_js: String,
    model_css: String,
    model_json: String,
}

/// Where user-installed models live. Kept in its own directory so clearing custom models never
/// touches the reminder and focus data stored next to it.
fn custom_models_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    storage::app_data_subdir(app, "models")
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

/// A best-effort speed bump, not a sandbox.
///
/// A model is plain JavaScript that the renderer injects into the app's own window, so it runs
/// with the app's privileges. No static check can confine it: any forbidden token can be assembled
/// at runtime (`window["fet" + "ch"](...)`), and `Function("...")()` cannot be told apart from an
/// ordinary `function (...)` expression once case and spacing are normalised. What this function
/// buys is that an *accidental* network or host call in a generated model fails the import instead
/// of shipping, and that the obvious shapes are refused outright.
///
/// The real boundary is the user's decision to import a package, which is why the dashboard renders
/// the trust notice and asks for confirmation before installing one.
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
    // Comments are dropped and whitespace is then collapsed, so a token cannot be split apart to
    // slip past the check. The space-free form catches the remaining case of `fetch (`.
    let uncommented = strip_block_comments(source).to_ascii_lowercase();
    let collapsed = uncommented.split_whitespace().collect::<Vec<_>>().join(" ");
    let unspaced = collapsed.replace(' ', "");
    let contains = |token: &str| collapsed.contains(token) || unspaced.contains(token);

    if contains("http://")
        || contains("https://")
        || contains("javascript:")
        || contains("data:text/html")
    {
        return Err(format!("{label} may not contain remote or executable URLs"));
    }
    // A protocol-relative URL reaches the network without ever spelling out a scheme, and CSS has
    // no other use for `//`, so rejecting it there costs nothing.
    if label.ends_with(".css") && collapsed.contains("//") {
        return Err(format!("{label} may not contain protocol-relative URLs"));
    }
    if let Some(token) = FORBIDDEN.iter().find(|token| contains(token)) {
        return Err(format!("{label} contains forbidden capability: {token}"));
    }
    Ok(())
}

/// Drops `/* ... */` runs, which mean the same thing in JavaScript and CSS. An unterminated comment
/// is left in place so a malformed file is still scanned in full rather than silently truncated.
fn strip_block_comments(source: &str) -> String {
    let mut result = String::with_capacity(source.len());
    let mut rest = source;
    while let Some(start) = rest.find("/*") {
        result.push_str(&rest[..start]);
        match rest[start + 2..].find("*/") {
            Some(end) => rest = &rest[start + 2 + end + 2..],
            None => return result,
        }
    }
    result.push_str(rest);
    result
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
            return Err(format!(
                "model.json has an unsupported interaction trigger: {trigger}"
            ));
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
            return Err(format!(
                "model.json interaction {trigger} contains an invalid emotion id"
            ));
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
pub(crate) fn list_custom_models<R: tauri::Runtime>(
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
    models.sort_by_key(|model| model.name.to_lowercase());
    Ok(models)
}

#[tauri::command]
pub(crate) fn read_custom_model<R: tauri::Runtime>(
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
pub(crate) fn delete_custom_model<R: tauri::Runtime>(
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
pub(crate) fn install_custom_model<R: tauri::Runtime>(
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn rejects_comment_and_whitespace_evasions() {
        assert!(validate_model_source("model.js", "fe/**/tch('/x')").is_err());
        assert!(validate_model_source("model.js", "fetch ('/x')").is_err());
        assert!(validate_model_source("model.js", "document . cookie").is_err());
        assert!(validate_model_source("model.js", "local /* split */ storage").is_err());
    }

    #[test]
    fn rejects_protocol_relative_css_urls_and_keeps_plain_css() {
        assert!(
            validate_model_source("model.css", ".m { background: url(//example.com/x.png); }")
                .is_err()
        );
        assert!(validate_model_source("model.css", ".m { fill: var(--accent); }").is_ok());
        // `//` only means a URL in CSS. A generated model.js is allowed to keep line comments.
        assert!(validate_model_source(
            "model.js",
            "// draw the parts\nLivelyMascot.defineModel({});"
        )
        .is_ok());
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
