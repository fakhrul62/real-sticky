#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::{collections::BTreeMap, fs, path::PathBuf, sync::Mutex};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;
use tempfile::NamedTempFile;

type CountdownTask = Mutex<Option<(u64, JoinHandle<()>)>>;

#[tauri::command]
fn schedule_countdown(
    app: AppHandle,
    task: State<CountdownTask>,
    ends_at: Option<u64>,
) -> Result<(), String> {
    let mut task = task.lock().map_err(|error| error.to_string())?;
    if task.as_ref().map(|(deadline, _)| *deadline) == ends_at {
        return Ok(());
    }
    if let Some((_, previous)) = task.take() {
        previous.abort();
    }
    if let Some(deadline) = ends_at {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?;
        if let Some(delay) = Duration::from_millis(deadline).checked_sub(now) {
            let notification = tauri::async_runtime::spawn(async move {
                tokio::time::sleep(delay).await;
                let _ = app
                    .notification()
                    .builder()
                    .title("Real Sticky")
                    .body("Your timer has finished.")
                    .show();
            });
            *task = Some((deadline, notification));
        }
    }
    Ok(())
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Note {
    id: String,
    title: String,
    body: Value,
    color: String,
    updated_at: u64,
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    favorite: bool,
    #[serde(default)]
    trashed: bool,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotePatch {
    title: Option<String>,
    body: Option<Value>,
    color: Option<String>,
    updated_at: Option<u64>,
    favorite: Option<bool>,
    trashed: Option<bool>,
}

struct Storage {
    path: PathBuf,
    notes: Mutex<Option<BTreeMap<String, Note>>>,
}

impl Storage {
    fn save(&self, notes: &BTreeMap<String, Note>) -> Result<(), String> {
        let parent = self.path.parent().ok_or("Invalid notes path")?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let mut temp = NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
        serde_json::to_writer(temp.as_file_mut(), notes).map_err(|error| error.to_string())?;
        temp.as_file()
            .sync_all()
            .map_err(|error| error.to_string())?;
        temp.persist(&self.path)
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

#[tauri::command]
async fn load_notes(storage: State<'_, Storage>, seed: Vec<Note>) -> Result<Vec<Note>, String> {
    let mut guard = storage.notes.lock().map_err(|error| error.to_string())?;
    if guard.is_none() {
        let notes = match fs::read(&storage.path) {
            Ok(contents) => serde_json::from_slice(&contents).map_err(|error| error.to_string())?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let notes = seed
                    .into_iter()
                    .map(|note| (note.id.clone(), note))
                    .collect();
                storage.save(&notes)?;
                notes
            }
            Err(error) => return Err(error.to_string()),
        };
        *guard = Some(notes);
    }
    Ok(guard.as_ref().unwrap().values().cloned().collect())
}

#[tauri::command]
async fn write_note(
    app: AppHandle,
    storage: State<'_, Storage>,
    id: String,
    patch: NotePatch,
    create: Option<Note>,
    source: String,
) -> Result<Note, String> {
    let mut guard = storage.notes.lock().map_err(|error| error.to_string())?;
    let notes = guard.as_mut().ok_or("Notes have not been loaded")?;
    let mut next = notes.clone();
    let note = match create {
        Some(note) if note.id == id && !next.contains_key(&id) => {
            next.insert(id.clone(), note);
            next.get_mut(&id).unwrap()
        }
        Some(_) => return Err("Note already exists or has an invalid ID".into()),
        None => next.get_mut(&id).ok_or("Note no longer exists")?,
    };
    if let Some(value) = patch.title {
        note.title = value;
    }
    if let Some(value) = patch.body {
        note.body = value;
    }
    if let Some(value) = patch.color {
        note.color = value;
    }
    if let Some(value) = patch.updated_at {
        note.updated_at = value;
    }
    if let Some(value) = patch.favorite {
        note.favorite = value;
    }
    if let Some(value) = patch.trashed {
        note.trashed = value;
    }
    note.revision += 1;
    let note = note.clone();
    storage.save(&next)?;
    *notes = next;
    let _ = app.emit("note-changed", (&source, &note));
    Ok(note)
}

#[tauri::command]
async fn float_note(app: AppHandle, id: String) -> Result<(), String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Invalid note ID".into());
    }
    let label = format!("note-{id}");
    if let Some(window) = app.get_webview_window(&label) {
        window.unminimize().map_err(|error| error.to_string())?;
        return window.set_focus().map_err(|error| error.to_string());
    }
    WebviewWindowBuilder::new(
        &app,
        label,
        WebviewUrl::App(format!("index.html#note={id}").into()),
    )
    .title("Real Sticky · Note")
    .inner_size(330.0, 360.0)
    .min_inner_size(265.0, 165.0)
    .decorations(false)
    .maximizable(false)
    .always_on_top(true)
    .build()
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn float_time(app: AppHandle, mode: String) -> Result<(), String> {
    let title = match mode.as_str() {
        "clock" => "Real Sticky · Clock",
        "timer" => "Real Sticky · Timer",
        "stopwatch" => "Real Sticky · Stopwatch",
        _ => return Err("Unknown time tool".into()),
    };
    let label = format!("time-{mode}");
    if let Some(window) = app.get_webview_window(&label) {
        window.unminimize().map_err(|error| error.to_string())?;
        return window.set_focus().map_err(|error| error.to_string());
    }
    WebviewWindowBuilder::new(
        &app,
        label,
        WebviewUrl::App(format!("index.html#time={mode}").into()),
    )
    .title(title)
    .inner_size(285.0, 145.0)
    .min_inner_size(260.0, 145.0)
    .decorations(false)
    .maximizable(false)
    .always_on_top(true)
    .build()
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            } else if let Some(config) = app
                .config()
                .app
                .windows
                .iter()
                .find(|config| config.label == "main")
            {
                let _ = WebviewWindowBuilder::from_config(app, config)
                    .and_then(|builder| builder.build());
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            app.manage(Storage {
                path: app.path().app_data_dir()?.join("notes.json"),
                notes: Mutex::new(None),
            });
            app.manage(CountdownTask::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_notes,
            write_note,
            float_note,
            float_time,
            schedule_countdown
        ])
        .run(tauri::generate_context!())
        .expect("Could not start Real Sticky");
}
