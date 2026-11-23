// Small helpers shared by the UI modules.
import { invoke } from '@tauri-apps/api/core';
import { base } from './queue/match';

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** JSON files in Flux's data folder (settings, history, prefs, queue). A missing or broken file reads as null. */
export const rd = async (n: string) => { try { const t = await invoke<string | null>('store_read', { name: n }); return t ? JSON.parse(t) : null; } catch { return null; } };
export const wr = (n: string, v: unknown) => { invoke('store_write', { name: n, text: JSON.stringify(v) }).catch(() => {}); };

/** 75 → "1:15", 3725 → "1:02:05". */
export const fmt = (s: number) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
};

/** "Show.Name.[1080p].mkv" → "Show Name": what the queue and title bar show. */
export const prettyName = (path: string) => {
  const stem = base(path).replace(/\.[^.]+$/, ''), t = stem.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t || stem;
};

export const sleepMs = (ms: number) => new Promise(r => setTimeout(r, ms));
