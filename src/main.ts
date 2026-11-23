import './style.css';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open as pick } from '@tauri-apps/plugin-dialog';
import { check as checkForUpdate } from '@tauri-apps/plugin-updater';
import { getVersion } from '@tauri-apps/api/app';
import { Queue, pkey } from './queue/queue';
import { base, dirname, discover, join, kindOf, natCompare, parse, Opts } from './queue/match';
import { isSub, pickSubs, SubCand } from './media/subs';
import { bandAt, Band, Chap, chapterTarget, Learned, markersFor, resumeStart } from './media/markers';
import { paintIcons } from './icons';

const DEF = {
  v: 0, // settings version, see migrate()
  autoQueue: true, sensitivity: 'balanced' as Opts['sensitivity'], scanSubfolders: false, sameCategory: true, wholeFolder: true,
  autoplayNext: true, includeAll: false, rememberQueue: false, maxAuto: 200, mpvPath: '', volume: 100, hideAfter: 3,
  autoSkip: 'ask' as 'off' | 'ask' | 'auto', mediaKeys: true, autoSubs: true, subLang: 'eng', thumbnails: true,
  // Whisper: wAuto = these were filled in from what Flux found on the PC (and may be refreshed); false once edited by hand
  wFlavor: 'cpp', wExe: '', wModel: '', wLang: '', wTranslate: false, wTemplate: '', wVad: '', wAuto: true,
  wVadOn: false, // speech detection: great for talking, but drops real lines in game audio, so it is opt-in
  subScale: 1, subPos: 100, subBox: false, normalize: false, keepInTray: true, clipMode: 'copy' as 'copy' | 'exact' | 'small',
};
type Settings = typeof DEF;
type Hist = Record<string, { pos: number; dur: number; at: number; p?: string }>; // p = path with its original case
type Prefs = Record<string, Learned & { a?: string; s?: string; mix?: boolean }>; // per show (or folder): audio/subtitle language, mix all audio tracks, learned intro/outro

let S: Settings = { ...DEF };
let hist: Hist = {};
let prefs: Prefs = {};
let q = new Queue();
let pos = 0, dur = 0, paused = true, loaded = false, ready = false, modal = false, speedNow = 1;
let histDirty = false, setDirty = false, scanGen = 0, errStreak = 0, seeking = false, lastUi = 0;
let probeGen = 0, probeTimer = 0, renderTimer = 0, msgTimer = 0, idleTimer = 0, thumbTimer = 0, overBar = false;
let chapters: Chap[] = [], bands: Band[] = [], tracks: any[] = [], subCands: (SubCand & { full: string })[] = [];
let thumbGen = 0, thumbFor = '', thumbs: string[] = [], thumbN = 0, accentDone = false, curChap = -1, lastPlayIcon = '';
let abA: number | null = null, abB: number | null = null, recycleArm = '', recycleTimer = 0;
let booted = false, preloading = false, holding = true, applyPrefs: { a?: string; s?: string } | null = null;
let nearBottom = false, mixing = false, seekBusy = false, seekWant: number | null = null, seekWasPaused = false, subDelay = 0;
const held: any[] = []; // mpv events that arrive while the page is still starting up
let tab: 'queue' | 'chapters' | 'subs' = 'queue';
const skipDone = new Set<string>();
const durs: Record<string, number> = {}; // durations read in the background, before a file has ever played
const dur0 = (path: string) => durs[pkey(path)] ?? hist[pkey(path)]?.dur;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const rd = async (n: string) => { try { const t = await invoke<string | null>('store_read', { name: n }); return t ? JSON.parse(t) : null; } catch { return null; } };
const wr = (n: string, v: unknown) => { invoke('store_write', { name: n, text: JSON.stringify(v) }).catch(() => {}); };
const send = (...command: unknown[]) => invoke('mpv_cmd', { line: JSON.stringify({ command }) }).catch(e => toast(String(e)));
const osd = (t: string) => send('show-text', t, 1500);
const fmt = (s: number) => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
const opts = (all = false): Opts => ({ sensitivity: S.sensitivity, sameCategory: S.sameCategory, includeAll: all || S.includeAll, max: S.maxAuto, wholeFolder: S.wholeFolder });
const seriesKey = (path: string) => parse(path)?.series || pkey(dirname(path));
const prettyName = (path: string) => {
  const stem = base(path).replace(/\.[^.]+$/, ''), t = stem.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t || stem;
};
const sleepMs = (ms: number) => new Promise(r => setTimeout(r, ms));

let reqId = 100;
const waiting = new Map<number, (v: any) => void>();
/** Send an mpv command and wait for its answer (null on error or after 2 s). */
const ask = (...command: unknown[]) => new Promise<any>(res => {
  const id = ++reqId;
  waiting.set(id, res);
  setTimeout(() => { if (waiting.delete(id)) res(null); }, 2000);
  invoke('mpv_cmd', { line: JSON.stringify({ command, request_id: id }) }).catch(() => { if (waiting.delete(id)) res(null); });
});

// ---- floating overlays ----
// mpv's native window sits on top of the page, so anything drawn over the picture needs a hole cut into that window.
// Every visible `.float.on` element gets one (rounded like the element); the video itself never changes size.
let rectQueued = false;
function syncRect() {
  if (rectQueued) return;
  rectQueued = true;
  requestAnimationFrame(() => { rectQueued = false; placeHost(); });
}
function placeHost() {
  if (!booted) return;
  const v = $('video').getBoundingClientRect(), d = devicePixelRatio, show = (loaded || preloading) && !modal;
  const cuts: number[][] = [];
  if (show) document.querySelectorAll<HTMLElement>('#video .float.on').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    const rad = Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, r.width / 2, r.height / 2);
    cuts.push([Math.floor((r.left - v.left) * d), Math.floor((r.top - v.top) * d), Math.ceil(r.width * d) + 1, Math.ceil(r.height * d) + 1, Math.round(rad * d)]);
  });
  invoke('host_rect', { x: Math.round(v.left * d), y: Math.round(v.top * d), w: Math.round(v.width * d), h: Math.round(v.height * d), show, cuts }).catch(() => {});
}
function setFloat(el: HTMLElement, on: boolean) {
  el.classList.toggle('on', on);
  syncRect();
}
new ResizeObserver(syncRect).observe($('video'));
new ResizeObserver(syncRect).observe($('bar'));

/** Short message floating at the top, optionally with one action button (e.g. "Start over"). */
function toast(text: string, action?: { label: string; fn: () => void }, ms = 6000) {
  $('msg').textContent = text;
  const b = $('msgact') as HTMLButtonElement;
  b.hidden = !action; $('toast').classList.toggle('act', !!action);
  if (action) { b.textContent = action.label; b.onclick = () => { action.fn(); toast(''); }; }
  clearTimeout(msgTimer);
  setFloat($('toast'), !!text);
  if (text) msgTimer = window.setTimeout(() => toast(''), ms);
}

// ---- controls hide when the mouse is still ----
function wake() {
  if (!loaded) return;
  if (!$('bar').classList.contains('on')) { document.body.classList.remove('idle'); setFloat($('bar'), true); ui(); }
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(doze, Math.max(1, S.hideAfter) * 1000);
}
function doze() {
  // stays up while the pointer is on the controls, near the bottom edge (also in fullscreen), dragging, or a menu is open
  if (overBar || nearBottom || seeking || modal || $('menu').classList.contains('on')) { idleTimer = window.setTimeout(doze, 500); return; }
  document.body.classList.add('idle');
  setFloat($('bar'), false); hidePreview();
}
$('bar').onmouseenter = () => { overBar = true; };
$('bar').onmouseleave = () => { overBar = false; wake(); };
addEventListener('mousemove', () => wake());

// ---- playback ----
function markLoaded() {
  if (loaded) return;
  loaded = true; document.documentElement.classList.add('loaded'); syncRect();
}
/** Nothing left to play: back to the start screen. */
function unload() {
  loaded = false; ready = false; preloading = false;
  document.documentElement.classList.remove('loaded'); document.body.classList.remove('playing');
  setFloat($('bar'), false); hidePreview(); setFloat($('skip'), false);
  getCurrentWindow().setTitle('Flux').catch(() => {});
  renderRecent(); syncRect();
}
function resetFile() {
  flushHist();
  ready = false; pos = 0; dur = 0; chapters = []; bands = []; tracks = []; subCands = []; curChap = -1;
  skipDone.clear(); thumbFor = ''; thumbs = []; thumbN = 0; accentDone = false; clearTimeout(thumbTimer);
  invoke('make_thumbs', { path: '', dur: 0, n: 0, id: ++thumbGen }).catch(() => {}); // stops the previous file's job
  abA = abB = null; renderAB();
  $('bands').replaceChildren(); $('ticks').replaceChildren(); hidePreview();
  renderChapters(); renderSubs(); ui();
}
async function load(path: string) {
  resetFile();
  const r = resumeStart(hist[pkey(path)]);
  markLoaded();
  const pf = prefs[seriesKey(path)], lang = /^[a-z]{2,3}(-[a-z]+)?$/i;
  const o = [`start=${r.start}`, 'ab-loop-a=no', 'ab-loop-b=no', pf?.a && lang.test(pf.a) ? `alang=${pf.a}` : '',
    pf?.s === 'no' ? 'sid=no' : pf?.s && lang.test(pf.s) ? `slang=${pf.s}` : ''].filter(Boolean).join(',');
  // a mix of N audio tracks must not outlive the file it was made for (the next one may have fewer); onLoaded sets it again
  if (mixing) { mixing = false; send('set_property', 'lavfi-complex', ''); }
  send('set_property', 'sub-delay', 0);
  await send('loadfile', path, 'replace', -1, o);
  nowPlaying(path);
  if (r.start > 0) toast(`Resumed at ${fmt(r.start + 3)}`, { label: 'Start over', fn: () => send('seek', 0, 'absolute') });
}
function nowPlaying(path: string) {
  getCurrentWindow().setTitle(base(path) + ' – Flux').catch(() => {});
  $('ntitle').textContent = prettyName(path);
  changed(); wake();
}
/** mpv was started on this file before the page loaded (double-click in Explorer): take it over without reloading it. */
function adopt(path: string) {
  resetFile();
  q.open(path); scanGen++;
  const r = resumeStart(hist[pkey(path)]);
  markLoaded();
  nowPlaying(path);
  if (r.start > 0) toast(`Resumed at ${fmt(r.start + 3)}`, { label: 'Start over', fn: () => send('seek', 0, 'absolute') });
  const pf = prefs[seriesKey(path)];
  applyPrefs = pf?.a || pf?.s ? { a: pf.a, s: pf.s } : null; // applied to the tracks once mpv reports them (onLoaded)
  if (S.autoQueue && kindOf(path)) scan(path, false);
}
function play(i: number) { if (i < 0) return; q.jump(i); const c = q.current; if (c) load(c.path); }
function goNext(): boolean { const i = q.nextIndex(); if (i < 0) return false; play(i); return true; }
function goPrev() { if (pos > 3) return send('seek', 0, 'absolute'); const i = q.prevIndex(); if (i >= 0) play(i); else send('seek', 0, 'absolute'); }

