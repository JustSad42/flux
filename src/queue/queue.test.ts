import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Queue } from './queue.ts';

const P = (n: string) => `C:\\a\\${n}.mkv`;
const mk = () => { const q = new Queue(); q.open(P('E1')); q.mergeAuto(['E1', 'E2', 'E3'].map(P)); return q; };
const paths = (q: Queue) => q.items.map(i => i.path);

test('open + merge: auto items in order, current preserved', () => {
  const q = mk();
  assert.deepEqual(paths(q), ['E1', 'E2', 'E3'].map(P));
  assert.equal(q.current!.path, P('E1'));
});

test('manual items added during the scan survive it', () => {
  const q = new Queue(); q.open(P('E1'));
  q.add(['C:\\b\\X.mkv', 'c:\\A\\e2.MKV']);
  q.mergeAuto(['E1', 'E2', 'E3'].map(P));
  assert.deepEqual(paths(q), [P('E1'), 'c:\\A\\e2.MKV', P('E3'), 'C:\\b\\X.mkv']);
  assert.equal(q.items[1].auto, false);
});

test('opening another file replaces auto items but keeps manual ones', () => {
  const q = mk(); q.add(['D:\\m\\mine.mp4']);
  assert.equal(q.open('C:\\z\\New.mkv'), true);
  assert.deepEqual(paths(q), ['C:\\z\\New.mkv', 'D:\\m\\mine.mp4']);
  assert.equal(q.open('d:\\M\\MINE.mp4'), false); // already queued: jump, no rescan
  assert.equal(q.cur, 1);
  q.open('C:\\z\\App.mkv', true);
  assert.equal(q.items.length, 3);
});

test('no duplicates; reorder keeps the playing item and protects the moved one', () => {
  const q = mk();
  assert.equal(q.add([P('e2'), 'C:\\n\\1.mkv', 'C:\\n\\1.mkv']), 1);
  q.jump(1); q.move(2, 0);
  assert.equal(q.current!.path, P('E2'));
  assert.equal(q.items[0].path, P('E3'));
  assert.equal(q.items[0].auto, false);
  q.open('C:\\q\\Other.mkv');
  assert.ok(paths(q).includes(P('E3'))); // moved item stays
});

test('remove, clear, next/prev, repeat all', () => {
  const q = mk(); q.jump(1);
  assert.equal(q.remove(0), false); assert.equal(q.cur, 0);
  assert.equal(q.remove(0), true);
  q.clear(); assert.deepEqual(paths(q), [P('E3')]);
  const r = mk(); r.jump(2);
  assert.equal(r.nextIndex(), -1); r.repeat = 'all'; assert.equal(r.nextIndex(), 0);
  r.jump(0); assert.equal(r.prevIndex(), 2);
});

test('shuffle keeps current and everything before it, same members', () => {
  const q = new Queue(); q.add(Array.from({ length: 20 }, (_, i) => `C:\\f${i}.mkv`)); q.jump(3);
  const before = paths(q);
  q.shuffle();
  assert.deepEqual(paths(q).slice(0, 4), before.slice(0, 4));
  assert.deepEqual([...paths(q)].sort(), [...before].sort());
  assert.notDeepEqual(paths(q), before);
});

test('persistence round trip, bad data ignored', () => {
  const q = mk(); q.repeat = 'one'; q.jump(2);
  const r = Queue.from(JSON.parse(JSON.stringify(q)));
  assert.deepEqual([r.cur, r.repeat, paths(r)], [2, 'one', paths(q)]);
  assert.equal(Queue.from({ items: [{ nope: 1 }, null] }).items.length, 0);
  assert.equal(Queue.from(null).cur, -1);
});
