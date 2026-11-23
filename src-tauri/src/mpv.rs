//! mpv: finding it, the child window it draws into, starting it (early or from the page), and its JSON pipe.
use super::*;

/// Custom path from Settings (file or folder), else the mpv bundled with the installer, else mpv on PATH, else the usual install folders (winget does not put mpv on PATH).
pub(crate) fn find_mpv(custom: &str) -> String {
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

pub(crate) fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain([0]).collect() }

/// STATIC + SS_BLACKRECT (0x4): a plain black child window for mpv to draw into.
pub(crate) fn make_host(parent: isize, x: i32, y: i32, w: i32, h: i32, visible: bool) -> Result<isize, String> {
    let style = WS_CHILD | WS_CLIPSIBLINGS | 0x4 | if visible { WS_VISIBLE } else { 0 };
    let hwnd = unsafe {
        CreateWindowExW(0, wide("STATIC").as_ptr(), std::ptr::null(), style, x, y, w, h, parent as _, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null())
    } as isize;
    if hwnd == 0 { Err("CreateWindowExW failed".into()) } else { Ok(hwnd) }
}

/// Must run on the main thread (sync command): the window needs the UI thread's message loop.
/// Reuses the window made at start-up when mpv was started early.
#[tauri::command]
pub(crate) fn host_create(win: WebviewWindow, st: State<S>, x: i32, y: i32, w: i32, h: i32) -> Result<isize, String> {
    let mut g = st.host.locked();
    if *g != 0 { return Ok(*g); }
    let parent = win.hwnd().map_err(|e| e.to_string())?.0 as isize;
    *g = make_host(parent, x, y, w, h, false)?;
    Ok(*g)
}