/** Start playing right away, then discover the folder in the background. */
async function openPath(path: string, o: { append?: boolean; all?: boolean } = {}) {
  const fresh = q.open(path, o.append);
  scanGen++; // an older scan must not rewrite this queue
  await load(path);
  if (fresh && !o.append && (S.autoQueue || o.all) && kindOf(path)) scan(path, !!o.all);
}
async function scan(path: string, all: boolean) {
  const id = ++scanGen, dir = dirname(path);
  let list: string[];
  try {
    list = await invoke<string[]>('list_dir', { dir, id, recursive: S.scanSubfolders });
  } catch { return; } // cancelled by a newer scan, or the folder is gone
  if (id !== scanGen) return;
  q.mergeAuto(discover(base(path), list, opts(all)).map(n => join(dir, n)));
  changed();
}
async function openFolder() {
  const d = await pick({ directory: true });
  if (typeof d === 'string') openFolderPath(d);
}
/** A file plays with its folder; a folder ("Play with Flux" in Explorer) plays everything in it from the top. */
async function openAny(path: string) {
  if (await invoke<boolean>('is_dir', { path }).catch(() => false)) openFolderPath(path); else openPath(path);
}
async function openFolderPath(d: string) {
  let names: string[];
  try { names = await invoke<string[]>('list_dir', { dir: d, id: ++scanGen, recursive: S.scanSubfolders }); } catch (e) { return toast(String(e)); }
  const first = names.filter(n => kindOf(n) && !base(n).startsWith('.')).sort(natCompare)[0];
  if (!first) return toast('No media files in that folder');
  const path = join(d, first);
  q.open(path); await load(path);
  q.mergeAuto(discover(first, names, opts(true)).map(n => join(d, n))); // reuse the listing we already have
  changed();
}
async function openFiles(append: boolean) {
  const r = await pick({ multiple: true, title: append ? 'Add to queue' : 'Open' });
  dropFiles(Array.isArray(r) ? r : typeof r === 'string' ? [r] : [], append);
}
function dropFiles(paths: string[], append: boolean) {
  const files = paths.filter(p => /\.[^\\/.]+$/.test(p)); // folders have no extension; the engine decides what plays
  if (!files.length) return;
  if (append) { q.add(files); changed(); if (!loaded) play(q.indexOf(files[0])); return; }
  openPath(files[0]).then(() => { q.add(files.slice(1)); changed(); });
}

// ---- mpv events ----
function onMpv(m: any) {
  if (m.request_id && waiting.has(m.request_id)) { const f = waiting.get(m.request_id)!; waiting.delete(m.request_id); f(m.error === 'success' ? m.data : null); return; }
  switch (m.event) {
    case 'property-change':
      if (m.name === 'time-pos' && ready && typeof m.data === 'number') {
        pos = m.data;
        const c = q.current;
        if (c && dur) { hist[pkey(c.path)] = { pos, dur, at: Date.now(), p: c.path }; histDirty = true; }
        const now = performance.now();
        if (now - lastUi > 120) { lastUi = now; ui(); }
      } else if (m.name === 'duration' && typeof m.data === 'number') { dur = m.data; startThumbs(); updateBands(); renderAB(); ui(); }
      else if (m.name === 'pause') { paused = !!m.data; if (paused) flushHist(); ui(); }
      else if (m.name === 'mute') { $('bmute').dataset.i = m.data ? 'mute' : 'vol'; paintIcons($('bar')); }
      else if (m.name === 'speed' && typeof m.data === 'number') { speedNow = m.data; $('spd').textContent = +speedNow.toFixed(2) + '×'; $('spd').classList.toggle('on', Math.abs(speedNow - 1) > 0.01); }
      else if (m.name === 'volume' && typeof m.data === 'number') { if (Math.round(m.data) !== S.volume) { S.volume = Math.round(m.data); setDirty = true; } setVol(S.volume); }
      else if (m.name === 'ab-loop-a') { abA = typeof m.data === 'number' ? m.data : null; renderAB(); }
      else if (m.name === 'ab-loop-b') { abB = typeof m.data === 'number' ? m.data : null; renderAB(); }
      else if (m.name === 'sub-delay' && typeof m.data === 'number') { subDelay = m.data; subStyleUi(); }
      else if (m.name === 'video-zoom' && typeof m.data === 'number') { const z = $('zoomchip'); z.hidden = m.data < 0.01; z.textContent = Math.round(100 * 2 ** m.data) + '%'; }
      break;
    case 'file-loaded': ready = true; errStreak = 0; onLoaded(); break;
    case 'playback-restart': if (seekBusy) scrubDone(); break;
    case 'end-file':
      if (m.reason === 'eof') {
        const c = q.current; if (c && hist[pkey(c.path)]) hist[pkey(c.path)].pos = 0;
        if (S.autoplayNext) goNext();
      } else if (m.reason === 'error') {
        toast(`Cannot play ${q.current ? base(q.current.path) : 'file'}`);
        if (++errStreak < q.items.length && S.autoplayNext) goNext();
      }
      break;
    case 'client-message': if (m.args?.[0] === 'act') act(m.args[1], m.args[2]); break;
    case 'shutdown': toast('mpv stopped'); break;
  }
}

/** After every load: adopt files mpv loaded by itself (drag-and-drop on its window), read chapters, tracks, subtitles. */
async function onLoaded() {
  const pl: { filename: string; current?: boolean }[] | null = await ask('get_property', 'playlist');
  const cur = pl?.find(x => x.current)?.filename;
  if (pl && cur && (!q.current || pkey(cur) !== pkey(q.current.path))) {
    const rest = pl.filter(x => !x.current).map(x => x.filename);
    const fresh = q.open(cur);
    scanGen++;
    markLoaded(); nowPlaying(cur);
    if (fresh && S.autoQueue && kindOf(cur)) scan(cur, false);
    q.add(rest);
    changed();
  }
  if (pl && pl.length > 1) send('playlist-clear'); // the queue is ours; mpv must not advance on its own
  chapters = (await ask('get_property', 'chapter-list')) ?? [];
  if (!dur) dur = (await ask('get_property', 'duration')) ?? 0;
  updateBands(); renderChapters();
  await refreshTracks();
  if (applyPrefs) { // the per-show audio/subtitle language for a file mpv opened before the page was ready
    const want = applyPrefs; applyPrefs = null;
    const a = want.a && tracks.find(t => t.type === 'audio' && t.lang === want.a);
    if (a) send('set_property', 'aid', a.id);
    if (want.s === 'no') send('set_property', 'sid', 'no');
    else { const s = want.s && tracks.find(t => t.type === 'sub' && t.lang === want.s); if (s) send('set_property', 'sid', s.id); }
    await refreshTracks();
  }
  applyAudio();
  autoSubs();
}

// ---- audio: mix every track into one (per folder/show), even out loudness (global) ----
const LEVEL = 'dynaudnorm=f=200:g=11:p=0.9';
const audioTracks = () => tracks.filter(t => t.type === 'audio');
function applyAudio() {
  const c = q.current, a = audioTracks(), want = !!(c && prefs[seriesKey(c.path)]?.mix) && a.length > 1;
  if (want) {
    mixing = true;
    send('set_property', 'af', '');
    send('set_property', 'lavfi-complex', `${a.map(t => `[aid${t.id}]`).join('')}amix=inputs=${a.length}:normalize=0${S.normalize ? ',' + LEVEL : ''}[ao]`);
  } else {
    if (mixing) { mixing = false; send('set_property', 'lavfi-complex', ''); }
    send('set_property', 'af', S.normalize ? `lavfi=[${LEVEL}]` : '');
  }
}
function toggleMix() {
  const c = q.current; if (!c) return;
  const p = (prefs[seriesKey(c.path)] ??= {}); p.mix = !p.mix; wr('prefs.json', prefs);
  applyAudio();
  osd(p.mix ? `Mixing all ${audioTracks().length} audio tracks` : 'Audio: one track');
}
function toggleLevel() { S.normalize = !S.normalize; setDirty = true; flushHist(); applyAudio(); osd(S.normalize ? 'Even out loudness: on' : 'Even out loudness: off'); }
function audioMenu() {
  const a = audioTracks(), sel = a.find(t => t.selected);
  openMenu('baud', [
    { head: 'Audio' },
    ...a.map(t => ({ label: `${t.title || 'Track ' + t.id}`, note: [t.lang, t.codec].filter(Boolean).join(' · '), on: !mixing && t.id === sel?.id,
      fn: () => { if (mixing) { const c = q.current; if (c) { (prefs[seriesKey(c.path)] ??= {}).mix = false; wr('prefs.json', prefs); } applyAudio(); } send('set_property', 'aid', t.id); setTimeout(refreshTracks, 200); } })),
    ...(a.length > 1 ? [{ sep: true }, { label: `Mix all ${a.length} tracks`, note: 'remembered for this folder', tog: true, on: mixing, fn: toggleMix }] : []),
    { sep: true },
    { label: 'Even out loudness', note: 'quiet voices up, loud bangs down', tog: true, on: S.normalize, fn: toggleLevel },
  ]);
}

