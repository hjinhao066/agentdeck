// Colour themes for the side pane's Markdown reading view. Each theme is a
// plain list of colours for the light and the dark deck; preview-themes.css
// holds the shapes and reads the colours through --md-* variables. Loaded by
// the page (window.PreviewThemes) and by the tests, which check every text
// colour against the background it sits on.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PreviewThemes = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // One colour per role. c* are the callout kinds (说明 提示 完成 疑问 注意 错误 示例 引用).
  const KEYS = ['bg', 'text', 'muted', 'border', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'link', 'del', 'marker',
    'code', 'codeBg', 'pre', 'preText', 'tokK', 'tokS', 'tokN', 'tokC', 'quote', 'quoteBar', 'quoteBg', 'th', 'thBg', 'rowAlt',
    'mark', 'markBg', 'tag', 'tagBg', 'accent', 'accentInk', 'hr', 'cInfo', 'cTip', 'cOk', 'cAsk', 'cWarn', 'cBad', 'cEg', 'cQuote'];
  const palette = (line) => { const v = line.trim().split(/\s+/); const out = {}; KEYS.forEach((k, i) => { out[k] = '#' + v[i]; }); return out; };

  const THEMES = [
    // 星光: the deck's own night sky. Deep indigo, periwinkle that glows, amber for what matters.
    { id: 'starlight', name: '星光', hint: '深靛蓝底，发光的蓝，琥珀点缀',
      dark: palette(`0b0f1e e4e8f5 98a2c0 262d4a  f5f7ff 8fa6ff f0b450 6fd3e8 a9b6e8 98a2c0  ffd27a 9fd8ff 8fa6ff 8690ad f0b450
        7fe0c8 161c33 070a15 d6dcf0 8fa6ff 8fd9a8 f0b450 7f8aab  b9c2e0 8fa6ff 121831  ffd27a 161c33 0f1426
        0b0f1e f0b450 a9bcff 1b2450 8fa6ff 0b0f1e 262d4a  8fa6ff 6fd3e8 6fd99a f0d060 f0b450 ff7b72 b8a6ff 98a2c0`),
      light: palette(`f7f8fc 1a2140 525d82 d5daea  131a3a 2f47c2 8f5a00 0b6f85 3d4a80 525d82  8a5200 1f5fa8 2f47c2 586280 9a6200
        0a6b5e e9edf7 eef1f9 1a2140 2f47c2 1f7a45 8f5a00 5c668a  3d4870 4a62e0 eceffb  131a3a e3e8f6 f1f3fa
        1a2140 ffd778 2a3fb0 dfe5fb 4a62e0 ffffff d5daea  2f47c2 0b6f85 1d7241 7a6000 8f5a00 b43529 5b3fc4 525d82`) },
    // 碳黑: true black, electric cyan and lime, square corners. A terminal that learned typography.
    { id: 'carbon', name: '碳黑', hint: '纯黑底，电光青和荧光绿，直角',
      dark: palette(`0a0a0a e6e6e6 9a9a9a 2a2a2a  ffffff 4dd8ff b6f24a ffb347 c8c8c8 9a9a9a  ffffff ffd166 4dd8ff 8c8c8c 4dd8ff
        b6f24a 1a1a1a 111111 e0e0e0 4dd8ff b6f24a ffb347 8a8a8a  c4c4c4 4dd8ff 141414  4dd8ff 161616 111111
        0a0a0a ffd166 4dd8ff 10262e 4dd8ff 0a0a0a 2a2a2a  4dd8ff 5fe0c0 b6f24a ffd166 ffb347 ff6b5e b79cff 9a9a9a`),
      light: palette(`ffffff 141414 5a5a5a d9d9d9  000000 006a8a 4a6b00 9a5200 3a3a3a 5a5a5a  000000 7a5a00 006a8a 676767 006a8a
        3f5c00 f0f0f0 f5f5f5 141414 006a8a 3f5c00 9a5200 666666  3a3a3a 0090b8 f4f4f4  000000 ececec f7f7f7
        141414 ffd84d 005a75 dff1f6 007a9c ffffff d9d9d9  006a8a 00705c 3f5c00 7a5a00 9a5200 b3261e 5b3fc4 5a5a5a`) },
    // Nord: cold steel blue-grey, frost accents, nothing loud.
    { id: 'nord', name: 'Nord 极地', hint: '冷调钢蓝灰，冰霜色强调',
      dark: palette(`2e3440 d8dee9 aab4c6 434c5e  ffffff 88c0d0 81a1c1 a3be8c ebcb8b aab4c6  f4f7fb 92bebd 88c0d0 aeb6c6 88c0d0
        ebcb8b 3b4252 272c36 d8dee9 81a1c1 a3be8c d08770 8c97ab  c5cedd 88c0d0 353c4a  eceff4 3b4252 323845
        2e3440 ebcb8b 88c0d0 3a4658 88c0d0 2e3440 434c5e  88c0d0 8fbcbb a3be8c ebcb8b e1a374 e79ca1 bda9d2 aab4c6`),
      light: palette(`eceff4 2e3440 4c566a d0d6e0  1f2530 2e6c81 3f5f8f 4a6b35 7a5a10 4c566a  1a1f29 2a6865 2c6679 545e71 2f6f85
        7a5a10 dfe4ec e3e7ee 2e3440 3f5f8f 4a6b35 a04a2a 5a6478  3b4252 5e81ac e3e8f0  2e3440 dde2ea e6eaf0
        2e3440 ebcb8b 2a5f73 d5e3ea 5e81ac ffffff d0d6e0  2c6679 2a6865 486833 7a5a10 964628 a5343d 5f4a8a 4c566a`) },
    // Obsidian's own look: neutral greys, the purple accent, headings fading from near-white into lavender.
    { id: 'obsidian', name: 'Obsidian 默认', hint: '中性灰底，紫色点睛',
      dark: palette(`1e1e1e dadada a8a8a8 3a3a3a  e6dcff b79cff 8fb8ff 6fcbd6 c3b7e8 a3a3a3  ffffff 9fd0ff a88bfa 9d9d9d a88bfa
        ffb86b 2b2b2b 262626 d4d4d4 c792ea c3e88d f78c6c 8a93a6  b9b3cc 8a5cf5 25232d  e6dcff 2a2733 232323
        1b1b1b e8c95a c9b6ff 332b4d 8a5cf5 ffffff 3a3a3a  6cb6ff 4fd6c4 6bd67b e8c95a f2a35e ff7b72 b79cff a8a8a8`),
      light: palette(`ffffff 222222 5c5c5c e0e0e0  2b1a66 6a3fd6 2f5fc4 0f7a80 6b5a9e 666666  000000 1f5fa8 6a3fd6 656565 6a3fd6
        a84a00 f4f2f7 f6f6f8 2b2b2b 7c3aed 2e7d32 b45309 686f7c  55506b 8a5cf5 f5f2fd  2b1a66 efeafc faf9fd
        222222 ffe58a 5b34c2 ece5ff 7c4dff ffffff e0e0e0  1d63c4 0b7671 187733 8a6100 aa4f09 c02737 6a3fd6 5c5c5c`) },
    // Minimal: almost no colour, one warm accent, the type does the work.
    { id: 'minimal', name: 'Minimal 极简', hint: '几乎不用颜色，一点暖色', quiet: true,
      dark: palette(`262626 d4d4d4 a0a0a0 3f3f3f  f2f2f2 e0e0e0 e6b877 c9c9c9 b3b3b3 a0a0a0  f5f5f5 d9c2a0 e6b877 a6a6a6 a0a0a0
        e0c9a6 323232 2f2f2f d4d4d4 e6b877 b5c9a1 d9b38c 9a9a9a  b8b8b8 777777 262626  f2f2f2 303030 2b2b2b
        1f1f1f e6c98a e6b877 3a3327 e6b877 1f1f1f 3f3f3f  8fb4d9 8fc9bf a3c98f d9c98f e6b877 e39a9a b9a8d9 a0a0a0`),
      light: palette(`ffffff 2a2a2a 666666 e3e3e3  111111 222222 9a5b00 444444 555555 666666  000000 7a5a2b 955800 676767 666666
        7a4b00 f5f3ef f7f7f5 2a2a2a 9a5b00 4a6b2f a03b3b 6e6e6e  555555 8c8c8c ffffff  111111 f5f5f3 fafaf9
        2a2a2a fbe6a8 7a4b00 f6ecd9 9a5b00 ffffff e3e3e3  2f5f8f 1f6f66 3f6f2a 7a6100 955800 a03b3b 5b4a8f 666666`) },
    // Gruvbox: warm paper and retro terminal colours, headings set in the code face.
    { id: 'gruvbox', name: 'Gruvbox', hint: '暖色复古，等宽标题',
      dark: palette(`282828 ebdbb2 bdae93 504945  fb5846 fabd2f b8bb26 8ec07c 83a598 bdae93  fe8827 8ec07c 8eaea1 b2a592 fe8019
        b8bb26 3c3836 1d2021 ebdbb2 fb4934 b8bb26 fe8019 a89984  d5c4a1 928374 32302f  fabd2f 3c3836 2e2c2b
        282828 fabd2f 8ec07c 35403a fe8019 282828 504945  87a89b 8ec07c b8bb26 fabd2f fe8019 fb786a d5c4a1 bdae93`),
      light: palette(`fbf1c7 3c3836 5a524c d5c4a1  9d0006 8f5200 5e5a00 2f6b4a 076678 5a524c  a53603 2e6848 076678 625951 af3a03
        5e5a00 ebdbb2 f2e5bc 3c3836 9d0006 5e5a00 af3a03 6b6259  504945 7c6f64 f2e5bc  8b5000 ebdbb2 f6ebc0
        3c3836 f5c84a 2f6b4a e3e2b5 af3a03 fbf1c7 d5c4a1  076678 2f6b4a 5e5a00 8f5200 aa3803 9d0006 504945 5a524c`) },
  ];
  const DEFAULT = 'starlight';
  const CALLOUTS = { cInfo: 'info', cTip: 'tip', cOk: 'ok', cAsk: 'ask', cWarn: 'warn', cBad: 'bad', cEg: 'eg', cQuote: 'quote' };
  const CALLOUT_TINT = 0.12;   // how much of its colour a callout's background takes

  const find = (id) => THEMES.find((t) => t.id === id);
  const normalize = (id) => (find(id) ? id : DEFAULT);
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const hex = (parts) => '#' + parts.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const mix = (top, under, share) => { const a = rgb(top), b = rgb(under); return hex(a.map((v, i) => v * share + b[i] * (1 - share))); };
  function luminance(colour) {
    const [r, g, b] = rgb(colour).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  // WCAG contrast ratio of two solid colours, 1 to 21.
  function contrast(a, b) {
    const la = luminance(a), lb = luminance(b);
    return Math.round((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05) * 100) / 100;
  }
  const colours = (id, mode) => find(normalize(id))[mode === 'light' ? 'light' : 'dark'];
  const calloutBg = (c, key) => mix(c[key], c.bg, CALLOUT_TINT);

  // { '--md-bg': '#1e1e1e', … }: the colours as the style sheet reads them.
  function vars(id, mode) {
    const c = colours(id, mode), out = {};
    for (const key of KEYS) out['--md-' + key.replace(/[A-Z]/g, (ch) => '-' + ch.toLowerCase())] = c[key];
    for (const [key, kind] of Object.entries(CALLOUTS)) out[`--md-c-${kind}-bg`] = calloutBg(c, key);
    return out;
  }
  // Every [name, text colour, background, ratio it must reach] the reading view puts on screen.
  function pairs(id, mode) {
    const c = colours(id, mode), out = [];
    const text = (name, fg, bg) => out.push([name, fg, bg, 4.5]), shape = (name, fg, bg) => out.push([name, fg, bg, 3]);
    for (const key of ['text', 'muted', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'link', 'del', 'marker']) text(key, c[key], c.bg);
    text('code', c.code, c.codeBg);
    for (const key of ['preText', 'tokK', 'tokS', 'tokN', 'tokC']) text(key + ' in a code block', c[key], c.pre);
    for (const key of ['quote', 'strong', 'em', 'link', 'del', 'h2']) text(key + ' in a quote', c[key], c.quoteBg);
    text('table head', c.th, c.thBg);
    for (const key of ['text', 'strong', 'em', 'link', 'del']) text(key + ' on a striped row', c[key], c.rowAlt);
    text('highlight', c.mark, c.markBg);
    text('tag', c.tag, c.tagBg);
    for (const key of Object.keys(CALLOUTS)) {
      const bg = calloutBg(c, key);
      text(key + ' title', c[key], bg);
      for (const inner of ['text', 'strong', 'em', 'link', 'del']) text(inner + ' in ' + key, c[inner], bg);
    }
    shape('quote bar', c.quoteBar, c.bg);
    shape('checkbox', c.accent, c.bg);
    shape('check mark', c.accentInk, c.accent);
    return out;
  }
  // The whole set as CSS: one rule per theme and deck mode.
  function sheet() {
    return THEMES.flatMap((t) => ['light', 'dark'].map((mode) =>
      `:root[data-theme="${mode}"] .pv-md[data-md-theme="${t.id}"] { ${Object.entries(vars(t.id, mode)).map(([k, v]) => `${k}: ${v};`).join(' ')} }`)).join('\n');
  }

  return { THEMES, DEFAULT, KEYS, normalize, contrast, mix, vars, pairs, sheet };
});
