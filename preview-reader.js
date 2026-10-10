// The side pane's reading tools as plain logic, so the tests can read them:
// the outline of a note and the section being read, finding words across the
// pieces of text a view is made of, keeping the reader's place when the file
// changes, and the zoom of a picture opened full screen. side-pane.js puts
// them on the screen (window.PreviewReader).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PreviewReader = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- outline ----
  // [{ level, text }] in reading order → each with its depth: how many headings above it are still open
  // (a smaller level), so a note that starts at "##" or skips a level is not pushed in.
  function outline(headings) {
    const open = [];
    return headings.map((h) => {
      while (open.length && open[open.length - 1] >= h.level) open.pop();
      const depth = open.length;
      open.push(h.level);
      return { level: h.level, depth, text: String(h.text || '').trim() || '（无标题）' };
    });
  }
  // The heading of the section being read: the last one whose top (from the top of the view) has
  // passed the reading line. Scrolled to the very end, a short last section can never reach the
  // line, so the last heading on screen counts; above the first heading, that one once it is on
  // screen (a title under the properties). -1 before then.
  function currentHeading(tops, line, atEnd, bottom) {
    let at = -1;
    for (let i = 0; i < tops.length; i++) if (tops[i] <= line) at = i;
    if (atEnd) for (let i = tops.length - 1; i > at; i--) if (tops[i] < bottom) return i;
    return at < 0 && tops.length && tops[0] < bottom ? 0 : at;
  }

  // ---- find ----
  // Pieces are the text nodes of a view in order, { text, cut }; a piece with `cut` starts another
  // block, and a match never runs from one block into the next. Case is ignored and the words are
  // plain text. Each range is { from: [piece, offset], to: [piece, offset] }.
  const LIMIT = 1000;
  function findRanges(pieces, query, limit = LIMIT) {
    const q = String(query == null ? '' : query);
    if (!q.trim()) return { ranges: [], more: false };
    const starts = [];
    let all = '';
    pieces.forEach((p) => { if (p.cut && all) all += '\n'; starts.push(all.length); all += p.text; });
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
    const ranges = [];
    let k = 0, more = false, m;
    // the first piece holding position `at`; `end` lets an end land on the very end of a piece
    const pieceAt = (at, end) => {
      while (k < pieces.length - 1 && (end ? starts[k] + pieces[k].text.length < at : starts[k] + pieces[k].text.length <= at)) k++;
      return [k, at - starts[k]];
    };
    while ((m = re.exec(all))) {
      if (ranges.length === limit) { more = true; break; }
      const from = pieceAt(m.index, false), to = pieceAt(m.index + m[0].length, true);
      ranges.push({ from, to });
    }
    return { ranges, more };
  }
  const findCount = (at, total, more) => (total ? `${at + 1}/${total}${more ? '+' : ''}` : '没找到');

  // ---- keeping the reader's place ----
  // keys: one per block (its tag and the start of its text) before and after a change; at: the
  // block the reader was looking at. The same block nearest to where it was; when it is gone (that
  // very block was rewritten) the same position.
  function relocate(oldKeys, at, newKeys) {
    if (at < 0 || at >= oldKeys.length || !newKeys.length) return -1;
    const key = oldKeys[at];
    for (let d = 0; d < Math.max(at + 1, newKeys.length - at); d++) {
      if (newKeys[at + d] === key) return at + d;
      if (d && newKeys[at - d] === key) return at - d;
    }
    return Math.min(at, newKeys.length - 1);
  }

  // ---- a picture full screen ----
  // A view is { scale, x, y }: the picture's size factor and where its top left corner sits in the box.
  const ZOOM_MIN = 0.05, ZOOM_MAX = 10;
  const fitScale = (w, h, boxW, boxH) => Math.min(1, boxW / w, boxH / h);
  // zoom to `scale`, keeping the picture point under (px, py) where it is
  function zoomAt(v, scale, px, py) {
    const s = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
    return { scale: s, x: px - (px - v.x) * s / v.scale, y: py - (py - v.y) * s / v.scale };
  }
  // keep it on screen: centred along a side where it is smaller than the box; along a side where it
  // is bigger, its edges are never pulled inside the box
  function settle(v, w, h, boxW, boxH) {
    const along = (pos, size, box) => (size <= box ? (box - size) / 2 : Math.min(0, Math.max(box - size, pos)));
    return { scale: v.scale, x: along(v.x, w * v.scale, boxW), y: along(v.y, h * v.scale, boxH) };
  }

  return { outline, currentHeading, findRanges, findCount, relocate, fitScale, zoomAt, settle, LIMIT, ZOOM_MIN, ZOOM_MAX };
});
