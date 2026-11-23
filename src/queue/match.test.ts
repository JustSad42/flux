import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover, natCompare, parse, Opts } from './match.ts';

const O: Opts = { sensitivity: 'balanced', sameCategory: true, includeAll: false, max: 200 };
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

test('natural sort: 10 after 9', () => {
  const l = ['Episode 10', 'Episode 2', 'Episode 11', 'Episode 1', 'Episode 9', 'Episode 3'].sort(natCompare);
  assert.deepEqual(l, ['Episode 1', 'Episode 2', 'Episode 3', 'Episode 9', 'Episode 10', 'Episode 11']);
});

test('parses every listed naming pattern to a number', () => {
  const cases: [string, number, string][] = [
    ['Episode 01.mkv', 1, 'ep'], ['Show S01E02.mkv', 2, 'ep'], ['Show.S01.E03.mkv', 3, 'ep'],
    ['Show.Name.004.mkv', 4, 'num'], ['Show Name - 05.mkv', 5, 'num'], ['006 - Introduction.mkv', 6, 'lead'],
    ['Part 7.mkv', 7, 'part'], ['Disc 8.mp3', 8, 'disc'], ['[Grp] Show - 09 [1080p][HEVC].mkv', 9, 'num'],
    ['Show - 10 1080p x265.mkv', 10, 'num'],
  ];
  for (const [f, n, t] of cases) { const p = parse(f)!; assert.equal(p.num, n, f); assert.equal(p.tag, t, f); }
  assert.equal(parse('Movie 2019.mkv')!.num, null); // a year is not an episode
});

test('anime folder: opens ep 1, queues 2-5, skips poster/subs/unrelated movie', () => {
  const files = ['Episode 01.mkv', 'Episode 02.mkv', 'Episode 03.mkv', 'Episode 04.mkv', 'Episode 05.mkv', 'poster.jpg', 'subtitles.srt', 'unrelated-movie.mp4'];
  assert.deepEqual(discover('Episode 01.mkv', files, O), files.slice(0, 5));
});

test('season of TV: natural order, other season only when loose', () => {
  const s1 = Array.from({ length: 12 }, (_, i) => `Show.Name.S01E${pad(i + 1)}.1080p.WEB-DL.x265.mkv`);
  const files = [...s1, 'Show.Name.S02E01.1080p.WEB-DL.x265.mkv', 'Other.Show.S01E01.mkv'];
  assert.deepEqual(discover(s1[0], [...files].reverse(), O), s1);
  const loose = discover(s1[0], files, { ...O, sensitivity: 'loose' });
  assert.equal(loose.length, 13);
  assert.equal(loose[12], 'Show.Name.S02E01.1080p.WEB-DL.x265.mkv');
});

test('unrelated movies are never queued', () => {
  const files = ['The Matrix 1999.mkv', 'Inception (2010).mkv', 'Heat.mp4', 'Alien 3.mkv', 'Rocky 4.mkv'];
  for (const f of files) assert.deepEqual(discover(f, files, { ...O, sensitivity: 'loose' }), [f]);
});

test('mixed audio and video stay apart unless sameCategory is off', () => {
  const files = ['01 - Intro.mp3', '02 - Song.mp3', '03 - Outro.mp3', 'Show - 01.mkv', 'Show - 02.mkv'];
  assert.deepEqual(discover('Show - 01.mkv', files, O), ['Show - 01.mkv', 'Show - 02.mkv']);
  assert.deepEqual(discover('02 - Song.mp3', files, { ...O, sensitivity: 'loose' }), ['01 - Intro.mp3', '02 - Song.mp3', '03 - Outro.mp3']);
  assert.equal(discover('Show - 01.mkv', files, { ...O, includeAll: true, sameCategory: false }).length, 5);
});

test('different extensions, same numbering pattern', () => {
  const files = ['Show 01.mkv', 'Show 02.mp4', 'Show 03.avi', 'Show 01.mp4'];
  assert.deepEqual(discover('Show 01.mkv', files, O), ['Show 01.mkv', 'Show 02.mp4', 'Show 03.avi']); // same-stem duplicate dropped
});

test('middle of a sequence keeps the full sorted run', () => {
  const files = Array.from({ length: 6 }, (_, i) => `Show - Episode ${i + 1}.mkv`);
  assert.deepEqual(discover(files[2], files, O), files);
});

test('strict: only the unbroken run around the opened episode', () => {
  const files = ['Show - 01.mkv', 'Show - 02.mkv', 'Show - 03.mkv', 'Show - 07.mkv', 'Show - 08.mkv'];
  assert.deepEqual(discover('Show - 02.mkv', files, { ...O, sensitivity: 'strict' }), files.slice(0, 3));
  assert.equal(discover('Show - 02.mkv', files, O).length, 5);
});

