// Folder-queue matching: pure functions on file names, no I/O. Rust only lists the folder.
export type Kind = 'video' | 'audio';
export type Conf = 'high' | 'medium' | 'low';
/** `wholeFolder`: when nothing in the folder looks related, queue every same-type file instead of nothing. */
export type Opts = { sensitivity: 'strict' | 'balanced' | 'loose'; sameCategory: boolean; includeAll: boolean; max: number; wholeFolder?: boolean };
export type Parsed = { kind: Kind; tag: string; series: string; season: number | null; num: number | null; stem: string };

const EXT: Record<Kind, string> = {
  video: 'mkv mp4 avi mov wmv webm m4v ts m2ts mts mpg mpeg flv ogv 3gp vob divx rmvb',
  audio: 'mp3 flac wav ogg oga opus m4a aac wma aiff ape mka',
};
const KIND = new Map<string, Kind>(
  (Object.keys(EXT) as Kind[]).flatMap(k => EXT[k].split(' ').map(e => [e, k] as [string, Kind])),
);

export const base = (p: string) => p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1);
export const dirname = (p: string) => {
  const d = p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')));
  return /^[A-Za-z]:$/.test(d) ? d + '\\' : d; // "C:" alone means the current dir on C:, not the drive root
};
export const join = (d: string, rel: string) => (/[\\/]$/.test(d) ? d : d + '\\') + rel;
export const kindOf = (p: string): Kind | null => {
  const n = base(p), i = n.lastIndexOf('.');
  return i > 0 ? KIND.get(n.slice(i + 1).toLowerCase()) ?? null : null;
};

const col = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const natCompare = (a: string, b: string) => col.compare(a, b);

const NOISE = /\b(?:\d{3,4}p|\d{3,4}x\d{3,4}|[xh] ?26[45]|hevc|av1|aac|flac|ac3|dts|10 ?bit|8 ?bit|web ?dl|webrip|blu ?ray|bdrip|brrip|hdtv|dvdrip|remux)\b/gi;
const SEASON = /\b(?:season|s) ?(\d{1,2})\b/i;
const norm = (t: string) => t.replace(new RegExp(SEASON, 'gi'), ' ').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const WORD: Record<string, string> = { part: 'part', pt: 'part', disc: 'disc', disk: 'disc', cd: 'disc', vol: 'vol', volume: 'vol' };

// Recordings are named by date and time: "11-22-2026-07-06", "2026-11-22 07-06-00", "Game 2026.11.22 - 07.06.00.01", "20261122_070600".
const SEP = '[-_. ]';
const YMD = new RegExp(`(?<![\\p{N}])((?:19|20)\\d\\d)${SEP}?(\\d\\d)${SEP}?(\\d\\d)`, 'u');
const DMY = new RegExp(`(?<![\\p{N}])(\\d{1,2})${SEP}(\\d{1,2})${SEP}((?:19|20)\\d\\d)(?![\\p{N}])`, 'u');
const HMS = new RegExp(`^(?:${SEP}|T|${SEP}+-${SEP}+)*(\\d\\d)${SEP}?[h:]?(\\d\\d)(?:${SEP}?[m:]?(\\d\\d))?(?:${SEP}\\d{1,3})?(?![\\p{N}])`, 'u');

