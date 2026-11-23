// Things drawn over the picture: the toast, the pop-up menu, and the holes they need in mpv's window.
// mpv's native window sits on top of the page, so every visible `.float.on` element gets a hole cut into that window
// (rounded like the element); the video itself never changes size. A transparent web view does not work instead.
import { invoke } from '@tauri-apps/api/core';
import { $ } from './util';

let videoShown: (() => boolean) | null = null;
/** Called once the video window exists: from then on it is placed over #video whenever `shown()` says so. */
export function hostReady(shown: () => boolean) { videoShown = shown; syncRect(); }

let rectQueued = false;
/** Re-place the video window and its holes on the next frame (many changes in one frame cost one call). */
export function syncRect() {
  if (rectQueued) return;
  rectQueued = true;
  requestAnimationFrame(() => { rectQueued = false; placeHost(); });
}
function placeHost() {
  if (!videoShown) return;
  const v = $('video').getBoundingClientRect(), d = devicePixelRatio, show = videoShown();
  const cuts: number[][] = [];
  if (show) document.querySelectorAll<HTMLElement>('#video .float.on').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    const rad = Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, r.width / 2, r.height / 2);
    cuts.push([Math.floor((r.left - v.left) * d), Math.floor((r.top - v.top) * d), Math.ceil(r.width * d) + 1, Math.ceil(r.height * d) + 1, Math.round(rad * d)]);
  });
  invoke('host_rect', { x: Math.round(v.left * d), y: Math.round(v.top * d), w: Math.round(v.width * d), h: Math.round(v.height * d), show, cuts }).catch(() => {});
}
/** Show or hide a floating element (and its hole). */
export function setFloat(el: HTMLElement, on: boolean) {
  el.classList.toggle('on', on);
  syncRect();
}
new ResizeObserver(syncRect).observe($('video'));
new ResizeObserver(syncRect).observe($('bar'));

let msgTimer = 0;
/** Short message floating at the top, optionally with one action button (e.g. "Start over"). Empty text hides it. */
export function toast(text: string, action?: { label: string; fn: () => void }, ms = 6000) {
  $('msg').textContent = text;
  const b = $('msgact') as HTMLButtonElement;
  b.hidden = !action; $('toast').classList.toggle('act', !!action);
  if (action) { b.textContent = action.label; b.onclick = () => { action.fn(); toast(''); }; }
  clearTimeout(msgTimer);
  setFloat($('toast'), !!text);
  if (text) msgTimer = window.setTimeout(() => toast(''), ms);
}

// ---- one pop-up menu above the bar (speed, audio, clip modes), anchored on the button that opened it ----
export type MenuItemDef = { label?: string; note?: string; on?: boolean; tog?: boolean; fn?: () => void; sep?: boolean; head?: string };
let menuFor = '';
let onOpen = () => {};
/** Runs whenever a menu opens (the page keeps its controls up meanwhile). */
export function onMenuOpen(fn: () => void) { onOpen = fn; }
export const menuOpen = () => $('menu').classList.contains('on');

/** Opens the menu above `anchor` (an element id). Opening it again from the same button closes it. */
export function openMenu(anchor: string, items: MenuItemDef[]) {
  const m = $('menu');
  if (menuOpen() && menuFor === anchor) return closeMenu();
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
  m.classList.add('on'); onOpen();
  const vr = $('video').getBoundingClientRect(), sr = $(anchor).getBoundingClientRect(), br = $('bar').getBoundingClientRect();
  m.style.left = Math.round(Math.max(8, Math.min(vr.width - m.offsetWidth - 8, sr.left - vr.left + sr.width / 2 - m.offsetWidth / 2))) + 'px';
  m.style.bottom = Math.round(vr.bottom - br.top + 8) + 'px';
  syncRect();
}
export function closeMenu() { if (menuOpen()) setFloat($('menu'), false); menuFor = ''; }
// a click anywhere else closes it (the buttons that open menus toggle it themselves)
document.addEventListener('pointerdown', e => { if (!(e.target as HTMLElement).closest('#menu, #spd, #baud, #bclip')) closeMenu(); });
