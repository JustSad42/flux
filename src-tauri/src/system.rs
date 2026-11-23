//! Windows and app plumbing: Recycle Bin, Explorer, media keys, the data folder, command-line paths, tray.
use super::*;

/// Moves a file to the Recycle Bin (restorable from there).
#[tauri::command]
pub(crate) fn recycle(path: String) -> Result<(), String> {
    if !Path::new(&path).is_file() { return Err("the file is gone".into()); }
    let from: Vec<u16> = path.encode_utf16().chain([0, 0]).collect(); // a double-null-terminated list
    let mut op: SHFILEOPSTRUCTW = unsafe { std::mem::zeroed() };
    op.wFunc = FO_DELETE;
    op.pFrom = from.as_ptr();
    op.fFlags = (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI) as u16;
    let r = unsafe { SHFileOperationW(&mut op) };
    if r != 0 || op.fAnyOperationsAborted != 0 || Path::new(&path).exists() { Err(format!("could not move it to the Recycle Bin (code {r})")) } else { Ok(()) }
}

/// Opens Explorer with the file selected.
#[tauri::command]
pub(crate) fn reveal(path: String) { let _ = Command::new("explorer.exe").raw_arg(format!("/select,\"{path}\"")).spawn(); }

pub(crate) const MEDIA_KEYS: [(Code, &str); 4] = [
    (Code::MediaPlayPause, "playpause"), (Code::MediaTrackNext, "next"), (Code::MediaTrackPrevious, "prev"), (Code::MediaStop, "stop"),
];

/// The keyboard's media keys, also when Flux is in the background. mpv's own Windows media-session support is switched off
/// (it would send Next/Previous to its own one-file playlist), so these go to the UI, which owns the queue.
/// Returns the keys another program already owns.
#[tauri::command]
pub(crate) fn media_keys(app: AppHandle, on: bool) -> Vec<String> {
    let mut taken = Vec::new();
    for (code, name) in MEDIA_KEYS {
        let sc = Shortcut::new(None, code);
        let gs = app.global_shortcut();
        if on {
            if !gs.is_registered(sc) && gs.register(sc).is_err() { taken.push(name.to_string()); }
        } else if gs.is_registered(sc) {
            let _ = gs.unregister(sc);
        }
    }
    taken
}

/// FLUX_DATA=<folder> runs Flux on separate settings/history (test runs), and without the single-window hand-off.
pub(crate) fn test_data_dir() -> Option<PathBuf> { std::env::var_os("FLUX_DATA").filter(|v| !v.is_empty()).map(PathBuf::from) }

pub(crate) fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    match test_data_dir() { Some(d) => Ok(d), None => app.path().app_data_dir().map_err(|e| e.to_string()) }
}

pub(crate) fn store_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if name.contains(['/', '\\']) { return Err("bad name".into()); }
    Ok(data_dir(app)?.join(name))
}

#[tauri::command]
pub(crate) fn store_read(app: AppHandle, name: String) -> Result<Option<String>, String> {
    Ok(fs::read_to_string(store_path(&app, &name)?).ok())
}

#[tauri::command]
pub(crate) fn store_write(app: AppHandle, name: String, text: String) -> Result<(), String> {
    let p = store_path(&app, &name)?;
    fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("tmp");
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string()) // rename = a crash never leaves a half-written file
}

/// A file or folder named on a command line (double-click in Explorer, "Open with", "Play with Flux" on a folder).
pub(crate) fn path_arg<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    args.into_iter().skip(1).find(|a| !a.starts_with('-') && { let p = PathBuf::from(a); p.is_file() || p.is_dir() })
}

#[tauri::command]
pub(crate) fn initial_file() -> Option<String> { path_arg(std::env::args()) }

#[tauri::command]
pub(crate) fn is_dir(path: String) -> bool { Path::new(&path).is_dir() }

/// The page tells Rust whether closing the window should keep Flux in the tray.
#[tauri::command]
pub(crate) fn set_tray(st: State<S>, on: bool) { st.tray.store(on, Ordering::SeqCst); }

pub(crate) fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        set_asleep(&w, false);
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Hiding the window does not tell WebView2: the page kept drawing its animations at the monitor's refresh rate
/// (~160 frames a second, bursts of a whole core) while Flux sat in the tray. Asleep = WebView2 knows it is hidden
/// (no drawing, timers slowed) and keeps as little memory as it can; awake = normal again.
pub(crate) fn set_asleep(w: &WebviewWindow, asleep: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows_core::Interface;
    let _ = w.with_webview(move |wv| unsafe {
        let c = wv.controller();
        let _ = c.SetIsVisible(!asleep);
        if let Ok(core) = c.CoreWebView2() {
            if let Ok(core19) = core.cast::<ICoreWebView2_19>() {
                let _ = core19.SetMemoryUsageTargetLevel(if asleep { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL });
            }
        }
    });
}

pub(crate) fn make_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Flux", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Flux", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut tray = TrayIconBuilder::with_id("flux").tooltip("Flux").menu(&menu).show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() { "open" => show_main(app), "quit" => app.exit(0), _ => {} })
        .on_tray_icon_event(|t, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e { show_main(t.app_handle()); }
        });
    if let Some(icon) = app.default_window_icon() { tray = tray.icon(icon.clone()); }
    tray.build(app)?;
    Ok(())
}

/// The app used to be called Player (data in local.player): bring its settings, history and resume positions along once.
pub(crate) fn migrate_old_data(app: &AppHandle) {
    let Ok(new) = app.path().app_data_dir() else { return };
    let old = new.with_file_name("local.player");
    if new.exists() || !old.is_dir() { return; }
    let _ = fs::create_dir_all(&new);
    if let Ok(rd) = fs::read_dir(&old) {
        for e in rd.flatten() { if e.path().is_file() { let _ = fs::copy(e.path(), new.join(e.file_name())); } }
    }
}
