// Thin shell: mpv does the playing, the web UI does everything else.
// Windows only (child window for mpv, named-pipe IPC, hidden-file attribute).
use base64::Engine;
use std::{
    collections::VecDeque,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    os::windows::{fs::MetadataExt, io::AsRawHandle, process::CommandExt},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Arc, Mutex},
    thread::JoinHandle,
    time::Duration,
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
    CreateWindowExW, GetClientRect, SetWindowPos, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_SHOWWINDOW, WS_CHILD, WS_CLIPSIBLINGS, WS_VISIBLE,
};

const NO_WINDOW: u32 = 0x0800_0000; // CREATE_NO_WINDOW
const LOW_PRIORITY: u32 = 0x0000_4000; // BELOW_NORMAL_PRIORITY_CLASS

type Started = Result<(Child, File), String>;

#[derive(Default)]
struct S {
    host: Mutex<isize>,                          // child window mpv draws into
    pipe: Arc<Mutex<Option<File>>>,              // mpv's JSON IPC (one connection: mpv sends replies and events only to the client that asked)
    child: Mutex<Option<Child>>,
    early: Mutex<Option<(JoinHandle<Started>, String)>>, // mpv started before the page loaded, and the file it is opening
    scan: Arc<AtomicU64>,                        // id of the newest folder scan; older ones stop
    probe: Arc<AtomicU64>,                       // id of the newest duration probe
    thumb: Arc<AtomicU64>,                       // id of the newest thumbnail job
    exe: Mutex<String>,                          // mpv.exe in use (also used for durations, thumbnails, audio extraction, clips)
    whisper: Arc<Mutex<Option<u32>>>,            // pid of the running Whisper job
    tray: AtomicBool,                            // closing the window hides Flux in the tray instead of quitting
}

const FLUX_LUA: &str = include_str!("flux.lua");
const WIN_STATE: StateFlags = StateFlags::SIZE.union(StateFlags::POSITION).union(StateFlags::MAXIMIZED);

/// Custom path from Settings (file or folder), else the mpv bundled with the installer, else mpv on PATH, else the usual install folders (winget does not put mpv on PATH).
fn find_mpv(custom: &str) -> String {
    if !custom.trim().is_empty() {
        let p = PathBuf::from(custom.trim());
        let exe = if p.is_dir() { p.join("mpv.exe") } else { p };
        if exe.is_file() { return exe.to_string_lossy().into_owned(); }
        // a custom path that no longer exists falls through to the bundled copy instead of failing
    }
    // the mpv shipped inside the installer, next to flux.exe
    if let Some(d) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())) {
        for rel in [r"mpv\mpv.exe", r"resources\mpv\mpv.exe"] {
            let p = d.join(rel);
            if p.is_file() { return p.to_string_lossy().into_owned(); }
        }
    }
    let on_path = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join("mpv.exe").is_file()))
        .unwrap_or(false);
    if on_path { return "mpv".into(); }
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    [
        r"C:\Program Files\MPV Player\mpv.exe".to_string(),
        r"C:\Program Files\mpv\mpv.exe".to_string(),
        r"C:\Program Files (x86)\mpv\mpv.exe".to_string(),
        format!(r"{local}\Programs\mpv\mpv.exe"),
        format!(r"{local}\Microsoft\WinGet\Links\mpv.exe"),
    ]
    .into_iter()
    .find(|p| PathBuf::from(p).is_file())
    .unwrap_or_else(|| "mpv".into())
}

fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain([0]).collect() }

/// STATIC + SS_BLACKRECT (0x4): a plain black child window for mpv to draw into.
fn make_host(parent: isize, x: i32, y: i32, w: i32, h: i32, visible: bool) -> Result<isize, String> {
    let style = WS_CHILD | WS_CLIPSIBLINGS | 0x4 | if visible { WS_VISIBLE } else { 0 };
    let hwnd = unsafe {
        CreateWindowExW(0, wide("STATIC").as_ptr(), std::ptr::null(), style, x, y, w, h, parent as _, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null())
    } as isize;
    if hwnd == 0 { Err("CreateWindowExW failed".into()) } else { Ok(hwnd) }
}

/// Must run on the main thread (sync command): the window needs the UI thread's message loop.
/// Reuses the window made at start-up when mpv was started early.
#[tauri::command]
fn host_create(win: WebviewWindow, st: State<S>, x: i32, y: i32, w: i32, h: i32) -> Result<isize, String> {
    let mut g = st.host.lock().unwrap();
    if *g != 0 { return Ok(*g); }
    let parent = win.hwnd().map_err(|e| e.to_string())?.0 as isize;
    *g = make_host(parent, x, y, w, h, false)?;
    Ok(*g)
}

/// Places the video window over #video (and on top of the web view). `cuts` are [x, y, w, h, radius] holes (window pixels)
/// where the page's controls float over the picture: the web view underneath shows through while the video keeps its size.
#[tauri::command]
fn host_rect(st: State<S>, x: i32, y: i32, w: i32, h: i32, show: bool, cuts: Vec<[i32; 5]>) {
    let hwnd = *st.host.lock().unwrap();
    if hwnd == 0 { return; }
    unsafe {
        if cuts.is_empty() {
            SetWindowRgn(hwnd as _, std::ptr::null_mut(), 1);
        } else {
            let rgn = CreateRectRgn(0, 0, w, h);
            for [cx, cy, cw, ch, r] in cuts {
                let hole = if r > 0 { CreateRoundRectRgn(cx, cy, cx + cw + 1, cy + ch + 1, r * 2, r * 2) } else { CreateRectRgn(cx, cy, cx + cw, cy + ch) };
                CombineRgn(rgn, rgn, hole, RGN_DIFF);
                DeleteObject(hole as _);
            }
            SetWindowRgn(hwnd as _, rgn, 1); // the system owns rgn from here on
        }
        let flags = SWP_NOACTIVATE | if show { SWP_SHOWWINDOW } else { SWP_HIDEWINDOW };
        SetWindowPos(hwnd as _, std::ptr::null_mut(), x, y, w, h, flags);
    }
}

