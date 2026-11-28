//! Subtitles with Whisper on this PC: finding whisper.cpp, running a job, cleaning the .srt it writes.
use super::*;

#[derive(serde::Serialize)]
pub(crate) struct FoundWhisper { exe: String, model: String, vad: String }

/// whisper.cpp already on the PC: Flux's own folder (%LOCALAPPDATA%\local.flux\whisper), then LingoReel's download.
/// Picks the best model found (large-v3-turbo first) and a Silero VAD model if one is there.
#[tauri::command]
pub(crate) fn whisper_detect(app: AppHandle) -> Option<FoundWhisper> {
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
pub(crate) struct Whisper {
    flavor: String, exe: String, model: String, lang: String, translate: bool, file: String, outdir: String, template: String,
    #[serde(default)] vad: String,
    #[serde(default)] aid: Option<i64>,
}

/// Optional, manual subtitle generation with Whisper on this PC. Returns at once; progress comes as
/// "whisper-log" lines and a final "whisper-done" {ok, srt, error}. Never overwrites a subtitle file that was already there:
/// the result is "<name>.srt", or "<name>.whisper.srt" when that exists.
#[tauri::command]
pub(crate) fn whisper_run(app: AppHandle, st: State<S>, cfg: Whisper) -> Result<(), String> {
    if cfg.exe.trim().is_empty() && cfg.flavor != "custom" { return Err("Set the Whisper program first".into()); }
    if cfg.flavor == "cpp" && cfg.translate && cfg.model.to_lowercase().contains("turbo") {
        return Err("The turbo model cannot translate: choose a large or medium model, or turn off Translate".into());
    }
    {
        let mut g = st.whisper.locked();
        if g.is_some() { return Err("Subtitles are already being generated".into()); }
        *g = Some(Job::default());
    }
    let mpv = st.exe.locked().clone();
    let slot = st.whisper.clone();
    std::thread::spawn(move || {
        let tmp = std::env::temp_dir().join(format!("flux-whisper-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let r = fs::create_dir_all(&tmp).map_err(|e| e.to_string()).and_then(|_| transcribe(&app, &slot, &cfg, &mpv, &tmp));
        let _ = fs::remove_dir_all(&tmp);
        let stopped = slot.locked().take().is_some_and(|j| j.stopped);
        let (ok, srt, err) = match r {
            Ok(srt) => { clean_srt(&srt); (true, srt.to_string_lossy().into_owned(), String::new()) }
            Err(_) if stopped => (false, String::new(), "Stopped".to_string()),
            Err(e) => (false, String::new(), e),
        };
        let _ = app.emit("whisper-done", serde_json::json!({ "ok": ok, "srt": srt, "error": err }));
    });
    Ok(())
}

/// Runs one step of a job as the job's current process (so Stop can kill it). Lines it prints become "whisper-log" events.
fn step(app: &AppHandle, slot: &Mutex<Option<Job>>, cmd: &mut Command) -> Result<bool, String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .env("PYTHONUNBUFFERED", "1").env("PYTHONIOENCODING", "utf-8").creation_flags(NO_WINDOW);
    let mut child = {
        let mut g = slot.locked();
        if g.as_ref().is_some_and(|j| j.stopped) { return Err("Stopped".into()); }
        let child = cmd.spawn().map_err(|e| format!("cannot start {:?}: {e}", cmd.get_program()))?;
        if let Some(j) = g.as_mut() { j.pid = child.id(); }
        child
    };
    let (out, err) = (child.stdout.take(), child.stderr.take());
    let a = app.clone();
    let t = std::thread::spawn(move || { if let Some(e) = err { for l in BufReader::new(e).lines().map_while(Result::ok) { let _ = a.emit("whisper-log", l); } } });
    if let Some(o) = out { for l in BufReader::new(o).lines().map_while(Result::ok) { let _ = app.emit("whisper-log", l); } }
    let _ = t.join();
    let ok = child.wait().map(|s| s.success()).unwrap_or(false);
    if let Some(j) = slot.locked().as_mut() { j.pid = 0; if j.stopped { return Err("Stopped".into()); } }
    Ok(ok)
}

fn transcribe(app: &AppHandle, slot: &Mutex<Option<Job>>, cfg: &Whisper, mpv: &str, tmp: &Path) -> Result<PathBuf, String> {
    let log = |l: &str| { let _ = app.emit("whisper-log", l.to_string()); };
    let outdir = Path::new(&cfg.outdir);
    let _ = fs::create_dir_all(outdir);
    let stem = Path::new(&cfg.file).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "subtitles".into());
    let target = outdir.join(if outdir.join(format!("{stem}.srt")).exists() { format!("{stem}.whisper.srt") } else { format!("{stem}.srt") });
    let lang = cfg.lang.trim();
    let mut cmd;
    match cfg.flavor.as_str() {
        "cpp" => { // whisper.cpp wants a 16 kHz mono wav: mpv makes one (as fast as it can decode), no ffmpeg needed
            let wav = tmp.join("audio.wav");
            log("Extracting audio…");
            let mut ex = Command::new(mpv);
            ex.args(["--no-config", "--no-video", "--vo=null", "--audio-samplerate=16000", "--audio-channels=mono", "--audio-format=s16",
                     "--ao=pcm", "--really-quiet", "--no-terminal", "--load-scripts=no"])
                .arg(format!("--ao-pcm-file={}", wav.display()));
            if let Some(a) = cfg.aid { ex.arg(format!("--aid={a}")); }
            ex.arg("--").arg(&cfg.file);
            if !step(app, slot, &mut ex)? || !wav.exists() { return Err("could not extract the audio with mpv".into()); }
            log("Transcribing on the GPU…");
            cmd = Command::new(&cfg.exe);
            cmd.arg("-m").arg(&cfg.model).arg("-f").arg(&wav).arg("-osrt").arg("-pp").arg("-of").arg(tmp.join("out"));
            cmd.arg("-l").arg(if lang.is_empty() { "auto" } else { lang }); // whisper.cpp assumes English when not told
            if cfg.translate { cmd.arg("-tr"); }
            if !cfg.vad.is_empty() && Path::new(&cfg.vad).is_file() { cmd.arg("--vad").arg("-vm").arg(&cfg.vad); } // skip non-speech
        }
        "custom" => { // {file} {outdir} {stem} {lang} {model} are replaced; {outdir} is a scratch folder, the .srt is moved next to the video
            let line = fill(&cfg.template, &[("{file}", &cfg.file, true), ("{outdir}", &tmp.to_string_lossy(), true), ("{stem}", &stem, true),
                ("{lang}", lang, false), ("{model}", &cfg.model, false)]);
            cmd = Command::new("cmd");
            cmd.raw_arg(format!("/C \"{line}\""));
        }
        _ => { // openai-whisper, whisper-ctranslate2, faster-whisper-xxl: the same command line
            cmd = Command::new(&cfg.exe);
            cmd.arg(&cfg.file).args(["--output_format", "srt", "--output_dir"]).arg(tmp);
            if !cfg.model.trim().is_empty() { cmd.arg("--model").arg(cfg.model.trim()); }
            if !lang.is_empty() { cmd.arg("--language").arg(lang); }
            if cfg.translate { cmd.args(["--task", "translate"]); }
        }
    }
    let ok = step(app, slot, &mut cmd)?;
    // whatever the program called its .srt (each names it differently), it is the one in the scratch folder
    let made = fs::read_dir(tmp).ok().and_then(|d| d.flatten().map(|e| e.path()).find(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("srt"))));
    match made {
        Some(p) if ok => { fs::copy(&p, &target).map_err(|e| format!("could not save {}: {e}", target.display()))?; Ok(target) }
        Some(_) => Err("Whisper stopped before finishing".into()),
        None => Err(if ok { "Whisper finished but wrote no .srt" } else { "Whisper failed (see the log under Whisper setup)" }.into()),
    }
}
/// Puts values into the user's command line (run by cmd). File names can hold `&` and spaces, so a name placeholder
/// the template didn't quote is quoted here: a downloaded file's name must never become a command.
pub(crate) fn fill(template: &str, values: &[(&str, &str, bool)]) -> String {
    let (mut out, mut rest, mut quoted) = (String::new(), template, false);
    while let Some(c) = rest.chars().next() {
        if let Some((key, value, is_name)) = values.iter().find(|v| rest.starts_with(v.0)) {
            let wrap = *is_name && !quoted && value.contains([' ', '&', '|', '^', '<', '>', '(', ')', ',', ';', '=']);
            if wrap { out.push('"'); }
            out.push_str(value);
            if wrap { out.push('"'); }
            rest = &rest[key.len()..];
        } else {
            quoted ^= c == '"';
            out.push(c);
            rest = &rest[c.len_utf8()..];
        }
    }
    out
}

