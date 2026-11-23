import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickSubs, subLang, isSub } from './subs.ts';
import { markersFor, bandAt, chapterTarget, resumeStart } from './markers.ts';

test('subtitle language from file names', () => {
  assert.equal(subLang('Show - 03.en.srt'), 'eng');
  assert.equal(subLang('Show.S01E03.Arabic.srt'), 'ara');
  assert.equal(subLang('Show - 03 - It Takes Two.srt'), null); // "it" mid-title is a word, not Italian
  assert.equal(subLang('Show - 03.it.srt'), 'ita');
  assert.ok(isSub('a.ASS') && !isSub('a.mkv'));
});

test('subtitles are matched by episode, not by being in the folder', () => {
  const files = ['Show - 01.en.srt', 'Show - 03.en.srt', 'Show - 03.ar.srt', 'Show - 03.ass', 'Other - 03.srt', 'notes.txt', 'Show - 13.srt'];
  const r = pickSubs('Show - 03.mkv', files, 'eng');
  assert.deepEqual(r.map(x => x.name), ['Show - 03.en.srt', 'Show - 03.ass', 'Show - 03.ar.srt']);
  assert.equal(pickSubs('Show - 03.mkv', files, 'ara')[0].name, 'Show - 03.ar.srt'); // preferred language wins
  assert.deepEqual(pickSubs('Show - 05.mkv', files), []);
});

test('movie subtitles match by name; seasons must agree', () => {
  assert.equal(pickSubs('Heat.1995.mkv', ['Heat.1995.en.srt', 'Alien.srt'])[0].name, 'Heat.1995.en.srt');
  assert.deepEqual(pickSubs('Show.S02E03.mkv', ['Show.S01E03.srt']), []);
  assert.equal(pickSubs('Show.S02E03.mkv', ['Show.S02E03.srt', 'Show.S01E03.srt']).length, 1);
});

test('chapter names become intro/outro bands', () => {
  const ch = [{ title: 'Prologue', time: 0 }, { title: 'Opening', time: 90 }, { title: 'Part A', time: 180 }, { title: 'Ending', time: 1320 }, { title: 'Preview', time: 1410 }];
  const b = markersFor(ch, 1440);
  assert.deepEqual(b.map(x => [x.kind, x.start, x.end]), [['intro', 90, 180], ['outro', 1320, 1410], ['preview', 1410, 1440]]);
  assert.equal(bandAt(b, 100)!.kind, 'intro');
  assert.equal(bandAt(b, 200), undefined);
  assert.equal(markersFor([{ title: 'Operation Start', time: 5 }], 100).length, 0); // "op" must be a word
});

test('learned markers fill in when the file has no chapters; chapters win', () => {
  const learned = { intro: { start: 60, end: 145 }, outro: 120 };
  assert.deepEqual(markersFor([], 1400, learned).map(x => [x.kind, x.start, x.end, x.source]), [['intro', 60, 145, 'learned'], ['outro', 1280, 1400, 'learned']]);
  const withCh = markersFor([{ title: 'OP', time: 10 }, { title: 'x', time: 95 }], 1400, learned);
  assert.equal(withCh.filter(x => x.kind === 'intro').length, 1);
  assert.equal(withCh[0].source, 'chapter');
});

test('chapter navigation: previous restarts first, next leaves the file at the end', () => {
  const ch = [{ time: 0 }, { time: 100 }, { time: 200 }];
  assert.equal(chapterTarget(ch, 150, -1), 100);
  assert.equal(chapterTarget(ch, 101, -1), 0);
  assert.equal(chapterTarget(ch, 150, 1), 200);
  assert.equal(chapterTarget(ch, 250, 1), null);
  assert.equal(chapterTarget([], 10, 1), null);
});

test('smart resume', () => {
  assert.deepEqual(resumeStart(undefined), { start: 0, finished: false });
  assert.deepEqual(resumeStart({ pos: 8, dur: 1400 }), { start: 0, finished: false });
  assert.deepEqual(resumeStart({ pos: 600, dur: 1400 }), { start: 597, finished: false });
  assert.deepEqual(resumeStart({ pos: 1390, dur: 1400 }), { start: 0, finished: true });
  assert.deepEqual(resumeStart({ pos: 600, dur: 0 }), { start: 597, finished: false });
});