/// Places the video window over #video (and on top of the web view). `cuts` are [x, y, w, h, radius] holes (window pixels)
/// where the page's controls float over the picture: the web view underneath shows through while the video keeps its size.
#[tauri::command]
pub(crate) fn host_rect(st: State<S>, x: i32, y: i32, w: i32, h: i32, show: bool, cuts: Vec<[i32; 5]>) {
    let hwnd = *st.host.locked();
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

pub(crate) fn mpv_log() -> PathBuf { std::env::temp_dir().join("flux-mpv.log") }
pub(crate) fn pipe_name() -> String { format!(r"\\.\pipe\flux-{}", std::process::id()) }

pub(crate) fn mpv_command(exe: &str, host: isize, conf: &Path) -> Command {
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
        .arg(format!("--log-file={}", mpv_log().display()));
    quiet(&mut c, false);
    c
}

/// Waits for mpv's control pipe. On failure the end of mpv's log goes into the error.
pub(crate) fn connect(mut child: Child, exe: &str) -> Started {
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
/// Polls every 3 ms while mpv is talking, backing off to 12 ms after a quiet half second (an idle player wakes ~80×/s, not 250×).
/// When mpv goes away (crash, killed) the pipe and process are dropped so `mpv_start` can start a new one; the page does that on "shutdown".
pub(crate) fn start_reader(app: AppHandle, shared: Arc<Mutex<Option<File>>>, child: Arc<Mutex<Option<Child>>>) {
    std::thread::spawn(move || {
        let (mut buf, mut chunk, mut quiet_ms) = (Vec::<u8>::new(), [0u8; 8192], 0u64);
        // mpv reports time-pos on every video frame (60+ a second); each event handed to the page has a real cost there,
        // and the page draws the time ~8×/s anyway. So at most one every 100 ms, always the newest one.
        let (mut held_pos, mut pos_at): (Option<String>, Option<Instant>) = (None, None);
        let mut pass_pos = |line: Option<String>, held: &mut Option<String>| {
            if let Some(l) = line { *held = Some(l); }
            if held.is_some() && pos_at.is_none_or(|t| t.elapsed() >= Duration::from_millis(100)) {
                pos_at = Some(Instant::now());
                let _ = app.emit("mpv", held.take().unwrap());
            }
        };
        'run: loop {
            let n = {
                let mut g = shared.locked();
                let Some(f) = g.as_mut() else { break 'run };
                let mut avail = 0u32;
                if unsafe { PeekNamedPipe(f.as_raw_handle() as _, std::ptr::null_mut(), 0, std::ptr::null_mut(), &mut avail, std::ptr::null_mut()) } == 0 { break 'run; }
                if avail == 0 { 0 } else {
                    match f.read(&mut chunk[..(avail as usize).min(8192)]) { Ok(n) if n > 0 => n, _ => break 'run }
                }
            };
            if n == 0 {
                pass_pos(None, &mut held_pos);
                let wait = if quiet_ms < 500 { 3 } else { 12 };
                std::thread::sleep(Duration::from_millis(wait));
                quiet_ms += wait;
                continue;
            }
            quiet_ms = 0;
            buf.extend_from_slice(&chunk[..n]);
            while let Some(i) = buf.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = buf.drain(..=i).collect();
                let line = String::from_utf8_lossy(&line).trim_end().to_string();
                if line.contains(r#""name":"time-pos""#) && line.contains("property-change") { pass_pos(Some(line), &mut held_pos); }
                else { let _ = app.emit("mpv", line); }
            }
        }
        *shared.locked() = None;
        if let Some(mut c) = child.locked().take() { let _ = c.kill(); let _ = c.wait(); }
        let _ = app.emit("mpv", r#"{"event":"shutdown"}"#);
    });
}

/// Connects the page to mpv. Returns the file mpv is already opening when it was started early (see `early_start`).
/// The key bindings are kept in the data folder so the next early start can use them.
#[tauri::command]
pub(crate) async fn mpv_start(app: AppHandle, st: State<'_, S>, host: isize, input_conf: String, mpv_path: String) -> Result<Option<String>, String> {
    if st.pipe.locked().is_some() { return Ok(None); }
    let conf = data_dir(&app)?.join("input.conf");
    let early = st.early.locked().take();
    let (started, preloaded) = match early {
        Some((h, file)) => {
            let r = tauri::async_runtime::spawn_blocking(move || h.join().unwrap_or_else(|_| Err("mpv start-up failed".into())))
                .await.map_err(|e| e.to_string())?;
            let _ = fs::write(&conf, &input_conf);
            (r, Some(file))
        }
        None => {
            let exe = find_mpv(&mpv_path);
            *st.exe.locked() = exe.clone();
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
    *st.child.locked() = Some(child);
    *st.pipe.locked() = Some(io);
    start_reader(app.clone(), st.pipe.clone(), st.child.clone());
    Ok(preloaded)
}

/// mpv started by `pre_start`, before Tauri existed: its window (inside a hidden stand-in parent), the connection being made, the file.
pub(crate) struct Early { stand_in: isize, host: isize, exe: String, conn: JoinHandle<Started>, file: String }

/// Opened with a file (double-click in Explorer): start mpv on it at the very top of `run()`, at the saved volume and resume
/// position, so it opens and decodes the file while Tauri and WebView2 are still starting (~250 ms sooner than waiting for
/// Flux's window). mpv needs a window to draw into from the start, so it gets one inside a hidden stand-in, and `adopt_early`
/// moves that window into Flux's once it exists. Needs the key bindings saved by an earlier run; otherwise the page starts mpv.
pub(crate) fn pre_start() -> Option<Early> {
    let file = initial_file().filter(|f| Path::new(f).is_file())?;
    // Tauri's data folder for the identifier local.flux, before Tauri can tell us
    let dir = test_data_dir().or_else(|| std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("local.flux")))?;
    let conf = dir.join("input.conf");
    if !conf.is_file() { return None; }
    let read = |n: &str| fs::read_to_string(dir.join(n)).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).unwrap_or_default();
    let (set, hist) = (read("settings.json"), read("history.json"));
    let h = &hist[file.replace('/', "\\").to_lowercase().as_str()];
    let (pos, dur) = (h["pos"].as_f64().unwrap_or(0.0), h["dur"].as_f64().unwrap_or(0.0));
    // the same rule as resumeStart() in src/media/markers.ts
    let start = if pos < 15.0 || (dur > 0.0 && pos >= dur - 30f64.max(dur * 0.03)) { 0.0 } else { (pos - 3.0).max(0.0) };
    let stand_in = unsafe {
        CreateWindowExW(WS_EX_TOOLWINDOW, wide("STATIC").as_ptr(), std::ptr::null(), WS_POPUP, 0, 0, 1280, 720,
            std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null())
    } as isize;
    if stand_in == 0 { return None; }
    let give_up = || { unsafe { DestroyWindow(stand_in as _) }; None };
    let Ok(host) = make_host(stand_in, 0, 0, 1280, 720, true) else { return give_up() };
    let exe = find_mpv(set["mpvPath"].as_str().unwrap_or(""));
    let mut cmd = mpv_command(&exe, host, &conf);
    cmd.arg(format!("--volume={}", set["volume"].as_f64().unwrap_or(100.0)));
    if start > 0.0 { cmd.arg(format!("--start={start:.2}")); }
    cmd.arg("--").arg(&file);
    let Ok(child) = cmd.spawn() else { return give_up() }; // the page starts mpv the normal way and reports the error
    let e = exe.clone();
    let conn = std::thread::spawn(move || connect(child, &e));
    Some(Early { stand_in, host, exe, conn, file })
}

/// In `setup()`, once Flux's window exists: mpv's window moves into it, filling it until the page places it over #video.
pub(crate) fn adopt_early(app: &AppHandle, e: Early) {
    let st = app.state::<S>();
    if let Some(parent) = app.get_webview_window("main").and_then(|w| w.hwnd().ok()) {
        let mut rc: RECT = unsafe { std::mem::zeroed() };
        unsafe {
            GetClientRect(parent.0 as _, &mut rc);
            SetParent(e.host as _, parent.0 as _);
            SetWindowPos(e.host as _, std::ptr::null_mut(), 0, 0, rc.right.max(1), rc.bottom.max(1), SWP_NOACTIVATE | SWP_SHOWWINDOW);
        }
        *st.host.locked() = e.host;
    }
    unsafe { DestroyWindow(e.stand_in as _) }; // its child has moved out (or, without a window, goes with it and mpv falls back)
    *st.exe.locked() = e.exe;
    *st.early.locked() = Some((e.conn, e.file));
}

#[tauri::command]
pub(crate) fn mpv_cmd(st: State<S>, line: String) -> Result<(), String> {
    let mut g = st.pipe.locked();
    let f = g.as_mut().ok_or("mpv is not running")?;
    writeln!(f, "{line}").map_err(|e| e.to_string())
}