// ---- subtitle look and timing ----
function applySubStyle() {
  send('set_property', 'sub-scale', S.subScale);
  send('set_property', 'sub-pos', S.subPos);
  send('set_property', 'sub-border-style', S.subBox ? 'background-box' : 'outline-and-shadow');
  send('set_property', 'sub-back-color', '#B0000000');
}
function subStyleUi() {
  ($('ssize') as HTMLInputElement).value = String(S.subScale); ($('spos') as HTMLInputElement).value = String(S.subPos);
  ($('sbox') as HTMLInputElement).checked = S.subBox;
  $('sdelay').textContent = (subDelay > 0 ? '+' : '') + subDelay.toFixed(1) + ' s';
}
function bindSubStyle() {
  const on = (id: string, f: (el: HTMLInputElement) => void) => { const el = $(id) as HTMLInputElement; el.oninput = () => { f(el); setDirty = true; applySubStyle(); }; el.onchange = () => flushHist(); };
  on('ssize', el => { S.subScale = +el.value; }); on('spos', el => { S.subPos = +el.value; }); on('sbox', el => { S.subBox = el.checked; });
  $('sdm').onclick = () => act('subearly'); $('sdp').onclick = () => act('sublate'); $('sd0').onclick = () => send('set_property', 'sub-delay', 0);
}
function updateBands() {
  const c = q.current;
  bands = dur ? markersFor(chapters, dur, c ? prefs[seriesKey(c.path)] : undefined) : [];
  buildTimeline();
}

// ---- timeline: chapter gaps, intro/outro bands, A-B mark, hover preview ----
function buildTimeline() {
  const pct = (t: number) => (dur ? (t / dur) * 100 : 0) + '%';
  $('ticks').replaceChildren(...chapters.slice(1).map(c => { const i = document.createElement('i'); i.style.left = pct(c.time); return i; }));
  $('bands').replaceChildren(...bands.map(b => {
    const i = document.createElement('i');
    i.className = b.kind + (b.source === 'learned' ? ' learned' : '');
    i.style.left = pct(b.start); i.style.width = (dur ? ((b.end - b.start) / dur) * 100 : 0) + '%';
    return i;
  }));
}
function renderAB() {
  const el = $('ab'), on = abA != null && !!dur;
  el.classList.toggle('on', on); el.classList.toggle('half', on && abB == null);
  if (on) {
    const a = Math.min(abA!, abB ?? abA!), b = Math.max(abA!, abB ?? abA!);
    el.style.setProperty('--a', (a / dur) * 100 + '%'); el.style.setProperty('--w', ((b - a) / dur) * 100 + '%');
  }
  $('bclip').hidden = !(abA != null && abB != null);
}
/** Thumbnails for the hover preview: made in the background once playback has settled, coarse to fine, cached. */
function startThumbs() {
  const c = q.current;
  if (!S.thumbnails || !c || kindOf(c.path) !== 'video' || dur < 20 || thumbFor === c.path) return;
  thumbFor = c.path;
  thumbN = Math.max(16, Math.min(120, Math.round(dur / 12))); thumbs = [];
  const id = ++thumbGen, path = c.path, d = dur, n = thumbN;
  clearTimeout(thumbTimer);
  thumbTimer = window.setTimeout(() => { if (id === thumbGen) invoke('make_thumbs', { path, dur: d, n, id }).catch(() => {}); }, 1500);
}
function nearestThumb(f: number): string | undefined {
  if (!thumbN) return;
  const i0 = Math.min(thumbN - 1, Math.max(0, Math.floor(f * thumbN))), far = Math.max(2, Math.round(thumbN * 0.04));
  for (let d = 0; d <= far; d++) { const t = thumbs[i0 - d] ?? thumbs[i0 + d]; if (t) return t; }
}
/** The UI takes its accent colour from the picture: average of the first thumbnail, pushed to a vivid mid tone. */
function accentFrom(src: string) {
  const img = new Image();
  img.onload = () => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 8;
    const cx = cv.getContext('2d', { willReadFrequently: true })!; cx.drawImage(img, 0, 0, 8, 8);
    const d = cx.getImageData(0, 0, 8, 8).data; let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4; r /= n * 255; g /= n * 255; b /= n * 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), dl = mx - mn;
    let h = 0; if (dl) h = mx === r ? ((g - b) / dl) % 6 : mx === g ? (b - r) / dl + 2 : (r - g) / dl + 4;
    h = Math.round(((h * 60) + 360) % 360);
    const st = document.documentElement.style;
    st.setProperty('--accent', `hsl(${h} 82% 66%)`); st.setProperty('--accent2', `hsl(${(h + 48) % 360} 80% 68%)`);
  };
  img.src = src;
}
const tl = $('tl');
function fracAt(e: PointerEvent) { const r = tl.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); }
function chapterAt(t: number) { let k = -1; chapters.forEach((c, i) => { if (c.time <= t) k = i; }); return k; }
function showPreview(f: number) {
  if (!dur) return;
  const pv = $('preview'), t = f * dur, k = chapterAt(t), b = bandAt(bands, t), img = S.thumbnails ? nearestThumb(f) : undefined;
  pv.classList.toggle('noimg', !img);
  if (img) $('pimg').style.backgroundImage = `url("${img}")`;
  $('ptime').textContent = fmt(t) + (k >= 0 && chapters[k].title ? ' · ' + chapters[k].title : b ? ' · ' + b.kind : '');
  pv.classList.add('on');
  const vr = $('video').getBoundingClientRect(), tr = tl.getBoundingClientRect(), br = $('bar').getBoundingClientRect(), w = pv.offsetWidth;
  pv.style.left = Math.round(Math.max(8, Math.min(vr.width - w - 8, tr.left - vr.left + f * tr.width - w / 2))) + 'px';
  pv.style.bottom = Math.round(vr.bottom - br.top + 8) + 'px';
  syncRect();
}
function hidePreview() { if ($('preview').classList.contains('on')) setFloat($('preview'), false); tl.classList.remove('hot'); }
/** While dragging: one fast (keyframe) seek in flight at a time, the newest position wins; mpv's playback-restart frees the slot. */
function scrubTo(t: number) {
  seekWant = t;
  if (seekBusy) return;
  seekBusy = true; seekWant = null;
  send('seek', t, 'absolute+keyframes');
  setTimeout(() => { if (seekBusy) scrubDone(); }, 400); // never stall if an event goes missing
}
function scrubDone() {
  seekBusy = false;
  if (seeking && seekWant != null) scrubTo(seekWant);
}
tl.addEventListener('pointermove', e => {
  const f = fracAt(e);
  tl.style.setProperty('--hx', f * 100 + '%'); tl.classList.add('hot');
  showPreview(f);
  if (seeking && dur) { pos = f * dur; tl.style.setProperty('--p', String(f)); scrubTo(f * dur); }
});
tl.addEventListener('pointerleave', () => { if (!seeking) hidePreview(); });
tl.addEventListener('pointerdown', e => {
  if (!dur) return;
  tl.setPointerCapture(e.pointerId); seeking = true; tl.classList.add('drag');
  seekWasPaused = paused;
  if (!paused) send('set_property', 'pause', true); // scrubbing a still picture is smooth; sound would stutter
  scrubTo(fracAt(e) * dur);
});
tl.addEventListener('pointerup', e => {
  if (seeking && dur) {
    seekWant = null;
    send('seek', fracAt(e) * dur, 'absolute+exact'); // land on the exact frame under the pointer
    if (!seekWasPaused) send('set_property', 'pause', false);
  }
  seeking = false; tl.classList.remove('drag');
  if (!tl.matches(':hover')) hidePreview();
});

// ---- skip intro / outro ----
const SKIPLABEL: Record<string, string> = { intro: 'Skip intro', outro: 'Skip outro', recap: 'Skip recap', preview: 'Skip preview' };
function doSkip(b: Band) {
  if ((b.kind === 'outro' || b.kind === 'preview') && b.end >= dur - 1.5) { if (!goNext()) send('seek', Math.max(0, dur - 0.5), 'absolute'); }
  else send('seek', b.end, 'absolute');
}
function skipTick() {
  const b = S.autoSkip === 'off' ? undefined : bandAt(bands, pos), pill = $('skip');
  if (pill.classList.contains('on') !== !!b) setFloat(pill, !!b);
  if (!b) return;
  const label = SKIPLABEL[b.kind];
  if ($('skiplbl').textContent !== label) { $('skiplbl').textContent = label; syncRect(); }
  const key = b.kind + b.start;
  if (S.autoSkip === 'auto' && !skipDone.has(key) && pos <= b.start + 5) {
    skipDone.add(key); doSkip(b);
    toast(`${label.replace('Skip', 'Skipped')}`, { label: 'Undo', fn: () => send('seek', b.start, 'absolute') });
  }
}
$('skip').onclick = () => act('intro');