test('spaces, unicode and brackets in names', () => {
  const f = (n: number) => `[Fansub] 進撃の巨人 – Épisode (${n}) & more! - ${pad(n)} [1080p].mkv`;
  const files = [f(1), f(2), f(3)];
  assert.deepEqual(discover(files[0], files, O), files);
});

test('hundreds of files: capped, anchor kept, fast', () => {
  const files = [
    ...Array.from({ length: 600 }, (_, i) => `Show - ${pad(i + 1, 3)}.mkv`),
    ...Array.from({ length: 600 }, (_, i) => `random file ${i}.txt`),
  ];
  const t = performance.now();
  const r = discover('Show - 300.mkv', files, { ...O, max: 200 });
  assert.ok(performance.now() - t < 500);
  assert.equal(r.length, 200);
  assert.ok(r.includes('Show - 300.mkv'));
  assert.equal(r[r.indexOf('Show - 300.mkv') + 1], 'Show - 301.mkv'); // following episodes come first
});

test('hidden files and a lone file', () => {
  assert.deepEqual(discover('Show - 01.mkv', ['Show - 01.mkv', '.Show - 02.mkv'], O), ['Show - 01.mkv']);
  assert.deepEqual(discover('video.mp4', ['video.mp4', 'notes.txt'], O), ['video.mp4']);
  assert.deepEqual(discover('weird.xyz', ['weird.xyz', 'a.mkv'], O), ['weird.xyz']);
});

test('recordings named by date and time queue in time order', () => {
  // the user's game recordings folder: month-day-year-hour-minute
  const files = ['11-22-2026-07-06.mp4', '11-06-2026-17-54.mp4', '11-21-2026-23-52.mp4', '11-22-2026-01-14.mp4', '11-06-2026-18-32.mp4', '01-03-2027-10-00.mp4'];
  const want = ['11-06-2026-17-54.mp4', '11-06-2026-18-32.mp4', '11-21-2026-23-52.mp4', '11-22-2026-01-14.mp4', '11-22-2026-07-06.mp4', '01-03-2027-10-00.mp4'];
  assert.deepEqual(discover('11-21-2026-23-52.mp4', files, O), want);
  assert.deepEqual(discover('11-21-2026-23-52.mp4', files, { ...O, sensitivity: 'strict' }), want);
  assert.equal(parse('11-22-2026-07-06.mp4')!.tag, 'date');
  // other recorders: OBS, ShadowPlay, compact stamps, a game name in front
  const obs = ['2026-11-22 07-06-00.mkv', '2026-11-21 23-52-10.mkv', '2026-11-22 01-14-59.mkv'];
  assert.deepEqual(discover(obs[0], obs, O), [obs[1], obs[2], obs[0]]);
  const sp = ['Valorant 2026.11.22 - 07.06.00.01.mp4', 'Valorant 2026.11.21 - 23.52.10.02.mp4', 'Other Game 2026.11.21 - 20.00.00.01.mp4'];
  assert.deepEqual(discover(sp[0], sp, O), [sp[1], sp[0]]); // another game is another series
  assert.deepEqual(discover('Clip_20261122_070600.mp4', ['Clip_20261122_070600.mp4', 'Clip_20261121_235210.mp4'], O), ['Clip_20261121_235210.mp4', 'Clip_20261122_070600.mp4']);
  assert.equal(parse('Show.2019.S01E02.mkv')!.tag, 'ep'); // a year next to an episode is still an episode
});

test('nothing related: the whole folder is queued when wholeFolder is on', () => {
  const files = ['Kagaaro glazing.mp4', 'funny cat.mp4', 'notes.txt', 'song.mp3', 'zebra.webm'];
  assert.deepEqual(discover('funny cat.mp4', files, O), ['funny cat.mp4']);
  assert.deepEqual(discover('funny cat.mp4', files, { ...O, wholeFolder: true }), ['funny cat.mp4', 'Kagaaro glazing.mp4', 'zebra.webm']);
  // matches found: the fallback does not add unrelated files
  const eps = ['Show - 01.mkv', 'Show - 02.mkv', 'random.mp4'];
  assert.deepEqual(discover('Show - 01.mkv', eps, { ...O, wholeFolder: true }), ['Show - 01.mkv', 'Show - 02.mkv']);
});

test('include-all lists every same-category file in natural order', () => {
  const files = ['b 10.mp4', 'b 2.mp4', 'a.mkv', 'x.mp3'];
  assert.deepEqual(discover('b 2.mp4', files, { ...O, includeAll: true }), ['a.mkv', 'b 2.mp4', 'b 10.mp4']);
});