fn mpv_log() -> PathBuf { std::env::temp_dir().join("flux-mpv.log") }
fn pipe_name() -> String { format!(r"\\.\pipe\flux-{}", std::process::id()) }

fn mpv_command(exe: &str, host: isize, conf: &Path) -> Command {
    let shots = PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default()).join("Pictures").join("Flux");
    let _ = fs::create_dir_all(&shots);
    let lua = conf.with_file_name("flux.lua");
    let _ = fs::write(&lua, FLUX_LUA);
    let mut c = Command::new(exe);
    c.arg(format!("--script={}", lua.display()));
    c.args(["--idle=yes", "--force-window=yes", "--keep-open=no", "--no-terminal", "--no-osc", "--load-scripts=no", "--ytdl=no",
            "--no-input-default-bindings", "--osd-level=1", "--hwdec=auto-safe", "--sub-auto=fuzzy", "--cursor-autohide=2500",
            "--window-dragging=no", // a held click is flux.lua's (pan when zoomed), never mpv's own window drag
            "--save-position-on-quit=no", "--media-controls=no", "--screenshot-template=%F-%wH.%wM.%wS"])
        .arg(format!("--screenshot-directory={}", shots.display()))
        .arg(format!("--wid={host}"))
        .arg(format!("--input-ipc-server={}", pipe_name()))
        .arg(format!("--input-conf={}", conf.display()))
        .arg(format!("--log-file={}", mpv_log().display()))
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()) // a GUI process has no console to inherit
        .creation_flags(NO_WINDOW);
    c
}

/// Waits for mpv's control pipe. On failure the end of mpv's log goes into the error.
fn connect(mut child: Child, exe: &str) -> Started {
    let log = mpv_log();
    let tail = |why: &str| {
        let t = fs::read_to_string(&log).unwrap_or_default();
        let t: Vec<&str> = t.lines().rev().take(6).collect();
        format!("{why}. mpv log ({}): {}", log.display(), t.into_iter().rev().collect::<Vec<_>>().join(" | "))
    };
    for _ in 0..500 {
        if let Ok(Some(status)) = child.try_wait() { return Err(tail(&format!("mpv at '{exe}' exited right away ({status})"))); }
        if let Ok(f) = OpenOptions::new().read(true).write(true).open(pipe_name()) { return Ok((child, f)); }
        std::thread::sleep(Duration::from_millis(10));
    }
    let _ = child.kill();
    Err(tail("mpv started but its control pipe never appeared"))
}

