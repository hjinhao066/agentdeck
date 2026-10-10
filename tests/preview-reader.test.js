'use strict';
// The side pane's reading tools, as plain logic: the outline of a note and the
// section being read, finding a word across the pieces of text a view is made
// of, keeping the reader's place when the file changes under them, and the
// zoom of a picture opened full screen. Plus the main process watching the
// previewed file. The page wires these to the screen (side-pane.js); the E2E
// spec tests/e2e/preview-reader.spec.js checks them there.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('../preview-reader');
const { registerSideIpc } = require('../side-main');

// ---- outline ----
test('the outline indents a heading under the nearest one above it with a smaller level', () => {
  const items = R.outline([{ level: 1, text: '周报' }, { level: 2, text: '一' }, { level: 3, text: '1.1' }, { level: 2, text: '二' }, { level: 4, text: '跳级' }, { level: 1, text: '附录' }]);
  assert.deepEqual(items.map((i) => i.depth), [0, 1, 2, 1, 2, 0]);
  assert.deepEqual(items.map((i) => i.text), ['周报', '一', '1.1', '二', '跳级', '附录']);
  // a note that starts at the second level is not pushed in
  assert.deepEqual(R.outline([{ level: 2, text: 'a' }, { level: 3, text: 'b' }, { level: 2, text: 'c' }]).map((i) => i.depth), [0, 1, 0]);
  assert.equal(R.outline([{ level: 2, text: '   ' }])[0].text, '（无标题）');
  assert.deepEqual(R.outline([]), []);
});

test('the section being read is the last heading that has passed the reading line; at the very end, the last one on screen', () => {
  const tops = [-900, -300, 40, 420, 700];
  assert.equal(R.currentHeading(tops, 24, false, 600), 1);
  assert.equal(R.currentHeading(tops, 60, false, 600), 2);
  // above the first heading: it counts once it is on screen (the title under the properties)
  assert.equal(R.currentHeading([120, 500], 24, false, 600), 0);
  assert.equal(R.currentHeading([700, 900], 24, false, 600), -1);
  // scrolled to the bottom: a short last section can never reach the line, so the last visible heading counts
  assert.equal(R.currentHeading(tops, 24, true, 600), 3);
  assert.equal(R.currentHeading(tops, 24, true, 800), 4);
  assert.equal(R.currentHeading([], 24, true, 800), -1);
});

// ---- find ----
const pieces = (...list) => list.map((p) => (typeof p === 'string' ? { text: p } : p));
const spans = (found, list) => found.ranges.map((r) => {
  let out = '';
  for (let k = r.from[0]; k <= r.to[0]; k++) out += list[k].text.slice(k === r.from[0] ? r.from[1] : 0, k === r.to[0] ? r.to[1] : undefined);
  return out;
});

test('find ignores case, reads Chinese, and finds a word split over several pieces of one block', () => {
  const list = pieces('function ', 'setTheme', '(id) { return SetTheme; }');
  const found = R.findRanges(list, 'settheme');
  assert.deepEqual(spans(found, list), ['setTheme', 'SetTheme']);
  assert.deepEqual(found.ranges[0], { from: [1, 0], to: [1, 8] });
  const code = pieces('const ', 'note', ' = 1;');
  assert.deepEqual(R.findRanges(code, 'st no').ranges, [{ from: [0, 3], to: [1, 2] }]);    // across two pieces
  const zh = pieces('预览栏改版', { text: '预览栏', cut: true }, '主题');
  assert.deepEqual(spans(R.findRanges(zh, '预览栏'), zh), ['预览栏', '预览栏']);
  assert.equal(R.findRanges(zh, '栏主').ranges.length, 1);
});

test('a match never runs from one block into the next', () => {
  const list = pieces('第一段末尾', { text: '第二段开头', cut: true });
  assert.equal(R.findRanges(list, '尾第').ranges.length, 0);
  assert.equal(R.findRanges(list, '末尾').ranges.length, 1);
});

test('find takes the query as plain text, finds nothing for blanks, and stops at its limit', () => {
  const list = pieces('a.b a+b (a) [x] $1 a.b');
  assert.equal(R.findRanges(list, 'a.b').ranges.length, 2);
  assert.equal(R.findRanges(list, '(a)').ranges.length, 1);
  assert.equal(R.findRanges(list, '[x]').ranges.length, 1);
  assert.equal(R.findRanges(list, '').ranges.length, 0);
  assert.equal(R.findRanges(list, '   ').ranges.length, 0);
  const many = pieces('ab'.repeat(30));
  const capped = R.findRanges(many, 'b', 10);
  assert.equal(capped.ranges.length, 10);
  assert.equal(capped.more, true);
  assert.equal(R.findRanges(many, 'b').more, false);
});

test('the count reads "current/total", with a plus when the limit was hit', () => {
  assert.equal(R.findCount(0, 0, false), '没找到');
  assert.equal(R.findCount(2, 7, false), '3/7');
  assert.equal(R.findCount(0, 1000, true), '1/1000+');
});