// ---- chapters ----
function renderChapters() {
  $('chempty').hidden = chapters.length > 0;
  $('chinfo').textContent = chapters.length ? `${chapters.length} chapters` : '';
  $('chlist').replaceChildren(...chapters.map((c, i) => {
    const li = document.createElement('li'); li.style.setProperty('--n', String(Math.min(i, 14)));
    li.className = i === curChap ? 'cur' : ''; li.onclick = () => send('seek', c.time, 'absolute');
    const kind = bands.find(b => b.source === 'chapter' && b.start === c.time)?.kind;
    const tm = document.createElement('span'); tm.className = 'tm'; tm.textContent = fmt(c.time);
    const nm = document.createElement('span'); nm.className = 'nm'; const b = document.createElement('b'); b.textContent = c.title || `Chapter ${i + 1}`; nm.append(b);
    li.append(tm, nm);
    if (kind) { const ch = document.createElement('span'); ch.className = 'chip ' + kind; ch.textContent = kind; li.append(ch); }
    return li;
  }));
}
function chapterNav(dir: -1 | 1) {
  const t = chapterTarget(chapters, pos, dir);
  if (!chapters.length) { send('seek', dir * 90, 'relative'); osd(`${dir > 0 ? '+' : '-'}90 s`); return; }
  if (t == null) { if (!goNext()) osd('Last chapter'); return; }
  send('seek', t, 'absolute');
  const k = chapterAt(t); osd(chapters[k]?.title || `Chapter ${k + 1}`);
}

// ---- audio, subtitles ----
const track = async (prop: 'aid' | 'sid', label: string, kind: 'audio' | 'sub') => {
  if (kind === 'audio' && mixing) { // A while mixing: back to single tracks, starting with the current one
    const c = q.current; if (c) { (prefs[seriesKey(c.path)] ??= {}).mix = false; wr('prefs.json', prefs); }
    applyAudio(); osd('Audio: one track'); return;
  }
  send('cycle', prop);
  send('show-text', `${label}: \${${prop}} \${current-tracks/${kind}/lang} \${current-tracks/${kind}/title}`, 2000);
  const c = q.current; if (!c) return;
  const id = await ask('get_property', prop);                          // false/'no' = off
  const lang = id ? await ask('get_property', `current-tracks/${kind}/lang`) : null;
  const p = (prefs[seriesKey(c.path)] ??= {});
  if (kind === 'audio') { if (typeof lang === 'string') p.a = lang; } else p.s = id ? (typeof lang === 'string' ? lang : p.s) : 'no';
  wr('prefs.json', prefs);                                              // next episode of this show opens with the same choice
  refreshTracks();
};
async function refreshTracks() { tracks = (await ask('get_property', 'track-list')) ?? []; renderSubs(); }
const dedupe = <T extends { full: string }>(l: T[]) => l.filter((x, i) => l.findIndex(y => y.full.toLowerCase() === x.full.toLowerCase()) === i);
async function subFiles(dir: string) {
  const out: { rel: string; full: string }[] = [];
  const dirs = ['', 'Subs', 'Subtitles', 'Sub'];
  const lists = await Promise.allSettled(dirs.map(d => invoke<string[]>('list_dir', { dir: d ? join(dir, d) : dir, id: 0, recursive: false })));
  lists.forEach((r, i) => { if (r.status === 'fulfilled') for (const n of r.value) if (isSub(n)) out.push({ rel: dirs[i] ? join(dirs[i], n) : n, full: join(dirs[i] ? join(dir, dirs[i]) : dir, n) }); });
  return out;
}
/** Find the subtitle file(s) that belong to this episode; load the best one unless the file already has a good track. */
async function autoSubs() {
  const c = q.current;
  if (!c || kindOf(c.path) !== 'video') return;
  const files = await subFiles(dirname(c.path));
  const ranked = pickSubs(c.path, files.map(f => f.rel), S.subLang);
  subCands = dedupe(ranked.map(r => ({ ...r, full: files.find(f => f.rel === r.name)!.full })));
  renderSubs();
  if (!S.autoSubs || prefs[seriesKey(c.path)]?.s === 'no' || q.current?.path !== c.path) return;
  const subs = tracks.filter(t => t.type === 'sub');
  const want = S.subLang;
  const embedded = subs.find(t => !t.external && t.lang === want);
  const sel = subs.find(t => t.selected);
  if (sel && sel.lang === want) return;                     // already showing the right language
  if (embedded) { send('set_property', 'sid', embedded.id); toast(`Subtitles: ${embedded.title || embedded.lang}`); return; }
  const best = subCands[0];
  if (!best || (best.lang && best.lang !== want && sel)) return; // do not replace a track with a worse-language file
  if (subs.some(t => t.external && String(t['external-filename'] ?? '').toLowerCase() === best.full.toLowerCase() && t.selected)) return;
  await send('sub-add', best.full, 'select', base(best.name), best.lang ?? '');
  toast(`Subtitles: ${base(best.name)}${best.lang ? ` (${best.lang})` : ''}`);
  refreshTracks();
}
function renderSubs() {
  const subs = tracks.filter(t => t.type === 'sub');
  const mk = (cur: boolean, text: string, fn: () => void) => { const li = document.createElement('li'); li.className = cur ? 'cur' : ''; li.onclick = fn;
    const d = document.createElement('i'); d.className = 'dot'; const s = document.createElement('span'); s.textContent = text; li.append(d, s); return li; };
  $('subtracks').replaceChildren(
    mk(!subs.some(t => t.selected), 'Off', () => { send('set_property', 'sid', 'no'); const c = q.current; if (c) { (prefs[seriesKey(c.path)] ??= {}).s = 'no'; wr('prefs.json', prefs); } setTimeout(refreshTracks, 150); }),
    ...subs.map(t => mk(!!t.selected, `${t.external ? base(t['external-filename'] ?? 'External') : t.title || 'Track ' + t.id}${t.lang ? ' · ' + t.lang : ''}`,
      () => { send('set_property', 'sid', t.id); const c = q.current; if (c && t.lang) { const p = (prefs[seriesKey(c.path)] ??= {}); p.s = t.lang; wr('prefs.json', prefs); } setTimeout(refreshTracks, 150); })));
  $('subfound').replaceChildren(...subCands.map(s => mk(false, `${base(s.name)}${s.lang ? ' · ' + s.lang : ''}`, async () => { await send('sub-add', s.full, 'select', base(s.name), s.lang ?? ''); setTimeout(refreshTracks, 200); })));
  $('subnone').hidden = subCands.length > 0 || !q.current;
}

