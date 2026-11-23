// Settings: defaults, the Settings dialog's fields, and fixes for files saved by older versions.
import type { Learned } from './media/markers';
import type { Opts } from './queue/match';

export const DEF = {
  v: 0, // settings version, see migrate()
  autoQueue: true, sensitivity: 'balanced' as Opts['sensitivity'], scanSubfolders: false, sameCategory: true, wholeFolder: true,
  autoplayNext: true, includeAll: false, rememberQueue: false, maxAuto: 200, mpvPath: '', volume: 100, hideAfter: 3,
  autoSkip: 'ask' as 'off' | 'ask' | 'auto', mediaKeys: true, autoSubs: true, subLang: 'eng', thumbnails: true,
  // Whisper: wAuto = these were filled in from what Flux found on the PC (and may be refreshed); false once edited by hand
  wFlavor: 'cpp', wExe: '', wModel: '', wLang: '', wTranslate: false, wTemplate: '', wVad: '', wAuto: true,
  wVadOn: false, // speech detection: great for talking, but drops real lines in game audio, so it is opt-in
  subScale: 1, subPos: 100, subBox: false, normalize: false, keepInTray: true, clipMode: 'copy' as 'copy' | 'exact' | 'small',
};
export type Settings = typeof DEF;
export type Hist = Record<string, { pos: number; dur: number; at: number; p?: string }>; // p = path with its original case
export type Prefs = Record<string, Learned & { a?: string; s?: string; mix?: boolean }>; // per show (or folder): audio/subtitle language, mix all audio tracks, learned intro/outro

export const FIELDS: [keyof Settings, string, string, 'bool' | 'num' | 'text' | string[]][] = [
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
export const LIMITS: Partial<Record<keyof Settings, [number, number]>> = { maxAuto: [1, 5000], hideAfter: [1, 60] };

/** One-time fixes to settings saved by older versions. Returns true when something changed (so it gets saved). */
export function migrate(S: Settings): boolean {
  if (S.v >= 2) return false;
  if (/mpv player/i.test(S.mpvPath)) S.mpvPath = '';                       // the installer ships its own mpv
  if (/fake-whisper/i.test(S.wExe) || (S.wFlavor === 'openai' && !S.wExe)) { S.wExe = ''; S.wModel = ''; S.wFlavor = 'cpp'; }
  S.wAuto = !S.wExe;                                                       // keep a Whisper someone set up by hand
  S.v = 2;
  return true;
}
