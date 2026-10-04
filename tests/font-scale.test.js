const test = require('node:test');
const assert = require('node:assert/strict');
const FontScale = require('../font-scale');

test('text scale snaps to 10% steps and stays inside 80–200', () => {
  assert.equal(FontScale.normalize(undefined), 100);
  assert.equal(FontScale.normalize('150'), 100);
  assert.equal(FontScale.normalize(NaN), 100);
  assert.equal(FontScale.normalize(Infinity), 100);
  assert.equal(FontScale.normalize(84), 80);
  assert.equal(FontScale.normalize(85), 90);
  assert.equal(FontScale.normalize(200), 200);
  assert.equal(FontScale.normalize(80), 80);
  assert.equal(FontScale.normalize(50), 80);
  assert.equal(FontScale.normalize(260), 200);
});

test('each shortcut moves one step and 0 restores 100%', () => {
  assert.equal(FontScale.adjust(100, 1), 110);
  assert.equal(FontScale.adjust(100, -1), 90);
  assert.equal(FontScale.adjust(80, -1), 80);
  assert.equal(FontScale.adjust(200, 1), 200);
  assert.equal(FontScale.adjust(160, 0), 100);
  assert.equal(FontScale.adjust(140, 2), 140);
  let size = 100;
  for (let i = 0; i < 30; i++) size = FontScale.adjust(size, 1);
  assert.equal(size, 200);
  for (let i = 0; i < 30; i++) size = FontScale.adjust(size, -1);
  assert.equal(size, 80);
});

test('terminal font is the rounded percent of 13px and legacy pixels migrate once', () => {
  assert.equal(FontScale.terminalFontSize(100), 13);
  assert.equal(FontScale.terminalFontSize(80), 10);
  assert.equal(FontScale.terminalFontSize(90), 12);
  assert.equal(FontScale.terminalFontSize(110), 14);
  assert.equal(FontScale.terminalFontSize(200), 26);
  assert.equal(FontScale.fromPixels(13), 100);
  assert.equal(FontScale.fromPixels(16), 120);
  assert.equal(FontScale.fromPixels(8), 80);
  assert.equal(FontScale.fromPixels(32), 200);
  assert.equal(FontScale.resolve(null), 100);
  assert.equal(FontScale.resolve({ fontSize: 16 }), 120);
  assert.equal(FontScale.resolve({ fontScale: 150, fontSize: 16 }), 150);
  assert.equal(FontScale.resolve({ fontScale: 999 }), 200);
  assert.equal(FontScale.resolve({ sidebarFontSize: 20 }), 100);
});

test('Cmd/Ctrl plus, equals, minus, and 0 are the text shortcuts', () => {
  const down = (extra) => FontScale.keyDelta({ type: 'keyDown', ...extra });
  assert.equal(down({ key: '=', meta: true }), 1);
  assert.equal(down({ key: '+', meta: true, shift: true }), 1);
  assert.equal(down({ key: '-', meta: true }), -1);
  assert.equal(down({ key: '_', meta: true, shift: true }), -1);
  assert.equal(down({ key: '0', meta: true, code: 'Digit0' }), 0);
  assert.equal(down({ key: '+', code: 'NumpadAdd', control: true }), 1);
  assert.equal(down({ key: '-', code: 'NumpadSubtract', control: true }), -1);
  assert.equal(down({ key: '0', code: 'Numpad0', control: true }), 0);
  assert.equal(down({ key: '=', meta: true, alt: true }), null);
  assert.equal(down({ key: '=', meta: true, control: true }), null);
  assert.equal(down({ key: '=', }), null);
  assert.equal(down({ key: 'a', meta: true }), null);
  assert.equal(FontScale.keyDelta({ type: 'keyUp', key: '=', meta: true }), null);
  assert.equal(FontScale.keyDelta({ type: 'keydown', key: '=', metaKey: true }), 1);
  assert.equal(FontScale.keyDelta({ type: 'keydown', key: '=', metaKey: true, isComposing: true }), null);
});
