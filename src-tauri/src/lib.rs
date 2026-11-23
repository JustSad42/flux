// Thin shell: mpv does the playing, the web UI does everything else. Windows only.
//   mpv.rs      finding mpv, its child window, starting it (early or from the page), the JSON pipe
//   media.rs    folder listing, durations, timeline thumbnails
//   whisper.rs  subtitles with Whisper on this PC
//   clip.rs     saving the marked part as a clip
//   system.rs   Recycle Bin, Explorer, media keys, data folder, command line, tray, waking/sleeping the web view
// This file: shared state and helpers, and the app's start-up. The modules `use super::*` for these imports.
use base64::Engine;
use std::{
    collections::VecDeque,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    os::windows::{fs::MetadataExt, io::AsRawHandle, process::CommandExt},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Arc, Mutex, MutexGuard},
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};
use windows_sys::Win32::Foundation::RECT;
use windows_sys::Win32::Graphics::Gdi::{CombineRgn, CreateRectRgn, CreateRoundRectRgn, DeleteObject, SetWindowRgn, RGN_DIFF};
use windows_sys::Win32::System::Pipes::PeekNamedPipe;
use windows_sys::Win32::UI::Shell::{SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE, SHFILEOPSTRUCTW};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, GetClientRect, SetParent, SetWindowPos, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_SHOWWINDOW, WS_CHILD,
    WS_CLIPSIBLINGS, WS_EX_TOOLWINDOW, WS_POPUP, WS_VISIBLE,
};

const NO_WINDOW: u32 = 0x0800_0000; // CREATE_NO_WINDOW
const LOW_PRIORITY: u32 = 0x0000_4000; // BELOW_NORMAL_PRIORITY_CLASS

type Started = Result<(Child, File), String>;

#[derive(Default)]
struct S {
    host: Mutex<isize>,                          // child window mpv draws into
    pipe: Arc<Mutex<Option<File>>>,              // mpv's JSON IPC (one connection: mpv sends replies and events only to the client that asked)
    child: Arc<Mutex<Option<Child>>>,
    early: Mutex<Option<(JoinHandle<Started>, String)>>, // mpv started before the page loaded, and the file it is opening
    scan: Arc<AtomicU64>,                        // id of the newest folder scan; older ones stop
    probe: Arc<AtomicU64>,                       // id of the newest duration probe
    thumb: Arc<AtomicU64>,                       // id of the newest thumbnail job
    exe: Mutex<String>,                          // mpv.exe in use (also used for durations, thumbnails, audio extraction, clips)
    whisper: Arc<Mutex<Option<Job>>>,            // the running Whisper job, if any
    tray: AtomicBool,                            // closing the window hides Flux in the tray instead of quitting
}

/// A Whisper job: the process working right now (audio extraction, then the transcriber; 0 = between the two) and whether Stop was pressed.
#[derive(Default)]
struct Job { pid: u32, stopped: bool }

/// A lock that survives a panic in another thread (the data is still usable; one failed job must not break every later command).
trait Locked<T> { fn locked(&self) -> MutexGuard<'_, T>; }
impl<T> Locked<T> for Mutex<T> {
    fn locked(&self) -> MutexGuard<'_, T> { self.lock().unwrap_or_else(|e| e.into_inner()) }
}

/// A background helper process: no console window, no inherited std handles (a GUI app has none; mpv can hang without this),
/// optionally below normal priority so playback keeps the CPU.
fn quiet(c: &mut Command, low_priority: bool) -> &mut Command {
    c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .creation_flags(NO_WINDOW | if low_priority { LOW_PRIORITY } else { 0 })
}

const FLUX_LUA: &str = include_str!("flux.lua");
const WIN_STATE: StateFlags = StateFlags::SIZE.union(StateFlags::POSITION).union(StateFlags::MAXIMIZED);

mod clip;
mod media;
mod mpv;
mod system;
mod whisper;
use clip::*;
use media::*;
use mpv::*;
use system::*;
use whisper::*;

pub fn run() {
    let mut early = pre_start(); // first of all: mpv opens the file while the rest starts
    let mut b = tauri::Builder::default();
    if test_data_dir().is_none() {
        // must be first: a second launch (double-click in Explorer) hands its file to the running window and exits
        b = b.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            show_main(app); // also brings it back from the tray (and wakes the page first)
            if let Some(p) = path_arg(args) { let _ = app.emit("open-file", p); }
        }));
    }
    let mut ws = tauri_plugin_window_state::Builder::new().with_state_flags(WIN_STATE);
    // a test run keeps its window size/position in its own folder (an absolute name replaces the app's config folder)
    if let Some(d) = test_data_dir() { ws = ws.with_filename(d.join("window-state.json").to_string_lossy()); }
    b.plugin(ws.build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed { return; }
                    if let Some((_, name)) = MEDIA_KEYS.iter().find(|(c, _)| *c == shortcut.key) {
                        let _ = app.emit("media-key", name.to_string());
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .manage(S::default())
        .setup(move |app| {
            migrate_old_data(app.handle());
            if let Some(e) = early.take() { adopt_early(app.handle(), e); }
            let _ = make_tray(app.handle());
            Ok(())
        })
        .on_window_event(|win, ev| {
            // keep-in-tray: closing hides the window (the page stops playback on "to-tray"); Quit is in the tray menu
            if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                let app = win.app_handle();
                if app.state::<S>().tray.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = app.save_window_state(WIN_STATE);
                    let _ = win.emit("to-tray", ());
                    let _ = win.hide();
                    if let Some(w) = app.get_webview_window("main") { set_asleep(&w, true); }
                    // test copies only (FLUX_DATA): FLUX_TEST_WAKE_MS reopens the window by itself, standing in for a tray click
                    let wake = test_data_dir().and(std::env::var("FLUX_TEST_WAKE_MS").ok()).and_then(|v| v.parse::<u64>().ok());
                    if let Some(ms) = wake {
                        let app = app.clone();
                        std::thread::spawn(move || { std::thread::sleep(Duration::from_millis(ms)); show_main(&app); });
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            host_create, host_rect, mpv_start, mpv_cmd, list_dir, probe_durations, make_thumbs, whisper_detect, whisper_run, whisper_cancel,
            clip_export, recycle, reveal, media_keys, store_read, store_write, initial_file, is_dir, set_tray
        ])
        .build(tauri::generate_context!())
        .expect("error while building Flux")
        .run(|app, ev| {
            if let tauri::RunEvent::Exit = ev {
                if let Some(mut c) = app.state::<S>().child.locked().take() { let _ = c.kill(); }
            }
        });
}
