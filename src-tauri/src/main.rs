#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::{collections::BTreeMap, fs, path::PathBuf, sync::Mutex};
use tauri::async_runtime::JoinHandle;
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;
use tempfile::NamedTempFile;

type CountdownTask = Mutex<Option<(u64, JoinHandle<()>)>>;

struct TaskbarPreference {
    directory: PathBuf,
    show: AtomicBool,
}

impl TaskbarPreference {
    fn load(directory: PathBuf) -> Self {
        let show = directory.join("show-in-taskbar").is_file();
        Self {
            directory,
            show: AtomicBool::new(show),
        }
    }

    fn save(&self, show: bool) -> std::io::Result<()> {
        let marker = self.directory.join("show-in-taskbar");
        if show {
            fs::create_dir_all(&self.directory)?;
            fs::write(marker, b"")?;
        } else if let Err(error) = fs::remove_file(marker) {
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(error);
            }
        }
        self.show.store(show, Ordering::Relaxed);
        Ok(())
    }
}

fn skip_taskbar(app: &AppHandle) -> bool {
    !app.state::<TaskbarPreference>()
        .show
        .load(Ordering::Relaxed)
}

fn show_window(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    window.show()?;
    window.unminimize()?;
    window.set_skip_taskbar(skip_taskbar(window.app_handle()))
}

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
        show_window(&window).map_err(|error| error.to_string())?;
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
    .skip_taskbar(skip_taskbar(&app))
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
        show_window(&window).map_err(|error| error.to_string())?;
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
    .skip_taskbar(skip_taskbar(&app))
    .build()
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn hide_to_tray(window: tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|error| error.to_string())
}

fn restore_windows(app: &AppHandle) {
    let windows = app.webview_windows();
    let mut first_restored = None;
    for window in windows.values() {
        if matches!(window.is_visible(), Ok(false)) || matches!(window.is_minimized(), Ok(true)) {
            let _ = show_window(window);
            first_restored.get_or_insert(window);
        }
    }
    if let Some(window) = windows
        .get("main")
        .or(first_restored)
        .or_else(|| windows.values().next())
    {
        let _ = window.set_focus();
    }
}

fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let restore = MenuItem::with_id(app, "restore", "Show windows", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "Minimize all to tray", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Real Sticky", true, None::<&str>)?;
    let show_taskbar = CheckMenuItem::with_id(
        app,
        "show-taskbar",
        "Show in taskbar",
        true,
        !skip_taskbar(app.handle()),
        None::<&str>,
    )?;
    let menu = Menu::with_items(app, &[&restore, &hide, &show_taskbar, &quit])?;
    let icon = app
        .default_window_icon()
        .ok_or_else(|| std::io::Error::other("Missing Real Sticky tray icon"))?;
    TrayIconBuilder::new()
        .icon(icon.clone())
        .tooltip("Real Sticky")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                restore_windows(tray.app_handle());
            }
        })
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "restore" => restore_windows(app),
            "hide" => {
                for window in app.webview_windows().values() {
                    let _ = window.hide();
                }
            }
            "show-taskbar" => {
                let show = skip_taskbar(app);
                if app.state::<TaskbarPreference>().save(show).is_ok() {
                    for window in app.webview_windows().values() {
                        if matches!(window.is_visible(), Ok(true)) {
                            let _ = window.set_skip_taskbar(!show);
                        }
                    }
                }
                let _ = show_taskbar.set_checked(!skip_taskbar(app));
            }
            "quit" => {
                for window in app.webview_windows().values() {
                    // Use the close-request path so notes can finish saving.
                    let _ = window.close();
                }
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = show_window(&window);
                let _ = window.set_focus();
            } else if let Some(config) = app
                .config()
                .app
                .windows
                .iter()
                .find(|config| config.label == "main")
            {
                let _ = WebviewWindowBuilder::from_config(app, config)
                    .and_then(|builder| builder.skip_taskbar(skip_taskbar(app)).build());
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            app.manage(Storage {
                path: directory.join("notes.json"),
                notes: Mutex::new(None),
            });
            app.manage(CountdownTask::default());
            app.manage(TaskbarPreference::load(directory));
            if !skip_taskbar(app.handle()) {
                if let Some(main) = app.get_webview_window("main") {
                    main.set_skip_taskbar(false)?;
                }
            }
            setup_tray(app)
        })
        .invoke_handler(tauri::generate_handler![
            load_notes,
            write_note,
            float_note,
            float_time,
            hide_to_tray,
            schedule_countdown
        ])
        .run(tauri::generate_context!())
        .expect("Could not start Real Sticky");
}
