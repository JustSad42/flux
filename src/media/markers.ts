// Intro/outro markers from chapter names or from what the user skipped before, plus smart-resume rules. Pure, no I/O.
export type Chap = { title?: string; time: number };
export type BandKind = 'intro' | 'outro' | 'recap' | 'preview';
export type Band = { kind: BandKind; start: number; end: number; source: 'chapter' | 'learned' };
export type Learned = { intro?: { start: number; end: number }; outro?: number }; // outro = seconds before the end

const RULES: [BandKind, RegExp][] = [
  ['intro', /^(op|opening|intro|introduction|title sequence)\s*\d*\b|^オープニング/i],
  ['outro', /^(ed|ending|outro|end credits|credits|closing)\s*\d*\b|^エンディング/i],
  ['recap', /^(recap|previously)\b/i],
  ['preview', /^(preview|next episode|next time)\b|^次回予告/i],
];

/** Bands from chapter titles; when the file has none, from what was learned for this show. */
export function markersFor(ch: Chap[], dur: number, learned?: Learned): Band[] {
  const bands: Band[] = [];
  ch.forEach((c, i) => {
    const kind = RULES.find(([, re]) => re.test((c.title ?? '').trim()))?.[0];
    if (kind) bands.push({ kind, start: c.time, end: ch[i + 1]?.time ?? dur, source: 'chapter' });
  });
  if (learned?.intro && !bands.some(b => b.kind === 'intro')) bands.push({ kind: 'intro', ...learned.intro, source: 'learned' });
  if (learned?.outro && dur > learned.outro && !bands.some(b => b.kind === 'outro')) bands.push({ kind: 'outro', start: dur - learned.outro, end: dur, source: 'learned' });
  return bands.filter(b => b.end > b.start).sort((a, b) => a.start - b.start);
}
export const bandAt = (bands: Band[], t: number) => bands.find(b => t >= b.start - 0.5 && t < b.end - 0.5);

/** Previous/next chapter: "previous" restarts the current chapter first, like a music player. */
export function chapterTarget(ch: Chap[], t: number, dir: -1 | 1): number | null {
  if (!ch.length) return null;
  const cur = ch.reduce((a, c, i) => (c.time <= t + 0.25 ? i : a), 0);
  if (dir < 0) return t - ch[cur].time > 3 ? ch[cur].time : cur > 0 ? ch[cur - 1].time : 0;
  return cur + 1 < ch.length ? ch[cur + 1].time : null; // null = last chapter: caller goes to the next file
}

/** Where to start a file that was watched before. Near the end counts as finished; otherwise back up a little for context. */
export function resumeStart(h?: { pos: number; dur: number }): { start: number; finished: boolean } {
  if (!h || h.pos < 15) return { start: 0, finished: false };
  if (h.dur && h.pos >= h.dur - Math.max(30, h.dur * 0.03)) return { start: 0, finished: true };
  return { start: Math.max(0, h.pos - 3), finished: false };
}
