// Inline SVG icons (24x24, stroke = currentColor). Buttons ask for them with data-i="name".
const f = (d: string) => `<path d="${d}" fill="currentColor" stroke="none"/>`;
export const ICON: Record<string, string> = {
  play: f('M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z'),
  pause: '<rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/>',
  prev: '<path d="M6 5v14"/>' + f('M19 5.8v12.4a.8.8 0 0 1-1.25.66L9.4 12.66a.8.8 0 0 1 0-1.32l8.35-6.2A.8.8 0 0 1 19 5.8Z'),
  next: '<path d="M18 5v14"/>' + f('M5 5.8v12.4a.8.8 0 0 0 1.25.66l8.35-6.2a.8.8 0 0 0 0-1.32l-8.35-6.2A.8.8 0 0 0 5 5.8Z'),
  vol: f('M11 5 6 9H3v6h3l5 4V5Z') + '<path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
  mute: f('M11 5 6 9H3v6h3l5 4V5Z') + '<path d="m16 9 5 6M21 9l-5 6"/>',
  queue: '<path d="M4 6h11M4 12h11M4 18h7"/>' + f('m17 14 5 3.5-5 3.5Z'),
  open: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>',
  fs: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  audio: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>',
  subs: '<rect x="3" y="5" width="18" height="14" rx="3.5"/><path d="M7 11h4M13 11h4M7 15h7"/>',
  skip: f('M5 5.5v13l8.5-6.5Z') + '<path d="M17 5v14"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  top: '<path d="M6 4h12M12 20V9m0 0-5 5m5-5 5 5"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  shuffle: '<path d="M4 7h3c5 0 5 10 10 10h3m0 0-3-3m3 3-3 3M4 17h3c1.5 0 2.6-.8 3.5-2M14 9.2C14.8 8.4 15.8 7 17 7h3m0 0-3-3m3 3-3 3"/>',
  repeat: '<path d="M4 11V9a3 3 0 0 1 3-3h13m0 0-3-3m3 3-3 3M20 13v2a3 3 0 0 1-3 3H4m0 0 3 3m-3-3 3-3"/>',
  repeat1: '<path d="M4 11V9a3 3 0 0 1 3-3h13m0 0-3-3m3 3-3 3M20 13v2a3 3 0 0 1-3 3H4m0 0 3 3m-3-3 3-3M11 10.5l1.4-.9V15"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  chapters: '<path d="M5 4v16"/>' + f('M5 5h13l-3.2 4.5L18 14H5Z'),
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  spark: f('M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8Z'),
  clip: '<circle cx="6" cy="6" r="2.6"/><circle cx="6" cy="18" r="2.6"/><path d="M8.2 7.6 20 17M8.2 16.4 20 7"/>',
  gauge: '<path d="M4.5 17a8.5 8.5 0 1 1 15 0"/><path d="m12 13 4-5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 11v5M9.5 13.5 12 16l2.5-2.5"/>',
  cc: '<rect x="3" y="5" width="18" height="14" rx="3.5"/><path d="M10.5 10.2a2.4 2.4 0 1 0 0 3.6M17 10.2a2.4 2.4 0 1 0 0 3.6"/>',
};
export function paintIcons(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-i]').forEach(b => {
    const k = b.dataset.i!;
    if (b.dataset.painted === k) return;
    b.dataset.painted = k;
    b.querySelector('svg')?.remove();
    b.insertAdjacentHTML('afterbegin', `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k] ?? ''}</svg>`);
  });
}