/** A date (and time) in the name, as a sortable number, plus where it sits in `s`. */
export function stamp(s: string): { at: number; len: number; key: number } | null {
  const ymd = YMD.exec(s), dmy = DMY.exec(s);
  let m: RegExpExecArray, y: number, mo: number, d: number;
  // the earlier match wins: in "11-22-2026-07-06" the year-first pattern would also fit "2026-07-06"
  if (ymd && (!dmy || ymd.index <= dmy.index)) { m = ymd; y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if (dmy) { // month-day-year unless the first number cannot be a month
    m = dmy; const a = +m[1], b = +m[2]; y = +m[3];
    [mo, d] = a > 12 ? [b, a] : [a, b];
  } else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  let len = m[0].length, h = 0, mi = 0, se = 0;
  const t = HMS.exec(s.slice(m.index + len));
  if (t && +t[1] < 24 && +t[2] < 60 && (t[3] == null || +t[3] < 60)) { h = +t[1]; mi = +t[2]; se = +(t[3] ?? 0); len += t[0].length; }
  return { at: m.index, len, key: ((((y * 12 + mo) * 31 + d) * 24 + h) * 60 + mi) * 60 + se };
}

/** `anyExt` lets other file types (subtitles) go through the same name analysis. */
export function parse(file: string, anyExt = false): Parsed | null {
  const kind = kindOf(file) ?? (anyExt ? 'video' : null);
  if (!kind) return null;
  const name = base(file), stem = name.slice(0, name.lastIndexOf('.'));
  const s = ' ' + stem.replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ').replace(/[._]+/g, ' ').replace(NOISE, ' ') + ' ';
  const seasonIn = (t: string) => { const m = SEASON.exec(t); return m ? +m[1] : null; };
  let m: RegExpExecArray | null, tag = 'num', num: number | null = null, season: number | null = null;
  let before: string, after = '';
  if ((m = /\bs(\d{1,2}) ?e(\d{1,4})\b/i.exec(s)) || (m = /\b(\d{1,2})x(\d{2,3})\b/i.exec(s))) {
    season = +m[1]; num = +m[2]; tag = 'ep'; before = s.slice(0, m.index);
  } else if ((m = /\b(?:(?:episode|ep)\.? ?|e)(\d{1,4})\b/i.exec(s))) {
    num = +m[1]; tag = 'ep'; before = s.slice(0, m.index); season = seasonIn(before);
  } else if ((m = /\b(part|pt|disc|disk|cd|vol|volume) ?(\d{1,3})\b/i.exec(s))) {
    tag = WORD[m[1].toLowerCase()]; num = +m[2]; before = s.slice(0, m.index); season = seasonIn(before);
  } else if (stamp(s)) {
    // a recording: the series is whatever surrounds the date ("Valorant", or nothing), the order is the date
    const st = stamp(s)!;
    return { kind, tag: 'date', series: norm(s.slice(0, st.at) + ' ' + s.slice(st.at + st.len)), season: null, num: st.key, stem: stem.toLowerCase() };
  } else {
    // last standalone number that is not a year
    const all = [...s.matchAll(/(?<![\p{L}\p{N}])(\d{1,4})(?![\p{L}\p{N}])/gu)].filter(x => !/^(19|20)\d\d$/.test(x[1]));
    m = all.length ? all[all.length - 1] : null;
    if (!m) return { kind, tag: 'none', series: norm(s), season: null, num: null, stem };
    num = +m[1]; before = s.slice(0, m.index); after = s.slice(m.index! + m[0].length);
    season = seasonIn(before);
    tag = norm(before) === '' ? 'lead' : 'num';
  }
  const series = tag === 'lead' ? norm(after) : norm(before) || (tag === 'num' ? norm(after) : '');
  return { kind, tag, series, season, num, stem: stem.toLowerCase() };
}

const prefixLen = (a: string, b: string) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };

export function confidence(a: Parsed, c: Parsed): Conf {
  if (a.num == null || c.num == null || a.tag !== c.tag) return 'low';
  if (a.season !== c.season) return a.series === c.series ? 'medium' : 'low'; // next season: loose only
  if (a.series === c.series) return 'high';
  if (a.tag === 'lead') return 'medium';
  return prefixLen(a.series, c.series) >= 0.6 * Math.max(a.series.length, c.series.length) ? 'medium' : 'low';
}

/** Ordered list (anchor included) of the files that belong in the queue. `files` are names relative to the folder. */
export function discover(anchor: string, files: string[], o: Opts): string[] {
  const a = parse(anchor);
  if (!a) return [anchor];
  type E = { n: string; p: Parsed };
  const stems = new Set([a.stem]);
  const pool: E[] = [];
  for (const n of files) {
    const p = parse(n);
    if (n === anchor || !p || base(n).startsWith('.') || (o.sameCategory && p.kind !== a.kind)) continue;
    if (!o.includeAll) {
      const c = confidence(a, p);
      if (c === 'low' || (c === 'medium' && o.sensitivity !== 'loose') || stems.has(p.stem)) continue;
      stems.add(p.stem);
    }
    pool.push({ n, p });
  }
  if (!pool.length && !o.includeAll && o.wholeFolder) return discover(anchor, files, { ...o, includeAll: true, wholeFolder: false });
  const all: E[] = [...pool, { n: anchor, p: a }];
  all.sort(o.includeAll
    ? (x, y) => (x.p.tag === 'date' && y.p.tag === 'date' ? x.p.num! - y.p.num! : 0) || natCompare(x.n, y.n)
    : (x, y) => (a.tag === 'lead' ? 0 : natCompare(x.p.series, y.p.series)) || (x.p.season ?? 0) - (y.p.season ?? 0) || (x.p.num ?? 0) - (y.p.num ?? 0) || natCompare(x.n, y.n));
  let lo = 0, hi = all.length - 1;
  const i = all.findIndex(e => e.n === anchor);
  if (!o.includeAll && o.sensitivity === 'strict' && a.tag !== 'date') { // only the unbroken run of numbers around the anchor
    lo = hi = i;
    while (lo > 0 && Math.abs(all[lo].p.num! - all[lo - 1].p.num!) <= 1) lo--;
    while (hi < all.length - 1 && Math.abs(all[hi + 1].p.num! - all[hi].p.num!) <= 1) hi++;
  }
  const after = Math.min(hi - i, o.max - 1), before = Math.min(i - lo, o.max - 1 - after);
  return all.slice(i - before, i + after + 1).map(e => e.n);
}
