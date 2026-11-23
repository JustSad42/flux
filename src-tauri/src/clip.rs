//! Saving the marked part of a file as a clip.
use super::*;

/// Saves start..end of a file as a new file next to it. Returns the new file's path at once; "clip-done" {ok, out, error} follows.
/// `mode`: "copy" = no re-encoding, original quality, starts on the keyframe at or before `start` (mpv's stream recorder);
/// "exact" = re-encoded on the GPU (NVENC, x264 if that fails), frame-exact; "small" = re-encoded to stay under 10 MB (Discord).
/// `mix` > 1 mixes that many audio tracks into one (re-encoded modes only), otherwise `aid` picks the audio track.
#[derive(serde::Deserialize)]
pub(crate) struct Clip {
    path: String, start: f64, end: f64,
    #[serde(default)] aid: Option<i64>,
    #[serde(default)] mode: Option<String>,
    #[serde(default)] mix: Option<u32>,
}

#[tauri::command]
pub(crate) fn clip_export(app: AppHandle, st: State<S>, req: Clip) -> Result<String, String> {
    let Clip { path, start, end, aid, mode, mix } = req;
    if !(end - start).is_finite() || end - start < 0.5 { return Err("Mark where the clip starts and ends first (L, then L again)".into()); }
    let mode = mode.unwrap_or_else(|| "copy".into());
    let exe = st.exe.locked().clone();
    if exe.is_empty() { return Err("mpv is not running".into()); }
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
            let ok = quiet(c.arg("--").arg(&path), true).status().map(|s| s.success()).unwrap_or(false);
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