pub(crate) fn srt_time(s: &str) -> Option<f64> {
    let s = s.trim().replace(',', ".");
    let p: Vec<&str> = s.split(':').collect();
    if p.len() != 3 { return None; }
    Some(p[0].parse::<f64>().ok()? * 3600.0 + p[1].parse::<f64>().ok()? * 60.0 + p[2].parse::<f64>().ok()?)
}

pub(crate) fn fmt_srt(t: f64) -> String {
    let ms = (t.max(0.0) * 1000.0).round() as u64;
    format!("{:02}:{:02}:{:02},{:03}", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000)
}

/// Whisper invents short phrases over long stretches without speech (game noise, music): "I don't know." spread over 30 s,
/// often repeated. Real speech is never 1-4 words across 20+ seconds, so those cues go, as do exact repeats of the cue before.
pub(crate) fn clean_srt(path: &Path) {
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
    fn file_names_cannot_become_commands() {
        let v = [("{file}", r"D:\a & calc.mkv", true), ("{lang}", "", false)];
        assert_eq!(super::fill("w {file} -l {lang}", &v), r#"w "D:\a & calc.mkv" -l "#);
        assert_eq!(super::fill(r#"w "{file}""#, &v), r#"w "D:\a & calc.mkv""#, "already quoted");
        assert_eq!(super::fill("w {file}", &[("{file}", r"D:\a.mkv", true)]), r"w D:\a.mkv");
    }

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

/// Stop: kills whatever the job is running right now (audio extraction or the transcriber, with its child processes).
#[tauri::command]
pub(crate) fn whisper_cancel(st: State<S>) {
    let mut g = st.whisper.locked();
    let Some(j) = g.as_mut() else { return };
    j.stopped = true;
    if j.pid != 0 { let _ = Command::new("taskkill").args(["/F", "/T", "/PID", &j.pid.to_string()]).creation_flags(NO_WINDOW).status(); }
}