/// A blocking read on this (synchronous) handle would stall writes, so poll: read only what PeekNamedPipe says is waiting.
fn start_reader(app: AppHandle, shared: Arc<Mutex<Option<File>>>) {
    std::thread::spawn(move || {
        let (mut buf, mut chunk) = (Vec::<u8>::new(), [0u8; 8192]);
        'run: loop {
            let n = {
                let mut g = shared.lock().unwrap();
                let Some(f) = g.as_mut() else { break 'run };
                let mut avail = 0u32;
                if unsafe { PeekNamedPipe(f.as_raw_handle() as _, std::ptr::null_mut(), 0, std::ptr::null_mut(), &mut avail, std::ptr::null_mut()) } == 0 { break 'run; }
                if avail == 0 { 0 } else {
                    match f.read(&mut chunk[..(avail as usize).min(8192)]) { Ok(n) if n > 0 => n, _ => break 'run }
                }
            };
            if n == 0 { std::thread::sleep(Duration::from_millis(4)); continue; }
            buf.extend_from_slice(&chunk[..n]);
            while let Some(i) = buf.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = buf.drain(..=i).collect();
                let _ = app.emit("mpv", String::from_utf8_lossy(&line).trim_end().to_string());
            }
        }
        let _ = app.emit("mpv", r#"{"event":"shutdown"}"#);
    });
}

/// Connects the page to mpv. Returns the file mpv is already opening when it was started early (see `early_start`).
/// The key bindings are kept in the data folder so the next early start can use them.
#[tauri::command]
async fn mpv_start(app: AppHandle, st: State<'_, S>, host: isize, input_conf: String, mpv_path: String) -> Result<Option<String>, String> {
    if st.pipe.lock().unwrap().is_some() { return Ok(None); }
    let conf = data_dir(&app)?.join("input.conf");
    let early = st.early.lock().unwrap().take();
    let (started, preloaded) = match early {
        Some((h, file)) => {
            let r = tauri::async_runtime::spawn_blocking(move || h.join().unwrap_or_else(|_| Err("mpv start-up failed".into())))
                .await.map_err(|e| e.to_string())?;
            let _ = fs::write(&conf, &input_conf);
            (r, Some(file))
        }
        None => {
            let exe = find_mpv(&mpv_path);
            *st.exe.lock().unwrap() = exe.clone();
            let r = tauri::async_runtime::spawn_blocking(move || -> Started {
                fs::create_dir_all(conf.parent().unwrap()).map_err(|e| e.to_string())?;
                fs::write(&conf, input_conf).map_err(|e| e.to_string())?;
                let child = mpv_command(&exe, host, &conf).spawn()
                    .map_err(|e| format!("cannot start mpv at '{exe}' ({e}): run setup-windows.ps1 or set the mpv path in Settings"))?;
                connect(child, &exe)
            })
            .await.map_err(|e| e.to_string())?;
            (r, None)
        }
    };
    let (child, io) = started?;
    *st.pipe.lock().unwrap() = Some(io);
    start_reader(app.clone(), st.pipe.clone());
    *st.child.lock().unwrap() = Some(child);
    Ok(preloaded)
}

/// Opened with a file (double-click in Explorer): start mpv on it right away, while the web view is still loading,
/// at the saved volume and resume position. Needs the key bindings saved by an earlier run; otherwise the page starts mpv as usual.
fn early_start(app: &AppHandle) {
    let Some(file) = initial_file().filter(|f| Path::new(f).is_file()) else { return };
    let Ok(dir) = data_dir(app) else { return };
    let conf = dir.join("input.conf");
    if !conf.is_file() { return; }
    let read = |n: &str| fs::read_to_string(dir.join(n)).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).unwrap_or_default();
    let (set, hist) = (read("settings.json"), read("history.json"));
    let h = &hist[file.replace('/', "\\").to_lowercase().as_str()];
    let (pos, dur) = (h["pos"].as_f64().unwrap_or(0.0), h["dur"].as_f64().unwrap_or(0.0));
    // the same rule as resumeStart() in src/media/markers.ts
    let start = if pos < 15.0 || (dur > 0.0 && pos >= dur - 30f64.max(dur * 0.03)) { 0.0 } else { (pos - 3.0).max(0.0) };
    let Some(win) = app.get_webview_window("main") else { return };
    let Ok(parent) = win.hwnd() else { return };
    let mut rc: RECT = unsafe { std::mem::zeroed() };
    unsafe { GetClientRect(parent.0 as _, &mut rc) };
    let Ok(host) = make_host(parent.0 as isize, 0, 0, rc.right.max(1), rc.bottom.max(1), true) else { return };
    let st = app.state::<S>();
    *st.host.lock().unwrap() = host;
    let exe = find_mpv(set["mpvPath"].as_str().unwrap_or(""));
    *st.exe.lock().unwrap() = exe.clone();
    let mut cmd = mpv_command(&exe, host, &conf);
    cmd.arg(format!("--volume={}", set["volume"].as_f64().unwrap_or(100.0)));
    if start > 0.0 { cmd.arg(format!("--start={start:.2}")); }
    cmd.arg("--").arg(&file);
    let Ok(child) = cmd.spawn() else { return }; // the page starts mpv the normal way and reports the error
    let h = std::thread::spawn(move || connect(child, &exe));
    *st.early.lock().unwrap() = Some((h, file));
}

#[tauri::command]
fn mpv_cmd(st: State<S>, line: String) -> Result<(), String> {
    let mut g = st.pipe.lock().unwrap();
    let f = g.as_mut().ok_or("mpv is not running")?;
    writeln!(f, "{line}").map_err(|e| e.to_string())
}

/// MP4/MOV duration straight from the `mvhd` box (milliseconds per file instead of starting mpv). Recorders often write
/// the index at the end, so top-level boxes are skipped by size rather than read.
fn mp4_duration(path: &str) -> Option<f64> {
    let ext = Path::new(path).extension()?.to_string_lossy().to_lowercase();
    if !matches!(ext.as_str(), "mp4" | "m4v" | "mov" | "m4a" | "3gp") { return None; }
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let head = |f: &mut File, at: u64| -> Option<(u64, [u8; 4], u64)> {
        let mut h = [0u8; 16];
        f.seek(SeekFrom::Start(at)).ok()?;
        f.read_exact(&mut h[..8]).ok()?;
        let (mut size, kind, mut hdr) = (u32::from_be_bytes(h[0..4].try_into().ok()?) as u64, [h[4], h[5], h[6], h[7]], 8u64);
        if size == 1 { f.read_exact(&mut h[8..16]).ok()?; size = u64::from_be_bytes(h[8..16].try_into().ok()?); hdr = 16; }
        else if size == 0 { size = len - at; }
        (size >= hdr).then_some((size, kind, hdr))
    };
    let mut pos = 0u64;
    while pos + 8 <= len {
        let (size, kind, hdr) = head(&mut f, pos)?;
        if &kind == b"moov" {
            let (end, mut p) = (pos + size, pos + hdr);
            while p + 8 <= end {
                let (cs, ck, ch) = head(&mut f, p)?;
                if &ck == b"mvhd" {
                    let mut b = [0u8; 32];
                    f.seek(SeekFrom::Start(p + ch)).ok()?;
                    f.read_exact(&mut b).ok()?;
                    let (scale, d) = if b[0] == 1 {
                        (u32::from_be_bytes(b[20..24].try_into().ok()?) as f64, u64::from_be_bytes(b[24..32].try_into().ok()?) as f64)
                    } else {
                        (u32::from_be_bytes(b[12..16].try_into().ok()?) as f64, u32::from_be_bytes(b[16..20].try_into().ok()?) as f64)
                    };
                    return (scale > 0.0 && d > 0.0).then(|| d / scale);
                }
                p += cs;
            }
            return None;
        }
        pos += size;
    }
    None
}

/// Reads durations one file at a time (MP4 directly, anything else with mpv, no playback) and emits `{path, dur}` as "dur" events.
/// A newer call (higher id) stops an older one.
#[tauri::command]
async fn probe_durations(app: AppHandle, st: State<'_, S>, paths: Vec<String>, id: u64) -> Result<(), String> {
    let probe = st.probe.clone();
    probe.store(id, Ordering::SeqCst);
    let exe = st.exe.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || {
        for p in paths {
            if probe.load(Ordering::SeqCst) != id { return; }
            let d = mp4_duration(&p).or_else(|| {
                if exe.is_empty() { return None; }
                let out = Command::new(&exe)
                    .args(["--no-config", "--vo=null", "--ao=null", "--no-terminal", "--really-quiet", "--frames=1", "--load-scripts=no",
                           "--term-playing-msg=DUR=${=duration}"])
                    .arg(&p)
                    .stdin(Stdio::null())
                    .creation_flags(NO_WINDOW | LOW_PRIORITY)
                    .output();
                let text = out.map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
                text.lines().find_map(|l| l.strip_prefix("DUR=")).and_then(|v| v.trim().parse::<f64>().ok())
            });
            if let Some(d) = d { let _ = app.emit("dur", serde_json::json!({ "path": p, "dur": d })); }
        }
    })
    .await
    .map_err(|e| e.to_string())
}

