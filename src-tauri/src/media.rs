//! Folder listing, durations and timeline thumbnails (all cancellable by a newer request).
use super::*;

/// MP4/MOV duration straight from the `mvhd` box (milliseconds per file instead of starting mpv). Recorders often write
/// the index at the end, so top-level boxes are skipped by size rather than read.
pub(crate) fn mp4_duration(path: &str) -> Option<f64> {
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
        (size >= hdr && size <= len - at).then_some((size, kind, hdr)) // a damaged size must not wrap or loop
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
pub(crate) async fn probe_durations(app: AppHandle, st: State<'_, S>, paths: Vec<String>, id: u64) -> Result<(), String> {
    let probe = st.probe.clone();
    probe.store(id, Ordering::SeqCst);
    let exe = st.exe.locked().clone();
    tauri::async_runtime::spawn_blocking(move || {
        for p in paths {
            if probe.load(Ordering::SeqCst) != id { return; }
            let d = mp4_duration(&p).or_else(|| {
                if exe.is_empty() { return None; }
                let out = Command::new(&exe)
                    .args(["--no-config", "--vo=null", "--ao=null", "--no-terminal", "--really-quiet", "--frames=1", "--load-scripts=no",
                           "--term-playing-msg=DUR=${=duration}", "--"])
                    .arg(&p)
                    .stdin(Stdio::null()).stderr(Stdio::null())
                    .creation_flags(NO_WINDOW | LOW_PRIORITY)
                    .output(); // stdout is read: that is where the duration line goes
                let text = out.map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
                text.lines().find_map(|l| l.strip_prefix("DUR=")).and_then(|v| v.trim().parse::<f64>().ok())
            });
            if let Some(d) = d { let _ = app.emit("dur", serde_json::json!({ "path": p, "dur": d })); }
        }
    })
    .await
    .map_err(|e| e.to_string())
}

pub(crate) fn fnv(s: &str) -> u64 { s.bytes().fold(0xcbf29ce484222325, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3)) }

/// Frame indexes coarse to fine: the middle, then the quarters, eighths… so the hover preview is usable after a few frames.
pub(crate) fn coarse_to_fine(n: usize) -> Vec<usize> {
    let (mut order, mut seen) = (Vec::with_capacity(n), vec![false; n]);
    let mut step = n.next_power_of_two();
    while step >= 1 {
        for i in (step / 2..n).step_by(step) { if !seen[i] { seen[i] = true; order.push(i); } }
        step /= 2;
    }
    order.extend((0..n).filter(|&i| !seen[i])); // n = 1 (step 1 starts at 0) is the only case that leaves any
    order
}

/// One file's thumbnail job, shared by its worker threads.
struct Thumbs { id: u64, gen: Arc<AtomicU64>, work: Mutex<VecDeque<usize>>, dir: PathBuf, exe: String, path: String, dur: f64, n: usize, app: AppHandle }

/// Timeline thumbnails: `n` frames spread over the file, coarse to fine, cached on disk (newest 300 files).
/// Emits "thumb" {id, idx, data} with a JPEG data URL. A newer call stops an older one; n = 0 just stops the running job.
#[tauri::command]
pub(crate) async fn make_thumbs(app: AppHandle, st: State<'_, S>, path: String, dur: f64, n: usize, id: u64) -> Result<(), String> {
    let gen = st.thumb.clone();
    gen.store(id, Ordering::SeqCst);
    let exe = st.exe.locked().clone();
    if exe.is_empty() || n == 0 || dur <= 0.0 { return Ok(()); }
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("thumbs");
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    let dir = cache.join(format!("{:016x}", fnv(&format!("{path}|{}|{:?}", meta.len(), meta.modified().ok()))));
    tauri::async_runtime::spawn_blocking(move || {
        let _ = fs::create_dir_all(&dir);
        if let Ok(rd) = fs::read_dir(&cache) {
            let mut all: Vec<_> = rd.flatten().filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path()))).collect();
            all.sort();
            for (_, p) in all.iter().take(all.len().saturating_sub(300)) { let _ = fs::remove_dir_all(p); }
        }
        let job = Arc::new(Thumbs { id, gen, work: Mutex::new(coarse_to_fine(n).into()), dir, exe, path, dur, n, app });
        // a few mpv processes at once (each only decodes one keyframe): previews fill in several times sooner
        let workers: Vec<_> = (0..4).map(|_| { let job = job.clone(); std::thread::spawn(move || thumb_worker(&job)) }).collect();
        for w in workers { let _ = w.join(); }
    })
    .await
    .map_err(|e| e.to_string())
}

fn thumb_worker(j: &Thumbs) {
    while j.gen.load(Ordering::SeqCst) == j.id {
        let Some(idx) = j.work.locked().pop_front() else { return };
        let f = j.dir.join(format!("{idx}-{}.jpg", j.n));
        if !f.exists() {
            let tmp = j.dir.join(format!("t{idx}"));
            let _ = fs::remove_dir_all(&tmp);
            let _ = fs::create_dir_all(&tmp);
            let t = j.dur * (idx as f64 + 0.5) / j.n as f64;
            let _ = quiet(&mut Command::new(&j.exe), true)
                .args(["--no-config", "--no-audio", "--no-sub", "--vo=image", "--vo-image-format=jpg", "--vo-image-jpeg-quality=72",
                       "--frames=1", "--hr-seek=no", "--vf=scale=320:-2", "--really-quiet", "--no-terminal", "--load-scripts=no", "--ytdl=no"])
                .arg(format!("--start={t:.2}"))
                .arg(format!("--vo-image-outdir={}", tmp.display()))
                .arg("--").arg(&j.path)
                .status();
            if let Some(first) = fs::read_dir(&tmp).ok().and_then(|d| d.flatten().next()) { let _ = fs::rename(first.path(), &f); }
            let _ = fs::remove_dir_all(&tmp);
        }
        if let Ok(bytes) = fs::read(&f) {
            let data = format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes));
            let _ = j.app.emit("thumb", serde_json::json!({ "id": j.id, "idx": idx, "data": data }));
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn thumbs_coarse_to_fine_covers_every_frame_once() {
        for n in [1, 2, 3, 16, 17, 120] {
            let o = super::coarse_to_fine(n);
            let mut s = o.clone(); s.sort(); s.dedup();
            assert_eq!(s, (0..n).collect::<Vec<_>>(), "n={n}");
            assert_eq!(o.len(), n);
        }
        assert_eq!(&super::coarse_to_fine(16)[..3], &[8, 4, 12]);
    }
}
/// Plain file names (relative to `dir`) of non-hidden regular files. Symlinks are not followed.
/// A newer scan (higher id) stops an older one; id 0 is a one-off listing that neither cancels nor is cancelled.
#[tauri::command]
pub(crate) async fn list_dir(st: State<'_, S>, dir: String, id: u64, recursive: bool) -> Result<Vec<String>, String> {
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