// ---- Whisper: one click (or G) makes subtitles for what is playing, in the background ----
type FoundWhisper = { exe: string; model: string; vad: string };
const W = { run: false, file: '' }; // file = what the running job is for
const whisperReady = () => (S.wFlavor === 'custom' ? !!S.wTemplate.trim() : !!S.wExe.trim());
function whisperUi() {
  ($('wflavor') as HTMLSelectElement).value = S.wFlavor;
  ($('wexe') as HTMLInputElement).value = S.wExe; ($('wmodel') as HTMLInputElement).value = S.wModel;
  ($('wtr') as HTMLInputElement).checked = S.wTranslate; ($('wtpl') as HTMLInputElement).value = S.wTemplate;
  const lang = $('wlang') as HTMLSelectElement;
  if (![...lang.options].some(o => o.value === S.wLang)) lang.append(new Option(S.wLang, S.wLang));
  lang.value = S.wLang;
  $('wtpl-l').hidden = S.wFlavor !== 'custom'; $('wexe-l').hidden = S.wFlavor === 'custom';
  const model = base(S.wModel).replace(/^ggml-|\.bin$/g, '');
  $('wstatus').textContent = !whisperReady() ? 'Whisper not set up yet: see Whisper setup below'
    : S.wFlavor === 'cpp' ? `On your GPU · ${model || 'model?'}${S.wVad && S.wVadOn ? ' · speech detection on' : ''}` : S.wFlavor === 'custom' ? 'Custom command' : 'Whisper command line';
  ($('wvadon') as HTMLInputElement).checked = S.wVadOn;
  $('wvad-l').hidden = S.wFlavor !== 'cpp' || !S.wVad;
  $('wvad').textContent = S.wFlavor !== 'cpp' ? '' : S.wVad
    ? 'Speech detection skips everything that is not talking: best for vlogs and shows. It can drop real lines under loud game sound, so it is off by default. Lines Whisper invents over long quiet stretches are removed either way.'
    : 'No speech detection model found (ggml-silero-*.bin in %LOCALAPPDATA%\\local.flux\\whisper). Lines Whisper invents over long quiet stretches are removed anyway.';
  ($('wgo') as HTMLButtonElement).disabled = !whisperReady();
}
async function detectWhisper(force: boolean) {
  const w = await invoke<FoundWhisper | null>('whisper_detect').catch(() => null);
  if (w && (S.wAuto || force)) {
    if (S.wExe !== w.exe || S.wModel !== w.model || S.wVad !== w.vad || S.wFlavor !== 'cpp') { S.wFlavor = 'cpp'; S.wExe = w.exe; S.wModel = w.model; S.wVad = w.vad; setDirty = true; }
    S.wAuto = true;
  }
  if (force) toast(w ? `Found whisper.cpp with ${base(w.model)}` : 'No whisper.cpp found on this PC');
  whisperUi(); flushHist();
}
function bindWhisper() {
  const set = (id: string, key: keyof Settings, kind: 'text' | 'bool' | 'manual' = 'manual') => { const el = $(id) as HTMLInputElement | HTMLSelectElement;
    el.onchange = () => {
      (S as any)[key] = kind === 'bool' ? (el as HTMLInputElement).checked : el.value;
      if (kind === 'manual') S.wAuto = false; // a hand-picked program or model is never replaced by auto-detection
      setDirty = true; flushHist(); whisperUi();
    }; };
  set('wflavor', 'wFlavor'); set('wexe', 'wExe'); set('wmodel', 'wModel'); set('wtpl', 'wTemplate'); set('wlang', 'wLang', 'text'); set('wtr', 'wTranslate', 'bool'); set('wvadon', 'wVadOn', 'bool');
  $('wgo').onclick = () => genSubs();
  $('wstop').onclick = () => invoke('whisper_cancel').catch(() => {});
  $('wfind').onclick = () => detectWhisper(true);
  $('wchip').onclick = () => setTab('subs');
}
function setChip(t: string) { const c = $('wchip'); c.hidden = !t; c.textContent = t; syncRect(); }
async function genSubs() {
  const c = q.current;
  if (!c) return toast('Open a video first');
  if (W.run) { setTab('subs'); return toast('Already generating subtitles…'); }
  if (!whisperReady()) { setTab('subs'); ($('wsetup') as HTMLDetailsElement).open = true; return toast('Whisper is not set up yet'); }
  $('wlog').textContent = ''; $('wbar').hidden = false; $('wbar').classList.add('busy'); $('wfill').style.width = '0';
  $('wmsg').textContent = 'Starting…';
  const aid = await ask('get_property', 'aid');
  try {
    await invoke('whisper_run', { cfg: { flavor: S.wFlavor, exe: S.wExe, model: S.wModel, lang: S.wLang, translate: S.wTranslate, file: c.path,
      outdir: dirname(c.path), template: S.wTemplate, vad: S.wVadOn ? S.wVad : '', aid: typeof aid === 'number' ? aid : null } });
    W.run = true; W.file = c.path; $('wgo').hidden = true; $('wstop').hidden = false;
    setChip('Subtitles…');
    toast('Making subtitles in the background. Keep watching: they turn on by themselves when ready.');
  } catch (e) { $('wmsg').textContent = String(e); $('wbar').hidden = true; toast(String(e)); }
}
function whisperLog(l: string) {
  const log = $('wlog'); log.textContent += l + '\n'; if (log.textContent.length > 8000) log.textContent = log.textContent.slice(-5000); log.scrollTop = log.scrollHeight;
  if (/^Extracting audio/.test(l)) { $('wmsg').textContent = 'Reading the audio…'; return; }
  if (/^Transcribing/.test(l)) { $('wmsg').textContent = 'Listening… (on the GPU)'; return; }
  let pct: number | null = null;
  const p = /progress\s*=\s*(\d+)\s*%/.exec(l);
  if (p) pct = +p[1];
  else {
    const m = /-->\s*(?:(\d+):)?(\d+):(\d+)[.,]\d+/.exec(l); // "[00:12.000 --> 00:15.000] text": how far it got
    const d = dur0(W.file) ?? (q.current && pkey(q.current.path) === pkey(W.file) ? dur : 0);
    if (m && d) pct = ((+(m[1] ?? 0)) * 3600 + +m[2] * 60 + +m[3]) / d * 100;
  }
  if (pct == null) return;
  const v = Math.min(99, Math.max(0, Math.round(pct)));
  $('wbar').classList.remove('busy'); $('wfill').style.width = v + '%';
  $('wmsg').textContent = `Listening… ${v}%`; setChip(`Subtitles ${v}%`);
}
async function whisperDone(r: { ok: boolean; srt: string; error: string }) {
  W.run = false; $('wgo').hidden = false; $('wstop').hidden = true; $('wbar').classList.remove('busy'); setChip('');
  if (!r.ok) { $('wmsg').textContent = r.error || 'Whisper failed'; $('wbar').hidden = true; toast('Subtitles: ' + (r.error || 'failed')); return; }
  $('wfill').style.width = '100%';
  $('wmsg').textContent = `Saved as ${base(r.srt)} next to the video`;
  if (q.current && pkey(q.current.path) !== pkey(W.file)) { toast(`Subtitles ready for ${base(W.file)}`); return; }
  await send('sub-add', r.srt, 'select', 'Whisper', S.wLang || '');
  toast('Subtitles are ready and turned on', { label: 'Show file', fn: () => invoke('reveal', { path: r.srt }) });
  setTimeout(() => { refreshTracks(); autoSubsListOnly(); }, 300);
}
async function autoSubsListOnly() {
  const c = q.current; if (!c) return;
  const files = await subFiles(dirname(c.path));
  subCands = dedupe(pickSubs(c.path, files.map(f => f.rel), S.subLang).map(r => ({ ...r, full: files.find(f => f.rel === r.name)!.full })));
  renderSubs();
}

// ---- clips, Recycle Bin, speed ----
const CLIPMODES: { mode: Settings['clipMode']; label: string; note: string }[] = [
  { mode: 'copy', label: 'Fast copy', note: 'original quality, starts on a keyframe' },
  { mode: 'exact', label: 'Exact cut', note: 'frame-exact, GPU re-encode' },
  { mode: 'small', label: 'Small for Discord', note: 'under 10 MB' },
];
/** X or "Save clip": choose how to save the marked part (the last choice is highlighted, Enter-free: one click). */
function clipMenu() {
  if (abA == null || abB == null) return toast('Press L where the clip starts and L again where it ends, then X to save it');
  const d = Math.abs(abB - abA);
  openMenu($('bclip').hidden ? 'bplay' : 'bclip', [
    { head: `Save ${fmt(d)} clip` },
    ...CLIPMODES.map(m => ({ label: m.label, note: m.note + (m.mode !== 'copy' && mixing ? ' · all tracks mixed' : ''), on: S.clipMode === m.mode,
      fn: () => { S.clipMode = m.mode; setDirty = true; exportClip(m.mode); } })),
  ]);
}
async function exportClip(mode: Settings['clipMode']) {
  const c = q.current; if (!c || abA == null || abB == null) return;
  const a = Math.min(abA, abB), b = Math.max(abA, abB);
  const aid = await ask('get_property', 'aid');
  try {
    await invoke<string>('clip_export', { path: c.path, start: a, end: b, aid: typeof aid === 'number' ? aid : null, mode, mix: mixing ? audioTracks().length : null });
    toast(`Saving clip ${fmt(a)}–${fmt(b)}${mode === 'copy' ? '' : ' (encoding on the GPU)'}…`, undefined, 300000);
  } catch (e) { toast(String(e)); }
}
function clipDone(r: { ok: boolean; out: string; error: string }) {
  if (!r.ok) return toast('Clip: ' + r.error);
  send('set_property', 'ab-loop-a', 'no'); send('set_property', 'ab-loop-b', 'no');
  toast(`Clip saved: ${base(r.out)}`, { label: 'Show in folder', fn: () => invoke('reveal', { path: r.out }) }, 9000);
}
/** First press asks, a second press (or the button) confirms. */
function askRecycle(i: number) {
  const it = q.items[i]; if (!it) return;
  if (recycleArm === pkey(it.path)) { recycleArm = ''; toast(''); doRecycle(it.path); return; }
  recycleArm = pkey(it.path); clearTimeout(recycleTimer); recycleTimer = window.setTimeout(() => { recycleArm = ''; }, 6000);
  toast(`Move "${prettyName(it.path)}" to the Recycle Bin?`, { label: 'Move to Recycle Bin', fn: () => { recycleArm = ''; doRecycle(it.path); } }, 6000);
}
async function doRecycle(path: string) {
  const i = q.indexOf(path); if (i < 0) return;
  const wasCur = i === q.cur;
  q.remove(i);
  if (wasCur) { // mpv must let go of the file first: play what came next, or stop
    if (q.current) await load(q.current.path);
    else { await send('stop'); unload(); }
  }
  delete hist[pkey(path)]; histDirty = true; flushHist();
  let err = '';
  for (let k = 0; k < 10; k++) { try { await invoke('recycle', { path }); err = ''; break; } catch (e) { err = String(e); await sleepMs(250); } }
  changed();
  toast(err ? `Could not delete ${base(path)}: ${err}` : `Moved ${base(path)} to the Recycle Bin`);
}
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
function setSpeed(v: number) { send('set_property', 'speed', v); osd(`Speed: ${v}×`); }
const speedMenu = () => openMenu('spd', [{ head: 'Speed' }, ...SPEEDS.map(v => ({ label: v + '×', on: Math.abs(v - speedNow) < 0.01, fn: () => setSpeed(v) }))]);