fn fnv(s: &str) -> u64 { s.bytes().fold(0xcbf29ce484222325, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3)) }

/// Timeline thumbnails: `n` frames spread over the file, coarse to fine (so the hover preview is usable early), cached on disk.
/// Emits "thumb" {id, idx, data} with a JPEG data URL. A newer call stops an older one.
#[tauri::command]
async fn make_thumbs(app: AppHandle, st: State<'_, S>, path: String, dur: f64, n: usize, id: u64) -> Result<(), String> {
    let gen = st.thumb.clone();
    gen.store(id, Ordering::SeqCst);
    let exe = st.exe.lock().unwrap().clone();
    if exe.is_empty() || n == 0 || dur <= 0.0 { return Ok(()); }
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("thumbs");
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    let key = format!("{:016x}", fnv(&format!("{path}|{}|{:?}", meta.len(), meta.modified().ok())));
    let dir = cache.join(&key);
    tauri::async_runtime::spawn_blocking(move || {
        let _ = fs::create_dir_all(&dir);
        if let Ok(rd) = fs::read_dir(&cache) { // keep the cache small: newest 300 files' worth of folders
            let mut all: Vec<_> = rd.flatten().filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path()))).collect();
            all.sort();
            for (_, p) in all.iter().take(all.len().saturating_sub(300)) { let _ = fs::remove_dir_all(p); }
        }
        let mut order = Vec::new();
        let mut step = n.next_power_of_two();
        while step >= 1 {
            for i in (step / 2..n).step_by(step.max(1)) { if !order.contains(&i) { order.push(i); } }
            if step == 1 { break; }
            step /= 2;
        }
        for i in 0..n { if !order.contains(&i) { order.push(i); } }
        // a few mpv processes at once (each only decodes one keyframe): previews fill in several times sooner
        let work = Arc::new(Mutex::new(order.into_iter().collect::<VecDeque<usize>>()));
        let workers: Vec<_> = (0..4).map(|_| {
            let (work, gen, dir, exe, path, app) = (work.clone(), gen.clone(), dir.clone(), exe.clone(), path.clone(), app.clone());
            std::thread::spawn(move || thumb_worker(&work, &gen, id, &dir, &exe, &path, dur, n, &app))
        }).collect();
        for w in workers { let _ = w.join(); }
    })
    .await
    .map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)]
fn thumb_worker(work: &Mutex<VecDeque<usize>>, gen: &AtomicU64, id: u64, dir: &Path, exe: &str, path: &str, dur: f64, n: usize, app: &AppHandle) {
    {
        loop {
            if gen.load(Ordering::SeqCst) != id { return; }
            let Some(idx) = work.lock().unwrap().pop_front() else { return };
            let f = dir.join(format!("{idx}-{n}.jpg"));
            if !f.exists() {
                let tmp = dir.join(format!("t{idx}"));
                let _ = fs::remove_dir_all(&tmp);
                let _ = fs::create_dir_all(&tmp);
                let t = dur * (idx as f64 + 0.5) / n as f64;
                let _ = Command::new(exe)
                    .args(["--no-config", "--no-audio", "--no-sub", "--vo=image", "--vo-image-format=jpg", "--vo-image-jpeg-quality=72",
                           "--frames=1", "--hr-seek=no", "--vf=scale=320:-2", "--really-quiet", "--no-terminal", "--load-scripts=no", "--ytdl=no"])
                    .arg(format!("--start={t:.2}"))
                    .arg(format!("--vo-image-outdir={}", tmp.display()))
                    .arg(path)
                    .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()) // a GUI process has no stdin to inherit
                    .creation_flags(NO_WINDOW | LOW_PRIORITY)
                    .status();
                if let Some(first) = fs::read_dir(&tmp).ok().and_then(|d| d.flatten().next()) { let _ = fs::rename(first.path(), &f); }
                let _ = fs::remove_dir_all(&tmp);
            }
            if let Ok(bytes) = fs::read(&f) {
                let data = format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes));
                let _ = app.emit("thumb", serde_json::json!({ "id": id, "idx": idx, "data": data }));
            }
        }
    }
}

