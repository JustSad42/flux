// Queue state, no I/O. Items found by folder discovery are `auto`; everything the user adds or moves is manual and survives discovery.
export type Item = { path: string; auto: boolean };
export type Repeat = 'off' | 'one' | 'all';

export const pkey = (p: string) => p.replace(/\//g, '\\').toLowerCase(); // Windows paths are case-insensitive

export class Queue {
  items: Item[] = [];
  cur = -1;
  repeat: Repeat = 'off';
  get current(): Item | undefined { return this.items[this.cur]; }
  indexOf(path: string) { const k = pkey(path); return this.items.findIndex(i => pkey(i.path) === k); }

  /** Play a file the user opened. Returns false if it was already queued (just jumps, no rescan needed). */
  open(path: string, append = false): boolean {
    const i = this.indexOf(path);
    if (i >= 0) { this.cur = i; return false; }
    if (append) { this.items.push({ path, auto: false }); this.cur = this.items.length - 1; return true; }
    this.items = [{ path, auto: true }, ...this.items.filter(x => !x.auto)];
    this.cur = 0;
    return true;
  }

  /** Folder scan finished: folder files go in sorted order, manual items keep their flag, manual items from elsewhere follow. */
  mergeAuto(paths: string[]) {
    const here = this.current?.path;
    const manual = new Map(this.items.filter(i => !i.auto).map(i => [pkey(i.path), i]));
    const seen = new Set<string>();
    const list = paths.map(p => { seen.add(pkey(p)); return manual.get(pkey(p)) ?? { path: p, auto: true }; });
    this.items = [...list, ...this.items.filter(i => !i.auto && !seen.has(pkey(i.path)))];
    this.cur = here ? Math.max(0, this.indexOf(here)) : -1;
  }

  add(paths: string[], next = false): number {
    const fresh = [...new Map(paths.filter(p => this.indexOf(p) < 0).map(p => [pkey(p), p])).values()];
    const at = next ? this.cur + 1 : this.items.length;
    this.items.splice(at, 0, ...fresh.map(path => ({ path, auto: false })));
    return fresh.length;
  }

  /** Returns true when the playing item was removed (cur now points at what followed it, or past the end). */
  remove(i: number): boolean {
    if (i < 0 || i >= this.items.length) return false;
    const wasCurrent = i === this.cur;
    this.items.splice(i, 1);
    if (i < this.cur) this.cur--;
    return wasCurrent;
  }

  /** Keeps the playing item so playback is not cut. */
  clear() { const c = this.current; this.items = c ? [{ ...c }] : []; this.cur = c ? 0 : -1; }

  move(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= this.items.length || to >= this.items.length) return;
    const c = this.current, [it] = this.items.splice(from, 1);
    it.auto = false;
    this.items.splice(to, 0, it);
    this.cur = c ? this.items.indexOf(c) : -1;
  }

  jump(i: number) { if (i >= 0 && i < this.items.length) this.cur = i; }

  /** Index to play after the current one, or -1. Does not move `cur`. */
  nextIndex(): number {
    if (this.cur + 1 < this.items.length) return this.cur + 1;
    return this.repeat === 'all' && this.items.length ? 0 : -1;
  }
  prevIndex(): number {
    if (this.cur > 0) return this.cur - 1;
    return this.repeat === 'all' && this.items.length ? this.items.length - 1 : -1;
  }

  /** Shuffle what comes after the current item. */
  shuffle(rnd: () => number = Math.random) {
    const a = this.items;
    for (let i = a.length - 1; i > this.cur + 1; i--) {
      const j = this.cur + 1 + Math.floor(rnd() * (i - this.cur));
      [a[i], a[j]] = [a[j], a[i]];
    }
  }

  toJSON() { return { items: this.items, cur: this.cur, repeat: this.repeat }; }
  static from(o: unknown): Queue {
    const q = new Queue(), x = o as Partial<Queue> | null;
    if (x && Array.isArray(x.items)) {
      q.items = x.items.filter(i => i && typeof i.path === 'string').map(i => ({ path: i.path, auto: !!i.auto }));
      q.cur = Number.isInteger(x.cur) && x.cur! < q.items.length ? x.cur! : q.items.length ? 0 : -1;
      if (x.repeat === 'one' || x.repeat === 'all') q.repeat = x.repeat;
    }
    return q;
  }
}
