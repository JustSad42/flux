# Flux

Windows media player (Tauri 2 + TypeScript + mpv). Docs: [README.md](README.md). Renamed from "Player" 2026-11-20 (old data folder `local.player` is migrated).
Until 1.0 it was written on a server and built over `ssh winpc` ([pc-tools/README.md](pc-tools/README.md)); since 1.1 (2026-11-23) it is built and tested directly on the PC.

- Brief (user): player-first, NOT a library app. No posters, catalog, indexing or DB. Priority: fast open, reliable playback, folder queue.
- Pure logic with tests (`npm test`, tsx): `src/queue/match.ts` (names, `discover`), `queue.ts`, `src/media/subs.ts` (subtitle matching), `src/media/markers.ts` (intro/outro, chapter nav, resume). Change them test-first.
- `src/main.ts` is the whole UI. The native mpv window covers `#video`; anything drawn over the picture must be a `.float` element shown with `setFloat()`, which makes `syncRect()` cut a (rounded) hole in mpv's window under it. A transparent web view does NOT work (Windows clips the sibling video window: the desktop shows through). Floats must be opaque.
- Opened with a file, Rust starts mpv in `setup()` (`early_start`) using the saved `input.conf`, settings and resume position; the page then `adopt()`s it and holds mpv events until it has (`holding`).
- User decisions (2026-11-23): controls float and auto-hide; hover preview instead of a filmstrip; Whisper auto-detect language; extras = clip export, Recycle Bin, frame step/slow-mo.
- Whisper on this PC: whisper.cpp CUDA build + ggml-large-v3-turbo hard-linked from LingoReel into `%LOCALAPPDATA%\local.flux\whisper` (needs the cudart/cublas DLLs too, else it silently runs on the CPU). whisper.cpp defaults to English: always pass `-l`.
- Test copies: `FLUX_DATA` + own `WEBVIEW2_USER_DATA_FOLDER` (see README Testing). Tell the user before a test window appears; capture with PrintWindow when the window is not in front.
- mpv keys go through `input.conf` → `script-message act <name>` → `act()`; the `KEYS` table feeds both mpv and the page. mpv's own media session is off (`--media-controls=no`); media keys are Rust global hotkeys → `media-key` event.
- mpv IPC is ONE pipe handle (mpv sends replies/events only to the client that asked), read by polling `PeekNamedPipe` so writes never block.
- Child processes started from the GUI must get `Stdio::null()` for stdin (no console to inherit) or mpv can hang.
- Interpretation of the brief: the queue shows the full sorted run with the playing file marked (so Previous works), not the playing file first.
- Public repo `JustSad42/flux`; `.\release.ps1 <version> "notes"` builds, signs and publishes (README → Release). Updater key `~\.tauri\flux.key` stays off the repo. `tools/` and `pc-tools/` (screenshots, logs, PC paths) are git-ignored and must never be published.
- `src-tauri/src/flux.lua` runs inside mpv: mouse height → `act mouse <0..1>` (bar stays up near the bottom), click vs drag (pan when zoomed), Ctrl+wheel zoom. mpv needs `--window-dragging=no`, or a held click starts mpv's own window drag and the script never sees the drag. `keypress` from the pipe arrives as a single "press" event, real clicks as down/up.
- One floating menu (`#menu`, `openMenu(anchor, items)`) serves speed, audio and clip modes.
- Decisions 2026-11-23 (1.2): offline translation skipped (no NLLB/Marian model on disk, user declined a download); updates from the public repo.