#[derive(serde::Serialize)]
struct FoundWhisper { exe: String, model: String, vad: String }

/// whisper.cpp already on the PC: Flux's own folder (%LOCALAPPDATA%\local.flux\whisper), then LingoReel's download.
/// Picks the best model found (large-v3-turbo first) and a Silero VAD model if one is there.
#[tauri::command]
fn whisper_detect(app: AppHandle) -> Option<FoundWhisper> {
    let mut places = Vec::new();
    if let Ok(d) = app.path().app_local_data_dir() { places.push((d.join("whisper"), d.join("whisper"))); }
    let lr = PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default()).join(r"com.lingoreel.app\components");
    places.push((lr.join(r"whisper\Release"), lr.join("models")));
    let s = |p: &Path| p.to_string_lossy().into_owned();
    for (bin, models) in places {
        let exe = bin.join("whisper-cli.exe");
        if !exe.is_file() { continue; }
        let mut bins: Vec<PathBuf> = [&bin, &models].into_iter()
            .flat_map(|d| fs::read_dir(d).into_iter().flatten().flatten().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("bin")))
            .collect();
        bins.sort();
        bins.dedup();
        let name = |p: &PathBuf| p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        let is_vad = |p: &PathBuf| { let n = name(p); n.contains("silero") || n.contains("vad") };
        let rank = |p: &PathBuf| { let n = name(p); ["large-v3-turbo", "large", "medium", "small", "base", "tiny"].iter().position(|k| n.contains(k)).unwrap_or(9) };
        let vad = bins.iter().find(|p| is_vad(p)).map(|p| s(p)).unwrap_or_default();
        if let Some(model) = bins.iter().filter(|p| !is_vad(p)).min_by_key(|p| rank(p)) {
            return Some(FoundWhisper { exe: s(&exe), model: s(model), vad });
        }
    }
    None
}

#[derive(serde::Deserialize)]
struct Whisper {
    flavor: String, exe: String, model: String, lang: String, translate: bool, file: String, outdir: String, template: String,
    #[serde(default)] vad: String,
    #[serde(default)] aid: Option<i64>,
}

/// Optional, manual subtitle generation with the user's own Whisper install. Returns at once; progress comes as
/// "whisper-log" lines and a final "whisper-done" {ok, srt, error}.
#[tauri::command]
fn whisper_run(app: AppHandle, st: State<S>, cfg: Whisper) -> Result<(), String> {
    if st.whisper.lock().unwrap().is_some() { return Err("Subtitles are already being generated".into()); }
    if cfg.exe.trim().is_empty() && cfg.flavor != "custom" { return Err("Set the Whisper program first".into()); }
    if cfg.flavor == "cpp" && cfg.translate && cfg.model.to_lowercase().contains("turbo") {
        return Err("The turbo model cannot translate: choose a large or medium model, or turn off Translate".into());
    }
    let mpv = st.exe.lock().unwrap().clone();
    let slot = st.whisper.clone();
    *slot.lock().unwrap() = Some(0);
    std::thread::spawn(move || {
        let stem = Path::new(&cfg.file).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "subtitles".into());
        // never overwrite a subtitle file that was already there: "<name>.srt", or "<name>.whisper.srt" next to it
        let out_stem = if Path::new(&cfg.outdir).join(format!("{stem}.srt")).exists() { format!("{stem}.whisper") } else { stem.clone() };
        let srt = Path::new(&cfg.outdir).join(format!("{out_stem}.srt"));
        let log = |l: &str| { let _ = app.emit("whisper-log", l.to_string()); };
        let done = |ok: bool, err: &str| {
            *slot.lock().unwrap() = None;
            let _ = app.emit("whisper-done", serde_json::json!({ "ok": ok, "srt": srt.to_string_lossy(), "error": err }));
        };
        let _ = fs::create_dir_all(&cfg.outdir);
        let lang = cfg.lang.trim();
        let mut wav_tmp: Option<PathBuf> = None;
        let mut cmd;
        match cfg.flavor.as_str() {
            "cpp" => { // whisper.cpp wants a 16 kHz mono wav: mpv can make one (as fast as it can decode), no ffmpeg needed
                let wav = std::env::temp_dir().join(format!("flux-whisper-{}.wav", std::process::id()));
                log("Extracting audio…");
                let mut ex = Command::new(&mpv);
                ex.args(["--no-config", "--no-video", "--vo=null", "--audio-samplerate=16000", "--audio-channels=mono", "--audio-format=s16",
                         "--ao=pcm", "--really-quiet", "--no-terminal", "--load-scripts=no"])
                    .arg(format!("--ao-pcm-file={}", wav.display()));
                if let Some(a) = cfg.aid { ex.arg(format!("--aid={a}")); }
                let ok = ex.arg("--").arg(&cfg.file)
                    .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
                    .creation_flags(NO_WINDOW).status().map(|s| s.success()).unwrap_or(false);
                if !ok || !wav.exists() { let _ = fs::remove_file(&wav); return done(false, "could not extract the audio with mpv"); }
                log("Transcribing on the GPU…");
                cmd = Command::new(&cfg.exe);
                cmd.arg("-m").arg(&cfg.model).arg("-f").arg(&wav).arg("-osrt").arg("-pp").arg("-of").arg(Path::new(&cfg.outdir).join(&out_stem));
                cmd.arg("-l").arg(if lang.is_empty() { "auto" } else { lang }); // whisper.cpp assumes English when not told
                if cfg.translate { cmd.arg("-tr"); }
                if !cfg.vad.is_empty() && Path::new(&cfg.vad).is_file() { cmd.arg("--vad").arg("-vm").arg(&cfg.vad); } // skips non-speech: no invented lines over game noise or music
                wav_tmp = Some(wav);
            }
            "custom" => { // {file} {outdir} {stem} {lang} {model} are replaced; the line runs through cmd.exe
                let line = cfg.template.replace("{file}", &cfg.file).replace("{outdir}", &cfg.outdir).replace("{stem}", &stem)
                    .replace("{lang}", lang).replace("{model}", &cfg.model);
                cmd = Command::new("cmd");
                cmd.raw_arg(format!("/C \"{line}\""));
            }
            _ => { // openai-whisper, whisper-ctranslate2, faster-whisper-xxl: the same command line
                cmd = Command::new(&cfg.exe);
                cmd.arg(&cfg.file).args(["--output_format", "srt", "--output_dir"]).arg(&cfg.outdir);
                if !cfg.model.trim().is_empty() { cmd.arg("--model").arg(cfg.model.trim()); }
                if !lang.is_empty() { cmd.arg("--language").arg(lang); }
                if cfg.translate { cmd.args(["--task", "translate"]); }
            }
        }
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).env("PYTHONUNBUFFERED", "1").env("PYTHONIOENCODING", "utf-8").creation_flags(NO_WINDOW);
        let cleanup = || if let Some(w) = &wav_tmp { let _ = fs::remove_file(w); };
        let mut child = match cmd.spawn() { Ok(c) => c, Err(e) => { cleanup(); return done(false, &format!("cannot start Whisper: {e}")) } };
        *slot.lock().unwrap() = Some(child.id());
        let (out, err) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
        let a = app.clone();
        let t = std::thread::spawn(move || { for l in BufReader::new(err).lines().map_while(Result::ok) { let _ = a.emit("whisper-log", l); } });
        for l in BufReader::new(out).lines().map_while(Result::ok) { log(&l); }
        let _ = t.join();
        let status = child.wait();
        cleanup();
        if status.map(|s| s.success()).unwrap_or(false) && srt.exists() { clean_srt(&srt); done(true, "") }
        else { done(false, if srt.exists() { "Whisper stopped before finishing" } else { "Whisper finished but no .srt was written" }) }
    });
    Ok(())
}