// ---- keeping the reader's place ----
test('after a change the place is found again by what was there, nearest to where it was', () => {
  const before = ['h1:周报', 'p:引言', 'h2:一', 'p:正文甲', 'h2:二', 'p:正文乙'];
  assert.equal(R.relocate(before, 4, before), 4);
  // two blocks written above: the same block, two further down
  assert.equal(R.relocate(before, 4, ['h1:周报', 'p:新的一段', 'p:又一段', 'p:引言', 'h2:一', 'p:正文甲', 'h2:二', 'p:正文乙']), 6);
  // a block above removed
  assert.equal(R.relocate(before, 4, ['h1:周报', 'h2:一', 'p:正文甲', 'h2:二', 'p:正文乙']), 3);
  // the block itself was rewritten: the same position
  assert.equal(R.relocate(before, 3, ['h1:周报', 'p:引言', 'h2:一', 'p:改过的正文', 'h2:二', 'p:正文乙']), 3);
  // the same text twice: the one nearest to where it was
  assert.equal(R.relocate(['p:x', 'p:y', 'p:x', 'p:z'], 2, ['p:x', 'p:y', 'p:new', 'p:x', 'p:z']), 3);
  // the note got shorter than the place
  assert.equal(R.relocate(before, 5, ['h1:周报']), 0);
  assert.equal(R.relocate(before, -1, before), -1);
  assert.equal(R.relocate(before, 2, []), -1);
});

// ---- a picture full screen ----
test('a picture opens fitted to the screen, never blown up past its own size', () => {
  assert.equal(R.fitScale(2000, 1000, 1000, 800), 0.5);
  assert.equal(R.fitScale(1000, 2000, 1000, 800), 0.4);
  assert.equal(R.fitScale(96, 48, 1000, 800), 1);
});

test('zooming keeps the point under the pointer where it is, within limits', () => {
  const v = { scale: 1, x: 100, y: 50 };
  const z = R.zoomAt(v, 2, 300, 250);
  assert.equal(z.scale, 2);
  // the picture point under (300, 250) was (200, 200); after zooming it is still under (300, 250)
  assert.deepEqual([(300 - z.x) / z.scale, (250 - z.y) / z.scale], [200, 200]);
  assert.equal(R.zoomAt(v, 100, 0, 0).scale, R.ZOOM_MAX);
  assert.equal(R.zoomAt(v, 0.001, 0, 0).scale, R.ZOOM_MIN);
  assert.ok(R.ZOOM_MIN <= 0.1 && R.ZOOM_MAX >= 8);
});

test('a picture smaller than the screen is centred; a bigger one cannot be dragged away from its edges', () => {
  assert.deepEqual(R.settle({ scale: 1, x: -500, y: 900 }, 200, 100, 1000, 800), { scale: 1, x: 400, y: 350 });
  // 2000 × 1600 on a 1000 × 800 screen: x from -1000 to 0, y from -800 to 0
  assert.deepEqual(R.settle({ scale: 2, x: 50, y: -2000 }, 1000, 800, 1000, 800), { scale: 2, x: 0, y: -800 });
  assert.deepEqual(R.settle({ scale: 2, x: -300, y: -400 }, 1000, 800, 1000, 800), { scale: 2, x: -300, y: -400 });
});

// ---- the main process watches the previewed file ----
test('a previewed file that changes on disk is reported, once per change, and only the file now shown', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-pvwatch-')));
  const a = path.join(dir, 'a.md'), b = path.join(dir, 'b.md');
  fs.writeFileSync(a, '# a'); fs.writeFileSync(b, '# b');
  const handlers = {}, sent = [];
  const pane = registerSideIpc({
    onMain: (channel, fn) => { handlers[channel] = fn; }, handleMain: (channel, fn) => { handlers[channel] = fn; },
    send: (channel, message) => sent.push([channel, message]), getWindow: () => null, session: {}, WebContentsView: class {},
    resolveClick: (msg) => (fs.existsSync(msg.raw) ? { target: msg.raw } : null), chatDir: () => dir, home: dir, watchInterval: 50,
  });
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    assert.equal(handlers['preview:watch']({}, { raw: path.join(dir, 'nope.md') }), 0);
    assert.equal(handlers['preview:watch']({}, { raw: 42 }), 0);
    const first = handlers['preview:watch']({}, { raw: a });
    assert.ok(first > 0);
    await settle(200);
    assert.deepEqual(sent, []);                                   // nothing changed, nothing said
    fs.writeFileSync(a, '# a\n\nmore');
    await settle(300);
    assert.deepEqual(sent.splice(0), [['side:preview-changed', { watch: first }]]);
    // a file replaced the way editors save (a new file renamed over it) counts too
    fs.writeFileSync(a + '.tmp', '# a, saved again'); fs.renameSync(a + '.tmp', a);
    await settle(300);
    assert.deepEqual(sent.splice(0), [['side:preview-changed', { watch: first }]]);
    // another file takes its place: the old one is no longer watched
    const second = handlers['preview:watch']({}, { raw: b });
    assert.ok(second > first);
    fs.writeFileSync(a, 'changed while not shown');
    await settle(300);
    assert.deepEqual(sent, []);
    fs.writeFileSync(b, '# b changed');
    await settle(300);
    assert.deepEqual(sent.splice(0), [['side:preview-changed', { watch: second }]]);
    handlers['preview:unwatch']({});
    fs.writeFileSync(b, '# b changed again');
    await settle(300);
    assert.deepEqual(sent, []);
  } finally {
    pane.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