/** One floating menu above the bar, anchored on a button. Clicking the same button again closes it. */
type MenuItemDef = { label?: string; note?: string; on?: boolean; tog?: boolean; fn?: () => void; sep?: boolean; head?: string };
let menuFor = '';
function openMenu(anchor: string, items: MenuItemDef[]) {
  const m = $('menu');
  if (m.classList.contains('on') && menuFor === anchor) return closeMenu();
  menuFor = anchor;
  m.replaceChildren(...items.map(it => {
    if (it.sep) { const s = document.createElement('div'); s.className = 'sep'; return s; }
    if (it.head) { const h = document.createElement('h4'); h.textContent = it.head; return h; }
    const b = document.createElement('button'); b.className = (it.on ? 'on' : '') + (it.tog ? ' tog' : '');
    const l = document.createElement('span'); l.textContent = it.label ?? ''; b.append(l);
    if (it.note) { const n = document.createElement('small'); n.textContent = it.note; b.append(n); }
    b.onclick = () => { closeMenu(); it.fn?.(); };
    return b;
  }));
  m.classList.add('on'); wake();
  const vr = $('video').getBoundingClientRect(), sr = $(anchor).getBoundingClientRect(), br = $('bar').getBoundingClientRect();
  m.style.left = Math.round(Math.max(8, Math.min(vr.width - m.offsetWidth - 8, sr.left - vr.left + sr.width / 2 - m.offsetWidth / 2))) + 'px';
  m.style.bottom = Math.round(vr.bottom - br.top + 8) + 'px';
  syncRect();
}
function closeMenu() { if ($('menu').classList.contains('on')) setFloat($('menu'), false); menuFor = ''; }
document.addEventListener('pointerdown', e => { const t = e.target as HTMLElement; if (!t.closest('#menu, #spd, #baud, #bclip')) closeMenu(); });