fn srt_time(s: &str) -> Option<f64> {
    let s = s.trim().replace(',', ".");
    let p: Vec<&str> = s.split(':').collect();
    if p.len() != 3 { return None; }
    Some(p[0].parse::<f64>().ok()? * 3600.0 + p[1].parse::<f64>().ok()? * 60.0 + p[2].parse::<f64>().ok()?)
}

fn fmt_srt(t: f64) -> String {
    let ms = (t.max(0.0) * 1000.0).round() as u64;
    format!("{:02}:{:02}:{:02},{:03}", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000)
}

/// Whisper invents short phrases over long stretches without speech (game noise, music): "I don't know." spread over 30 s,
/// often repeated. Real speech is never 1-4 words across 20+ seconds, so those cues go, as do exact repeats of the cue before.
fn clean_srt(path: &Path) {
    let Ok(t) = fs::read_to_string(path) else { return };
    let (mut out, mut n, mut last) = (String::new(), 0, String::new());
    for block in t.replace("\r\n", "\n").split("\n\n") {
        let lines: Vec<&str> = block.trim().lines().collect();
        if lines.len() < 3 { continue; }
        let Some((a, b)) = lines[1].split_once("-->") else { continue };
        let (Some(s), Some(e)) = (srt_time(a), srt_time(b)) else { continue };
        let text = lines[2..].join("\n");
        let key = text.trim().to_lowercase();
        let (d, words) = (e - s, text.split_whitespace().count() as f64);
        if key.is_empty() || key == last || (d > 20.0 && words <= 4.0) { continue; }
        last = key;
        n += 1;
        // a real line Whisper stretched over a long quiet window stays on screen only as long as it takes to read
        let timing = if d > 20.0 { format!("{} --> {}", a.trim(), fmt_srt(s + (2.0 + words * 0.6).min(d))) } else { lines[1].trim().to_string() };
        out += &format!("{n}\n{timing}\n{}\n\n", text.trim());
    }
    let _ = fs::write(path, out);
}

#[cfg(test)]
mod tests {
    #[test]
    fn clean_srt_drops_invented_lines_keeps_speech() {
        // real whisper.cpp output for 2 minutes of a League recording (announcer lines + invented "I don't know.")
        let srt = "1\n00:00:00,000 --> 00:00:10,000\n This line hasn't changed, this thing has failed.\n\n2\n00:00:16,000 --> 00:00:19,000\n An enemy has been slain.\n\n\
                   3\n00:00:30,000 --> 00:00:56,000\n Your team has destroyed the turret.\n\n4\n00:01:00,000 --> 00:01:29,980\n I don't know.\n\n\
                   5\n00:01:30,000 --> 00:01:59,980\n I don't know.\n\n";
        let p = std::env::temp_dir().join("flux-clean-srt-test.srt");
        std::fs::write(&p, srt).unwrap();
        super::clean_srt(&p);
        let out = std::fs::read_to_string(&p).unwrap();
        let _ = std::fs::remove_file(&p);
        assert!(out.contains("An enemy has been slain."));
        assert!(out.contains("this thing has failed"));
        assert!(!out.contains("I don't know"), "{out}");
        assert!(out.contains("3\n00:00:30,000 --> 00:00:35,600\n Your team has destroyed the turret.".replace("\n ", "\n").as_str()), "a real line is kept, shortened: {out}");
        assert!(out.starts_with("1\n00:00:00,000 --> 00:00:10,000\n") && out.contains("\n2\n00:00:16,000"), "renumbered: {out}");
    }
}

