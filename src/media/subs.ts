// Subtitle matching: pick the subtitle files that belong to a video, best first. Pure, no I/O.
import { base, parse } from '../queue/match';

const SUB = new Set(['srt', 'ass', 'ssa', 'vtt', 'sub', 'sup']);
const extOf = (n: string) => { const b = base(n), i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : ''; };
export const isSub = (n: string) => SUB.has(extOf(n));

// language words/codes found in subtitle file names -> ISO 639-2 (what mpv's track language uses)
const L: Record<string, string> = {
  en: 'eng', eng: 'eng', english: 'eng', ar: 'ara', ara: 'ara', arabic: 'ara', fr: 'fra', fre: 'fra', fra: 'fra', french: 'fra',
  es: 'spa', spa: 'spa', spanish: 'spa', de: 'deu', ger: 'deu', deu: 'deu', german: 'deu', ja: 'jpn', jp: 'jpn', jpn: 'jpn', japanese: 'jpn',
  ko: 'kor', kor: 'kor', korean: 'kor', zh: 'zho', chi: 'zho', zho: 'zho', chinese: 'zho', pt: 'por', por: 'por', portuguese: 'por',
  ru: 'rus', rus: 'rus', russian: 'rus', it: 'ita', ita: 'ita', italian: 'ita', tr: 'tur', tur: 'tur', turkish: 'tur',
};

/** Two-letter codes ("it", "de", "en") are also ordinary words, so they only count as the last word before the extension. */
export function subLang(name: string): string | null {
  const b = base(name), t = b.slice(0, b.lastIndexOf('.')).toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (let i = t.length - 1; i >= 0; i--) if (L[t[i]] && (t[i].length > 2 || i === t.length - 1)) return L[t[i]];
  return null;
}

export type SubCand = { name: string; lang: string | null; score: number };
const stemOf = (n: string) => base(n).replace(/\.[^.]+$/, '').toLowerCase();

export function pickSubs(video: string, files: string[], pref = 'eng'): SubCand[] {
  const v = parse(video);
  if (!v) return [];
  const vs = stemOf(video), out: SubCand[] = [];
  for (const n of files) {
    if (!isSub(n)) continue;
    const s = parse(n, true), ss = stemOf(n);
    let score = 0;
    if (ss.startsWith(vs) || vs.startsWith(ss)) score = 90; // "Movie.mkv" + "Movie.en.srt"
    else if (v.num != null && s && s.num === v.num && (s.season ?? null) === (v.season ?? null)
      && (!v.series || !s.series || v.series.startsWith(s.series) || s.series.startsWith(v.series))) score = v.series && s.series === v.series ? 100 : 70;
    if (!score) continue;
    const lang = subLang(n);
    score += lang === pref ? 20 : lang == null ? 5 : 0;
    if (extOf(n) === 'ass' || extOf(n) === 'ssa') score += 2;
    out.push({ name: n, lang, score });
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}
