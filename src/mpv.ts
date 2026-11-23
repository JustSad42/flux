// Talking to mpv over its JSON pipe (Rust forwards the lines; events and replies come back as "mpv" events).
import { invoke } from '@tauri-apps/api/core';

let up = false;
let onError: (e: string) => void = () => {};
/** Errors are shown only while mpv is meant to be running (not during start-up or a restart after a crash). */
export function mpvRunning(on: boolean) { up = on; }
export function onMpvError(fn: (e: string) => void) { onError = fn; }

export const send = (...command: unknown[]) =>
  invoke('mpv_cmd', { line: JSON.stringify({ command }) }).catch(e => { if (up) onError(String(e)); });
export const osd = (t: string) => send('show-text', t, 1500);

let reqId = 100;
const waiting = new Map<number, (v: any) => void>();
/** Send an mpv command and wait for its answer (null on error, when mpv is gone, or after 2 s). */
export const ask = (...command: unknown[]) => new Promise<any>(res => {
  const id = ++reqId;
  waiting.set(id, res);
  setTimeout(() => { if (waiting.delete(id)) res(null); }, 2000);
  invoke('mpv_cmd', { line: JSON.stringify({ command, request_id: id }) }).catch(() => { if (waiting.delete(id)) res(null); });
});

/** An answer to ask() is consumed here (true); everything else is an event for the page. */
export function takeReply(m: any): boolean {
  const f = m.request_id != null ? waiting.get(m.request_id) : undefined;
  if (!f) return false;
  waiting.delete(m.request_id);
  f(m.error === 'success' ? m.data : null);
  return true;
}

/** mpv went away: nobody will answer the questions still waiting. */
export function dropReplies() { for (const f of waiting.values()) f(null); waiting.clear(); }