#[tauri::command]
fn whisper_cancel(st: State<S>) {
    if let Some(pid) = *st.whisper.lock().unwrap() {
        if pid != 0 { let _ = Command::new("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]).creation_flags(NO_WINDOW).status(); }
    }
}

/// Saves start..end of a file as a new file next to it. Returns the new file's path at once; "clip-done" {ok, out, error} follows.
/// `mode`: "copy" = no re-encoding, original quality, starts on the keyframe at or before `start` (mpv's stream recorder);
/// "exact" = re-encoded on the GPU (NVENC, x264 if that fails), frame-exact; "small" = re-encoded to stay under 10 MB (Discord).
/// `mix` > 1 mixes that many audio tracks into one (re-encoded modes only), otherwise `aid` picks the audio track.
#[tauri::command]
fn clip_export(app: AppHandle, st: State<S>, path: String, start: f64, end: f64, aid: Option<i64>, mode: Option<String>, mix: Option<u32>) -> Result<String, String> {
    if !(end - start >= 0.5) { return Err("Mark where the clip starts and ends first (L, then L again)".into()); }
    let mode = mode.unwrap_or_else(|| "copy".into());
    let exe = st.exe.lock().unwrap().clone();
    let p = Path::new(&path);
    let dir = p.parent().ok_or("no folder")?.to_path_buf();
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "clip".into());
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let ext = if mode != "copy" { "mp4".into() } else if matches!(ext.as_str(), "mp4" | "m4v" | "mov") { ext } else { "mkv".into() }; // mkv holds any codec
    let tag = if mode == "small" { " small" } else { "" };
    let t = |s: f64| { let s = s.max(0.0) as u64; format!("{:02}.{:02}.{:02}", s / 3600, s / 60 % 60, s % 60) };
    let name = |i: u32| dir.join(format!("{stem} clip {}-{}{tag}{}.{ext}", t(start), t(end), if i > 1 { format!(" ({i})") } else { String::new() }));
    let mut i = 1;
    while name(i).exists() { i += 1; }
    let out = name(i);
    let o = out.clone();
    std::thread::spawn(move || {
        let run = |c: &mut Command| -> bool {
            let ok = c.arg("--").arg(&path)
                .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
                .creation_flags(NO_WINDOW | LOW_PRIORITY).status().map(|s| s.success()).unwrap_or(false);
            ok && fs::metadata(&o).map(|m| m.len() > 1024).unwrap_or(false)
        };
        let base = |c: &mut Command| {
            c.args(["--no-config", "--really-quiet", "--no-terminal", "--no-sub", "--load-scripts=no", "--ytdl=no"])
                .arg(format!("--start={start:.3}")).arg(format!("--end={end:.3}"));
        };
        let good = if mode == "copy" {
            let mut c = Command::new(&exe);
            base(&mut c);
            // pcm to NUL instead of a sound card: nothing waits for real time, so it runs several times faster than playback
            c.args(["--vo=null", "--ao=pcm", "--ao-pcm-file=NUL", "--untimed"]).arg(format!("--stream-record={}", o.display()));
            if let Some(a) = aid { c.arg(format!("--aid={a}")); }
            run(&mut c)
        } else {
            let d = end - start;
            // small: aim at 8.6 MiB in total (NVENC overshoots a little; Discord's cap is 10 MiB), 96 kbit/s of it audio;
            // lower the resolution as the bitrate gets tight (busy game footage looks better at 720p than starved 1080p)
            let vk = ((8.6 * 8192.0 / d) as i64 - 96).clamp(250, 12_000);
            let encode = |nvenc: bool| -> bool {
                let mut c = Command::new(&exe);
                base(&mut c);
                c.args(["--hwdec=auto-copy", "--oac=aac"]).arg(format!("--o={}", o.display()));
                if mode == "small" {
                    let h = if vk < 1000 { 480 } else if vk < 4000 { 720 } else { 1080 };
                    c.arg(format!("--vf=scale=-2:{h}")).arg("--oacopts=b=96k");
                    c.arg(if nvenc { "--ovc=h264_nvenc".to_string() } else { "--ovc=libx264".to_string() });
                    c.arg(if nvenc { format!("--ovcopts=preset=p5,rc=cbr,multipass=fullres,b={vk}k,maxrate={vk}k,bufsize={vk}k") }
                          else { format!("--ovcopts=preset=veryfast,b={vk}k,maxrate={vk}k,bufsize={vk}k") });
                } else {
                    c.arg("--oacopts=b=192k");
                    c.arg(if nvenc { "--ovc=h264_nvenc" } else { "--ovc=libx264" });
                    c.arg(if nvenc { "--ovcopts=preset=p5,rc=vbr,cq=23,b=0" } else { "--ovcopts=preset=veryfast,crf=20" });
                }
                match mix {
                    Some(n) if n > 1 => { c.arg(format!("--lavfi-complex={}amix=inputs={n}:normalize=0[ao]", (1..=n).map(|i| format!("[aid{i}]")).collect::<String>())); }
                    _ => if let Some(a) = aid { c.arg(format!("--aid={a}")); },
                }
                run(&mut c)
            };
            encode(true) || { let _ = fs::remove_file(&o); encode(false) }
        };
        if !good { let _ = fs::remove_file(&o); }
        let _ = app.emit("clip-done", serde_json::json!({ "ok": good, "out": o.to_string_lossy(), "error": if good { "" } else { "mpv could not write the clip" } }));
    });
    Ok(out.to_string_lossy().into_owned())
}

/// Moves a file to the Recycle Bin (restorable from there).
#[tauri::command]
fn recycle(path: String) -> Result<(), String> {
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
fn reveal(path: String) { let _ = Command::new("explorer.exe").raw_arg(format!("/select,\"{path}\"")).spawn(); }

const MEDIA_KEYS: [(Code, &str); 4] = [
    (Code::MediaPlayPause, "playpause"), (Code::MediaTrackNext, "next"), (Code::MediaTrackPrevious, "prev"), (Code::MediaStop, "stop"),
];

/// The keyboard's media keys, also when Flux is in the background. mpv's own Windows media-session support is switched off
/// (it would send Next/Previous to its own one-file playlist), so these go to the UI, which owns the queue.
/// Returns the keys another program already owns.
#[tauri::command]
fn media_keys(app: AppHandle, on: bool) -> Vec<String> {
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

/// Plain file names (relative to `dir`) of non-hidden regular files. Symlinks are not followed.
/// A newer scan (higher id) stops an older one; id 0 is a one-off listing that neither cancels nor is cancelled.
#[tauri::command]
async fn list_dir(st: State<'_, S>, dir: String, id: u64, recursive: bool) -> Result<Vec<String>, String> {
    let scan = st.scan.clone();
    if id != 0 { scan.store(id, Ordering::SeqCst); }
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&dir);
        let mut out = Vec::new();
        let mut stack = vec![(root.clone(), 0u8)];
        while let Some((d, depth)) = stack.pop() {
            let entries = match fs::read_dir(&d) {
                Ok(r) => r,
                Err(e) if depth == 0 => return Err(e.to_string()),
                Err(_) => continue,
            };
            for e in entries.flatten() {
                if id != 0 && scan.load(Ordering::SeqCst) != id { return Err("cancelled".into()); }
                let (Ok(t), Ok(m)) = (e.file_type(), e.metadata()) else { continue };
                if m.file_attributes() & 2 != 0 { continue; } // FILE_ATTRIBUTE_HIDDEN
                let p = e.path();
                if t.is_file() {
                    if let Some(r) = p.strip_prefix(&root).ok().and_then(|r| r.to_str()) { out.push(r.to_string()); }
                } else if t.is_dir() && recursive && depth < 4 {
                    stack.push((p, depth + 1));
                }
                if out.len() >= 20_000 { return Ok(out); }
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// FLUX_DATA=<folder> runs Flux on separate settings/history (test runs), and without the single-window hand-off.
fn test_data_dir() -> Option<PathBuf> { std::env::var_os("FLUX_DATA").filter(|v| !v.is_empty()).map(PathBuf::from) }

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    match test_data_dir() { Some(d) => Ok(d), None => app.path().app_data_dir().map_err(|e| e.to_string()) }
}

fn store_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if name.contains(['/', '\\']) { return Err("bad name".into()); }
    Ok(data_dir(app)?.join(name))
}

#[tauri::command]
fn store_read(app: AppHandle, name: String) -> Result<Option<String>, String> {
    Ok(fs::read_to_string(store_path(&app, &name)?).ok())
}

#[tauri::command]
fn store_write(app: AppHandle, name: String, text: String) -> Result<(), String> {
    let p = store_path(&app, &name)?;
    fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("tmp");
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string()) // rename = a crash never leaves a half-written file
}

/// A file or folder named on a command line (double-click in Explorer, "Open with", "Play with Flux" on a folder).
fn path_arg<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    args.into_iter().skip(1).find(|a| !a.starts_with('-') && { let p = PathBuf::from(a); p.is_file() || p.is_dir() })
}

#[tauri::command]
fn initial_file() -> Option<String> { path_arg(std::env::args()) }

#[tauri::command]
fn is_dir(path: String) -> bool { Path::new(&path).is_dir() }

/// The page tells Rust whether closing the window should keep Flux in the tray.
#[tauri::command]
fn set_tray(st: State<S>, on: bool) { st.tray.store(on, Ordering::SeqCst); }

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn make_tray(app: &AppHandle) -> tauri::Result<()> {
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
fn migrate_old_data(app: &AppHandle) {
    let Ok(new) = app.path().app_data_dir() else { return };
    let old = new.with_file_name("local.player");
    if new.exists() || !old.is_dir() { return; }
    let _ = fs::create_dir_all(&new);
    if let Ok(rd) = fs::read_dir(&old) {
        for e in rd.flatten() { if e.path().is_file() { let _ = fs::copy(e.path(), new.join(e.file_name())); } }
    }
}

pub fn run() {
    let mut b = tauri::Builder::default();
    if test_data_dir().is_none() {
        // must be first: a second launch (double-click in Explorer) hands its file to the running window and exits
        b = b.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(p) = path_arg(args) { let _ = app.emit("open-file", p); }
            show_main(app); // also brings it back from the tray
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
        .setup(|app| {
            migrate_old_data(app.handle());
            early_start(app.handle());
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
                if let Some(mut c) = app.state::<S>().child.lock().unwrap().take() { let _ = c.kill(); }
            }
        });
}