// ---- actions & keys ----
async function toggleFs() {
  const w = getCurrentWindow(), on = !(await w.isFullscreen());
  await w.setFullscreen(on);
  document.body.classList.toggle('fs', on);
}
const nudgeSpeed = (d: number) => { send(d ? 'add' : 'set_property', 'speed', d || 1); osd('Speed: ${speed}'); };
function setTab(t: typeof tab, open = true) {
  tab = t;
  document.querySelectorAll<HTMLElement>('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  ['queue', 'chapters', 'subs'].forEach(n => { $('p-' + n).hidden = n !== t; });
  $('tabs').style.setProperty('--t', String(['queue', 'chapters', 'subs'].indexOf(t)));
  if (open) $('side').classList.add('open');
  if (t === 'subs') autoSubsListOnly();
}
function togglePanel(t: typeof tab) { const s = $('side'); if (s.classList.contains('open') && tab === t) s.classList.remove('open'); else setTab(t); }
function act(a: string, arg?: string) {
  if (a === 'mouseout') { nearBottom = false; return; }
  if (a === 'mouse') {
    // from flux.lua: pointer height over the video (0 = top, 1 = bottom). Near the bottom the bar comes up and stays up.
    const y = Number(arg); nearBottom = y > 0.8;
    wake(); return;
  }
  wake();
  switch (a) {
    case 'toggle': loaded ? send('cycle', 'pause') : q.current && load(q.current.path); break;
    case 'play': loaded ? send('set_property', 'pause', false) : q.current && load(q.current.path); break;
    case 'pause': send('set_property', 'pause', true); break;
    case 'seekb': send('seek', -5, 'relative+exact'); break;
    case 'seekf': send('seek', 5, 'relative+exact'); break;
    case 'volup': send('add', 'volume', 5); break;
    case 'voldn': send('add', 'volume', -5); break;
    case 'mute': send('cycle', 'mute'); break;
    case 'next': goNext(); break;
    case 'prev': goPrev(); break;
    case 'queue': togglePanel('queue'); break;
    case 'chapters': togglePanel('chapters'); break;
    case 'subpanel': togglePanel('subs'); break;
    case 'whisper': genSubs(); break;
    case 'fs': toggleFs(); break;
    case 'esc': if ($('menu').classList.contains('on')) closeMenu(); else if (document.body.classList.contains('fs')) toggleFs(); break;
    case 'open': openFiles(false); break;
    case 'folder': openFolder(); break;
    case 'aud': track('aid', 'Audio', 'audio'); break;
    case 'sub': track('sid', 'Subtitles', 'sub'); break;
    case 'slower': nudgeSpeed(-0.1); break;
    case 'faster': nudgeSpeed(0.1); break;
    case 'speed1': setSpeed(1); break;
    case 'slow25': setSpeed(0.25); break;
    case 'slow50': setSpeed(0.5); break;
    case 'fback': send('frame-back-step'); break;
    case 'fstep': send('frame-step'); break;
    case 'abloop': send('ab-loop'); osd('A-B loop: ${ab-loop-a} - ${ab-loop-b}'); setTimeout(() => { if (abA != null && abB != null) toast('Marked. Press X to save this part as a clip, L to clear'); }, 200); break;
    case 'clip': clipMenu(); break;
    case 'audmenu': audioMenu(); break;
    case 'subprev': case 'subnext': {
      if (!tracks.some(t => t.type === 'sub' && t.selected)) { osd('No subtitles on'); break; }
      send('sub-seek', a === 'subprev' ? -1 : 1); break;
    }
    case 'subearly': case 'sublate': {
      const v = subDelay = Math.round((subDelay + (a === 'subearly' ? -0.1 : 0.1)) * 10) / 10; // counted here: quick presses outrun mpv's reply
      send('set_property', 'sub-delay', v); subStyleUi(); osd(`Subtitle timing: ${v > 0 ? '+' : ''}${v.toFixed(1)} s`); break;
    }
    case 'zoom0': send('script-message', 'flux-zoom-reset'); break;
    case 'search': {
      setTab('queue');
      getCurrentWebview().setFocus().catch(() => {}); // keys usually go to mpv's window; the box needs the page focused
      setTimeout(() => { const s = $('qsearch') as HTMLInputElement; s.focus(); s.select(); }, 60);
      break;
    }
    case 'recycle': if (q.current) askRecycle(q.cur); break;
    case 'chapprev': chapterNav(-1); break;
    case 'chapnext': chapterNav(1); break;
    case 'shot': send('screenshot'); osd('Screenshot saved to Pictures\\Flux'); break;
    case 'intro': {
      const b = bandAt(bands, pos);
      if (b) { doSkip(b); break; }
      const c = q.current;
      if (!c || pos > 600) { toast('No intro marker here'); break; }
      // nothing known: skip a typical opening (85 s) and remember it for this show
      const start = pos, end = pos + 85, p = (prefs[seriesKey(c.path)] ??= {});
      p.intro = { start, end }; wr('prefs.json', prefs); updateBands(); send('seek', end, 'absolute');
      toast('Skipped 85 s and remembered it for this show', { label: 'Undo', fn: () => send('seek', start, 'absolute') });
      break;
    }
    case 'outro': {
      const b = bandAt(bands, pos);
      if (b && (b.kind === 'outro' || b.kind === 'preview')) { doSkip(b); break; }
      const c = q.current;
      if (!c || !dur || pos < dur - 400) { toast('No outro marker here'); break; }
      (prefs[seriesKey(c.path)] ??= {}).outro = Math.round(dur - pos); wr('prefs.json', prefs);
      toast('Outro remembered for this show'); if (!goNext()) send('seek', dur - 0.5, 'absolute');
      break;
    }
  }
}
// [DOM key, mpv key, action]: one table feeds both the page's keydown and mpv's own window (where focus usually is).
// Media keys are not here: Rust registers them as global hotkeys and sends "media-key" events (see init).
const KEYS: [string, string, string][] = [
  ['space', 'SPACE', 'toggle'], ['arrowleft', 'LEFT', 'seekb'], ['arrowright', 'RIGHT', 'seekf'],
  ['arrowup', 'UP', 'volup'], ['arrowdown', 'DOWN', 'voldn'], ['m', 'm', 'mute'], ['n', 'n', 'next'], ['p', 'p', 'prev'],
  ['q', 'q', 'queue'], ['c', 'c', 'chapters'], ['f', 'f', 'fs'], ['escape', 'ESC', 'esc'], ['a', 'a', 'aud'], ['s', 's', 'sub'],
  ['ctrl+o', 'Ctrl+o', 'open'], ['ctrl+d', 'Ctrl+d', 'folder'], ['g', 'g', 'whisper'], ['ctrl+g', 'Ctrl+g', 'whisper'], ['u', 'u', 'subpanel'],
  ['[', '[', 'slower'], [']', ']', 'faster'], ['backspace', 'BS', 'speed1'], ['1', '1', 'slow25'], ['2', '2', 'slow50'], ['3', '3', 'speed1'],
  [',', ',', 'fback'], ['.', '.', 'fstep'], ['l', 'l', 'abloop'], ['x', 'x', 'clip'], ['delete', 'DEL', 'recycle'],
  ['pageup', 'PGUP', 'chapprev'], ['pagedown', 'PGDWN', 'chapnext'], ['ctrl+s', 'Ctrl+s', 'shot'], ['i', 'i', 'intro'], ['o', 'o', 'outro'],
  ['ctrl+arrowleft', 'Ctrl+LEFT', 'subprev'], ['ctrl+arrowright', 'Ctrl+RIGHT', 'subnext'], ['z', 'z', 'subearly'], ['shift+z', 'Z', 'sublate'],
  ['0', '0', 'zoom0'], ['ctrl+f', 'Ctrl+f', 'search'], ['shift+a', 'A', 'audmenu'],
];
// Single clicks, dragging, Ctrl+wheel zoom and mouse position come from flux.lua (it tells a click from a drag)
const inputConf = [...KEYS.filter(k => k[1]).map(([, k, a]) => `${k} script-message act ${a}`),
  'MBTN_LEFT_DBL script-message act fs', 'WHEEL_UP script-message act volup', 'WHEEL_DOWN script-message act voldn'].join('\n') + '\n';
addEventListener('keydown', e => {
  if (modal || (e.target instanceof HTMLInputElement && e.target.type !== 'range' && e.target.type !== 'checkbox') || e.target instanceof HTMLSelectElement) return;
  const id = (e.ctrlKey ? 'ctrl+' : '') + (e.shiftKey && /^[a-z]$/i.test(e.key) ? 'shift+' : '') + (e.key === ' ' ? 'space' : e.key.toLowerCase());
  const k = KEYS.find(x => x[0] && x[0] === id);
  if (k) { e.preventDefault(); act(k[2]); }
});
document.addEventListener('click', e => (e.target as HTMLElement).closest('button')?.blur()); // so Space is never "click focused button"

// ---- UI ----
/** Read durations of the next files in the background so the queue shows them before they play. */
function probeMissing() {
  clearTimeout(probeTimer);
  probeTimer = window.setTimeout(() => {
    const paths = q.items.slice(Math.max(0, q.cur - 20)).map(i => i.path).filter(p => dur0(p) == null).slice(0, 120);
    if (paths.length) invoke('probe_durations', { paths, id: ++probeGen }).catch(() => {});
  }, 800);
}
function setVol(v: number) { const el = $('vol') as HTMLInputElement; el.value = String(v); el.style.setProperty('--v', (v / 130) * 100 + '%'); }
function ui() {
  skipTick();
  document.body.classList.toggle('playing', !paused && loaded);
  const sideOpen = $('side').classList.contains('open');
  if (!$('bar').classList.contains('on') && !sideOpen) return; // nothing visible to update
  const icon = paused ? 'play' : 'pause';
  if (icon !== lastPlayIcon) { lastPlayIcon = icon; $('bplay').dataset.i = icon; paintIcons($('bar')); }
  $('time').textContent = `${fmt(pos)} / ${fmt(dur)}`;
  const f = dur ? Math.min(1, pos / dur) : 0;
  tl.style.setProperty('--p', String(f)); tl.setAttribute('aria-valuemax', String(Math.round(dur))); tl.setAttribute('aria-valuenow', String(Math.round(pos)));
  const k = chapterAt(pos);
  if (k !== curChap) { curChap = k; renderChapters(); }
  const c = q.current, p = c ? parse(c.path) : null;
  $('nsub').textContent = [p?.num != null && p.tag !== 'date' ? (p.season ? `S${p.season} · E${p.num}` : `Episode ${p.num}`) : '', k >= 0 ? chapters[k].title : '', q.items.length > 1 ? `${q.cur + 1} of ${q.items.length}` : '']
    .filter(Boolean).join('  ·  ');
  const bar = document.querySelector<HTMLElement>('#list li.cur .pbar i');
  if (bar && dur) bar.style.width = f * 100 + '%';
}
function btn(icon: string, title: string, f: () => void) {
  const b = document.createElement('button'); b.className = 'ib sm'; b.dataset.i = icon; b.title = title; b.setAttribute('aria-label', title);
  b.onclick = ev => { ev.stopPropagation(); f(); }; return b;
}
function render() {
  $('qcount').textContent = `Queue · ${q.items.length}`;
  const rep = $('qrep'); rep.dataset.i = q.repeat === 'one' ? 'repeat1' : 'repeat'; rep.title = 'Repeat: ' + q.repeat; rep.classList.toggle('on', q.repeat !== 'off');
  $('list').replaceChildren(...q.items.map((it, i) => {
    const li = document.createElement('li'), h = hist[pkey(it.path)], p = parse(it.path);
    li.className = i === q.cur ? 'cur' : ''; li.title = it.path; li.onclick = () => play(i); li.style.setProperty('--n', String(Math.min(i, 14)));
    const badge = document.createElement('span'); badge.className = 'badge';
    const bn = document.createElement('b'); bn.textContent = p?.num != null && p.tag !== 'date' ? String(p.num).padStart(2, '0') : String(i + 1);
    const eq = document.createElement('span'); eq.className = 'eq'; eq.innerHTML = '<i></i><i></i><i></i>'; badge.append(bn, eq);
    const nm = document.createElement('span'); nm.className = 'nm';
    const b = document.createElement('b'); b.textContent = prettyName(it.path);
    const sm = document.createElement('small'); sm.textContent = it.auto ? '' : 'added by you'; nm.append(b, sm);
    const right = document.createElement('span');
    const d = document.createElement('span'); d.className = 'du'; d.textContent = dur0(it.path) ? fmt(dur0(it.path)!) : '';
    const acts = document.createElement('span'); acts.className = 'acts';
    acts.append(
      btn('up', 'Move up', () => { q.move(i, i - 1); changed(); }),
      btn('down', 'Move down', () => { q.move(i, i + 1); changed(); }),
      btn('top', 'Play next', () => { q.move(i, i > q.cur ? q.cur + 1 : q.cur); changed(); }),
      btn('x', 'Remove from queue', () => { if (q.remove(i)) { const c = q.current; if (c) load(c.path); else { send('stop'); unload(); } } changed(); }),
      btn('trash', 'Move the file to the Recycle Bin', () => askRecycle(i)),
    );
    right.append(d, acts);
    li.append(badge, nm, right);
    const pp = i === q.cur ? pos : h?.pos ?? 0, dd = i === q.cur ? dur : dur0(it.path) ?? 0;
    if (dd && pp) { const pb = document.createElement('span'); pb.className = 'pbar'; const bi = document.createElement('i'); bi.style.width = (pp / dd) * 100 + '%'; pb.append(bi); li.append(pb); }
    return li;
  }));
  paintIcons($('list'));
  filterQueue();
  $('list').querySelector('li.cur')?.scrollIntoView({ block: 'nearest' });
}
/** Queue search: every word must appear in the name (or the folder), in any order. */
function filterQueue() {
  const words = ($('qsearch') as HTMLInputElement).value.toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  [...$('list').children].forEach((li, i) => {
    const it = q.items[i]; if (!it) return;
    const hay = (prettyName(it.path) + ' ' + it.path).toLowerCase();
    const hit = words.every(w => hay.includes(w)); li.classList.toggle('miss', !hit); if (hit) shown++;
  });
  $('qnone').hidden = !words.length || shown > 0;
}
function changed() {
  render(); paintIcons($('p-queue')); applyRepeat(); probeMissing();
  if (S.rememberQueue) wr('queue.json', q);
}
const applyRepeat = () => send('set_property', 'loop-file', q.repeat === 'one' ? 'inf' : 'no');
function flushHist() {
  if (histDirty) {
    const keep = Object.entries(hist).sort((a, b) => b[1].at - a[1].at).slice(0, 300);
    hist = Object.fromEntries(keep); wr('history.json', hist); histDirty = false;
  }
  if (setDirty) { wr('settings.json', S); setDirty = false; }
}
setInterval(flushHist, 10_000);

function renderRecent() {
  const items = Object.entries(hist).filter(([, h]) => h.at).sort((a, b) => b[1].at - a[1].at).slice(0, 6);
  $('rtitle').hidden = !items.length;
  $('recent').replaceChildren(...items.map(([k, h], i) => {
    const li = document.createElement('li'); li.style.animationDelay = i * 50 + 'ms'; li.title = h.p ?? k; li.onclick = () => openPath(h.p ?? k);
    const b = document.createElement('b'); b.textContent = prettyName(h.p ?? k);
    const s = document.createElement('small'); const left = h.dur ? Math.max(0, h.dur - h.pos) : 0;
    s.textContent = h.dur && h.pos > 15 && h.pos < h.dur - 30 ? `${fmt(left)} left · resumes at ${fmt(h.pos)}` : h.dur ? fmt(h.dur) : '';
    li.append(b, s);
    if (h.dur && h.pos > 15) { const pb = document.createElement('i'); pb.className = 'pb'; pb.style.width = Math.min(100, (h.pos / h.dur) * 100) + '%'; li.append(pb); }
    return li;
  }));
}

const FIELDS: [keyof Settings, string, string, 'bool' | 'num' | 'text' | string[]][] = [
  ['autoQueue', 'Queue related files', 'Add the other episodes in the folder when you open one', 'bool'],
  ['wholeFolder', 'Queue the whole folder', 'When nothing looks like an episode (clips, recordings, random videos), queue every video in the folder', 'bool'],
  ['sensitivity', 'Matching sensitivity', 'balanced = confident matches only; loose also adds likely ones', ['strict', 'balanced', 'loose']],
  ['scanSubfolders', 'Scan subfolders', 'Look in folders below the opened file too', 'bool'],
  ['sameCategory', 'Same media type only', 'Video with video, audio with audio', 'bool'],
  ['autoplayNext', 'Play next automatically', 'Continue with the queue when a file ends', 'bool'],
  ['includeAll', 'Always include everything in the folder', 'Skip matching and queue every compatible file', 'bool'],
  ['rememberQueue', 'Remember the queue', 'Restore it the next time Flux starts', 'bool'],
  ['maxAuto', 'Longest automatic queue', 'Files', 'num'],
  ['hideAfter', 'Hide controls after', 'Seconds without moving the mouse', 'num'],
  ['thumbnails', 'Preview on the seek bar', 'Show a frame when you point at the seek bar (made in the background)', 'bool'],
  ['autoSkip', 'Intro / outro skipping', 'ask = show a Skip button; auto = skip when it starts (with Undo)', ['off', 'ask', 'auto']],
  ['mediaKeys', 'Media keys', 'Play/pause, next and previous keys work even when Flux is in the background', 'bool'],
  ['autoSubs', 'Match subtitles automatically', 'Pick the subtitle file that belongs to the episode', 'bool'],
  ['subLang', 'Preferred subtitle language', 'Three-letter code: eng, ara, jpn, fra…', 'text'],
  ['keepInTray', 'Keep running in the tray', 'Closing the window keeps Flux ready next to the clock, so the next video opens instantly. Quit from the tray icon', 'bool'],
  ['mpvPath', 'mpv location', 'Blank = the copy that comes with Flux. File or folder. Restart to apply', 'text'],
];
const LIMITS: Partial<Record<keyof Settings, [number, number]>> = { maxAuto: [1, 5000], hideAfter: [1, 60] };
function buildSettings() {
  $('fields').replaceChildren(...FIELDS.map(([key, label, hint, kind]) => {
    const row = document.createElement('div'); row.className = 'srow';
    const t = document.createElement('div'); const st = document.createElement('strong'); st.textContent = label; const sm = document.createElement('small'); sm.textContent = hint; t.append(st, sm);
    let el: HTMLInputElement | HTMLSelectElement;
    if (Array.isArray(kind)) { el = document.createElement('select'); kind.forEach(o => el.append(new Option(o, o))); el.value = String(S[key]); }
    else { el = document.createElement('input'); el.type = kind === 'bool' ? 'checkbox' : kind === 'num' ? 'number' : 'text'; if (kind === 'bool') { (el as HTMLInputElement).checked = !!S[key]; el.className = 'switch'; } else el.value = String(S[key]); }
    el.onchange = () => {
      const [lo, hi] = LIMITS[key] ?? [1, 5000];
      const v = kind === 'bool' ? (el as HTMLInputElement).checked : kind === 'num' ? Math.max(lo, Math.min(hi, +el.value || (DEF[key] as number))) : el.value;
      (S as any)[key] = v; setDirty = true; flushHist();
      if (key === 'rememberQueue') wr('queue.json', v ? q : null);
      if (key === 'mediaKeys') invoke<string[]>('media_keys', { on: v }).then(t => { if (v && t.length) toast('Another program already owns: ' + t.join(', ')); });
      if (key === 'thumbnails' && v) { thumbFor = ''; startThumbs(); }
      if (key === 'keepInTray') invoke('set_tray', { on: v }).catch(() => {});
    };
    row.append(t, el); return row;
  }));
}
function openSettings() { buildSettings(); closeMenu(); modal = true; syncRect(); ($('settings') as HTMLDialogElement).showModal(); }

// ---- updates: from the GitHub releases, signed; checked quietly a little after start ----
let updBusy = false;
async function checkUpdate(manual: boolean) {
  if (updBusy) return;
  updBusy = true;
  try {
    const u = await checkForUpdate();
    if (!u) { if (manual) toast('Flux is up to date'); return; }
    const go = async () => {
      toast(`Downloading Flux ${u.version}…`, undefined, 600000);
      flushHist();
      try { await u.downloadAndInstall(); } catch (e) { toast('Update failed: ' + String(e)); }
    };
    if (manual) { ($('settings') as HTMLDialogElement).close(); }
    toast(`Flux ${u.version} is available`, { label: 'Update now', fn: go }, manual ? 30000 : 15000);
  } catch (e) { if (manual) toast('Could not check for updates: ' + String(e)); }
  finally { updBusy = false; }
}

/** One-time fixes to settings saved by older versions. */
function migrate() {
  if (S.v >= 2) return;
  if (/mpv player/i.test(S.mpvPath)) S.mpvPath = '';                       // the installer ships its own mpv
  if (/fake-whisper/i.test(S.wExe) || (S.wFlavor === 'openai' && !S.wExe)) { S.wExe = ''; S.wModel = ''; S.wFlavor = 'cpp'; }
  S.wAuto = !S.wExe;                                                       // keep a Whisper someone set up by hand
  S.v = 2; setDirty = true;
}

// ---- wiring ----
paintIcons();
$('bplay').onclick = () => act('toggle'); $('bprev').onclick = () => act('prev'); $('bnext').onclick = () => act('next');
$('bq').onclick = () => act('queue'); $('bch').onclick = () => act('chapters'); $('bopen').onclick = () => act('open'); $('bfs').onclick = () => act('fs');
$('baud').onclick = () => audioMenu(); $('bsub').onclick = () => act('subpanel'); $('bmute').onclick = () => act('mute');
$('eopen').onclick = () => act('open'); $('efolder').onclick = () => act('folder');
$('spd').onclick = () => speedMenu(); $('bclip').onclick = () => clipMenu();
$('baud').title = 'Audio: tracks, mix all tracks, even out loudness (A cycles tracks)';
const qs = $('qsearch') as HTMLInputElement;
qs.oninput = () => filterQueue();
qs.onkeydown = e => {
  if (e.key === 'Escape') { e.stopPropagation(); qs.value = ''; filterQueue(); qs.blur(); }
  if (e.key === 'Enter') { const li = [...$('list').children].find(x => !x.classList.contains('miss')) as HTMLElement | undefined; li?.click(); qs.blur(); }
};
$('bupd').onclick = () => checkUpdate(true);
$('bset').onclick = openSettings; $('eset').onclick = openSettings;
$('settings').addEventListener('close', () => { modal = false; syncRect(); });
$('qadd').onclick = () => openFiles(true);
$('qshuf').onclick = () => { q.shuffle(); changed(); };
$('qrep').onclick = () => { q.repeat = q.repeat === 'off' ? 'all' : q.repeat === 'all' ? 'one' : 'off'; changed(); };
$('qclr').onclick = () => { scanGen++; q.clear(); changed(); };
document.querySelectorAll<HTMLElement>('#tabs button').forEach(b => { b.onclick = () => setTab(b.dataset.tab as typeof tab); });
($('vol') as HTMLInputElement).oninput = e => { const v = +(e.target as HTMLInputElement).value; setVol(v); send('set_property', 'volume', v); };

getCurrentWebview().onDragDropEvent(e => {
  const p = e.payload;
  if (p.type === 'enter' || p.type === 'over') { document.body.classList.add('dropping'); return; }
  document.body.classList.remove('dropping');
  if (p.type !== 'drop') return;
  const s = $('side').getBoundingClientRect(), d = devicePixelRatio, x = p.position.x / d, y = p.position.y / d;
  dropFiles(p.paths, $('side').classList.contains('open') && x >= s.left && x <= s.right && y >= s.top && y <= s.bottom); // drop on the queue = add
});

(async function init() {
  const [s, h, qs, pf, file] = await Promise.all([rd('settings.json'), rd('history.json'), rd('queue.json'), rd('prefs.json'), invoke<string | null>('initial_file')]);
  S = { ...DEF, ...(s ?? {}) }; migrate(); hist = h ?? {}; prefs = pf ?? {};
  if (S.rememberQueue && qs && !file) { q = Queue.from(qs); render(); }
  setVol(S.volume); whisperUi(); bindWhisper(); bindSubStyle(); subStyleUi(); renderRecent(); renderChapters(); setTab('queue', false);
  invoke('set_tray', { on: S.keepInTray }).catch(() => {});
  getVersion().then(v => { $('ver').textContent = 'Flux ' + v; }).catch(() => {});
  preloading = !!file; booted = true; syncRect(); // with a file, mpv may already be drawing it (see early_start in lib.rs)
  await Promise.all([
    listen<string>('open-file', e => openAny(e.payload)), // second launch from Explorer (or the tray copy) lands here
    listen('to-tray', () => { // window closed into the tray: stop playing, remember where we were
      flushHist(); closeMenu();
      if (document.body.classList.contains('fs')) toggleFs();
      send('stop'); unload();
    }),
    listen<{ path: string; dur: number }>('dur', e => { durs[pkey(e.payload.path)] = e.payload.dur; clearTimeout(renderTimer); renderTimer = window.setTimeout(render, 300); }),
    listen<{ id: number; idx: number; data: string }>('thumb', e => {
      if (e.payload.id !== thumbGen) return;
      thumbs[e.payload.idx] = e.payload.data;
      if (!accentDone) { accentDone = true; accentFrom(e.payload.data); }
    }),
    listen<string>('media-key', e => act({ playpause: 'toggle', next: 'next', prev: 'prev', stop: 'pause' }[e.payload] ?? '')),
    listen<string>('whisper-log', e => whisperLog(e.payload)),
    listen<{ ok: boolean; srt: string; error: string }>('whisper-done', e => whisperDone(e.payload)),
    listen<{ ok: boolean; out: string; error: string }>('clip-done', e => clipDone(e.payload)),
    listen<string>('mpv', e => { let m; try { m = JSON.parse(e.payload); } catch { return; } if (holding) held.push(m); else onMpv(m); }),
  ]);
  invoke<string[]>('media_keys', { on: S.mediaKeys }).then(t => { if (t.length) toast('Media keys taken by another program: ' + t.join(', ')); }).catch(() => {});
  detectWhisper(false);
  const r = $('video').getBoundingClientRect(), d = devicePixelRatio;
  try {
    const host = await invoke<number>('host_create', { x: Math.round(r.left * d), y: Math.round(r.top * d), w: Math.round(r.width * d), h: Math.round(r.height * d) });
    const pre = await invoke<string | null>('mpv_start', { host, inputConf, mpvPath: S.mpvPath });
    [['time-pos', 1], ['duration', 2], ['pause', 3], ['volume', 4], ['speed', 5], ['mute', 6], ['ab-loop-a', 7], ['ab-loop-b', 8], ['sub-delay', 9], ['video-zoom', 10]]
      .forEach(([n, i]) => send('observe_property', i, n));
    applySubStyle(); applyAudio();
    if (pre) adopt(pre);
    else { send('set_property', 'volume', S.volume); preloading = false; if (file) openAny(file); else syncRect(); }
  } catch (e) { $('err').textContent = String(e); preloading = false; syncRect(); }
  finally { holding = false; held.splice(0).forEach(onMpv); } // events that came in meanwhile, in order
  setTimeout(() => checkUpdate(false), 8000);
})();
