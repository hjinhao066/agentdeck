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
    // Obsidian's own look: neutral greys, the purple accent, headings fading from near-white into lavender.
    { id: 'obsidian', name: 'Obsidian 默认', hint: '中性灰底，紫色点睛',
      dark: palette(`1e1e1e dadada a8a8a8 3a3a3a  e6dcff b79cff 8fb8ff 6fcbd6 c3b7e8 a3a3a3  ffffff f0b8d8 a88bfa 9d9d9d a88bfa
        ff8fa3 2b2b2b 262626 d4d4d4 c792ea c3e88d f78c6c 8a93a6  b9b3cc 8a5cf5 25232d  e6dcff 2a2733 232323
        1b1b1b e8c95a c9b6ff 332b4d 8a5cf5 ffffff 3a3a3a  6cb6ff 4fd6c4 6bd67b e8c95a f2a35e ff7b8a b79cff a8a8a8`),
      light: palette(`ffffff 222222 5c5c5c e0e0e0  2b1a66 6a3fd6 2f5fc4 0f7a80 6b5a9e 666666  000000 a3306f 6a3fd6 656565 6a3fd6
        c4245c f4f2f7 f6f6f8 2b2b2b 7c3aed 2e7d32 b45309 686f7c  55506b 8a5cf5 f5f2fd  2b1a66 efeafc faf9fd
        222222 ffe58a 5b34c2 ece5ff 7c4dff ffffff e0e0e0  1d63c4 0b7671 187733 8a6100 aa4f09 c02737 6a3fd6 5c5c5c`) },
    // Minimal: almost no colour, one warm accent, the type does the work.
    { id: 'minimal', name: 'Minimal 极简', hint: '几乎不用颜色，一点暖色', quiet: true,
      dark: palette(`262626 d4d4d4 a0a0a0 3f3f3f  f2f2f2 e0e0e0 e6b877 c9c9c9 b3b3b3 a0a0a0  f5f5f5 d9c2a0 e6b877 a6a6a6 a0a0a0
        e0c9a6 323232 2f2f2f d4d4d4 e6b877 b5c9a1 d9a5a5 9a9a9a  b8b8b8 777777 262626  f2f2f2 303030 2b2b2b
        1f1f1f e6c98a e6b877 3a3327 e6b877 1f1f1f 3f3f3f  8fb4d9 8fc9bf a3c98f d9c98f e6b877 e39a9a b9a8d9 a0a0a0`),
      light: palette(`ffffff 2a2a2a 666666 e3e3e3  111111 222222 9a5b00 444444 555555 666666  000000 7a5a2b 955800 676767 666666
        7a4b00 f5f3ef f7f7f5 2a2a2a 9a5b00 4a6b2f a03b3b 6e6e6e  555555 8c8c8c ffffff  111111 f5f5f3 fafaf9
        2a2a2a fbe6a8 7a4b00 f6ecd9 9a5b00 ffffff e3e3e3  2f5f8f 1f6f66 3f6f2a 7a6100 955800 a03b3b 5b4a8f 666666`) },
    // Things: the to-do app's blue-black and clean white, blue headings, pink for emphasis.
    { id: 'things', name: 'Things', hint: '蓝黑底，蓝标题，粉色强调',
      dark: palette(`1c2127 e3e5e8 9aa4b2 2f363f  f5f6f7 4d95f7 f5c84c ff6b81 5ad1a0 9aa4b2  ff82b2 ffb86b 61a1f7 97a2b0 4d95f7
        7cc7ff 252c35 161a1f d6dbe1 ff82b2 9ad17a f5c84c 8693a3  b3bcc8 4d95f7 212830  f5f6f7 252c35 20262d
        1c2127 f5d76e 9cc4ff 223450 4d95f7 0b1a2e 2f363f  5298f7 4fd1c5 5ad1a0 f5c84c ffa05c ff6b81 b594f7 9aa4b2`),
      light: palette(`ffffff 26282b 5f6873 e3e6ea  1b1d1f 1b61c2 9a6a00 c2255c 177a52 5f6873  c2255c a54d0f 1b61c2 5f6871 1b61c2
        0b5cad eef3f9 f5f6f8 26282b c2255c 2f7d32 916400 656f79  4b535c 2e80f2 f3f7fd  1b1d1f f1f3f6 f9fafb
        26282b ffe27a 1b55ad e3eefd 2e80f2 ffffff e3e6ea  1b61c2 0b7671 167650 8a6100 aa4f0f c2255c 6741c7 5f6873`) },
    // Catppuccin (Mocha / Latte) with AnuPpuccin's rainbow headings.
    { id: 'catppuccin', name: 'Catppuccin', hint: '柔和粉彩，彩虹标题',
      dark: palette(`1e1e2e cdd6f4 a6adc8 45475a  f38ba8 fab387 f9e2af a6e3a1 74c7ec b4befe  f5c2e7 94e2d5 89b4fa 9ca2b8 cba6f7
        eba0ac 313244 181825 cdd6f4 cba6f7 a6e3a1 fab387 9399b2  bac2de cba6f7 262637  b4befe 313244 232334
        1e1e2e f9e2af 89b4fa 2e3350 cba6f7 1e1e2e 45475a  89b4fa 94e2d5 a6e3a1 f9e2af fab387 f38ba8 cba6f7 a6adc8`),
      light: palette(`eff1f5 4c4f69 5c5f77 ccd0da  d20f39 b63d0c 946200 2e791e 1a6f9e 5860c3  9f2f7c 0f696d 1d52d0 575b6f 7a34d1
        b3243f e1e4eb e6e9ef 4c4f69 7a34d1 2d751d ad4600 60637c  55586f 8839ef e8e6f3  5b3fc4 dfe2ea e9ecf1
        3c3f55 f3d683 1e55d6 dbe3fb 8839ef ffffff ccd0da  1e55d6 0f6c70 2b6e1b 7a5600 a34200 b80f31 7a34d1 5c5f77`) },
    // Blue Topaz: blue through and through, headings dressed up, a coloured table head.
    { id: 'topaz', name: 'Blue Topaz', hint: '通体蓝调，标题带装饰',
      dark: palette(`1b2230 d5deeb 9fb0c8 303b4f  8ab8ff 5fd3e8 5fe0b5 c3a6ff ff9ac1 9fb0c8  ffad66 9be28f 7fb5ff 98a6b8 5fa8ff
        ff8fa8 252e40 161c28 d5deeb 7fb5ff 9be28f ffad66 8494ab  b4c2d6 4d95f7 1f2a3d  ffffff 2459b3 1f2737
        1b2230 ffd76e a9cdff 223a63 4d95f7 0b1a2e 303b4f  7fb5ff 5fd3e8 5fe0b5 ffd76e ffad66 ff8a8a c3a6ff 9fb0c8`),
      light: palette(`fbfcfe 2c3a4e 5a6b82 d9e2ef  1b4fbf 1565c0 00796b 7b3fc4 c2185b 546e8a  b33b16 0b743d 1462ba 566577 1b6fd1
        c7254e f0f3f8 f3f6fb 2c3a4e 1b4fbf 0b8043 b64c0a 5e6e83  44546a 2a7de1 eef5ff  ffffff 2466c9 f3f7fd
        2c3a4e ffe58f 14509e dcebff 2a7de1 ffffff d9e2ef  1565c0 007568 187733 865e00 ac480a c02727 7b3fc4 57687e`) },
    // Gruvbox: warm paper and retro terminal colours, headings set in the code face.
    { id: 'gruvbox', name: 'Gruvbox', hint: '暖色复古，等宽标题',
      dark: palette(`282828 ebdbb2 bdae93 504945  fb5846 fabd2f b8bb26 8ec07c 83a598 d3869b  fe8827 d794a7 8eaea1 b2a592 fe8019
        b8bb26 3c3836 1d2021 ebdbb2 fb4934 b8bb26 d3869b a89984  d5c4a1 928374 32302f  fabd2f 3c3836 2e2c2b
        282828 fabd2f 8ec07c 35403a fe8019 282828 504945  87a89b 8ec07c b8bb26 fabd2f fe8019 fb786a d58ea1 bdae93`),
      light: palette(`fbf1c7 3c3836 5a524c d5c4a1  9d0006 8f5200 5e5a00 2f6b4a 076678 8f3f71  a53603 8f3f71 076678 625951 af3a03
        5e5a00 ebdbb2 f2e5bc 3c3836 9d0006 5e5a00 8f3f71 6b6259  504945 7c6f64 f2e5bc  8b5000 ebdbb2 f6ebc0
        3c3836 f5c84a 2f6b4a e3e2b5 af3a03 fbf1c7 d5c4a1  076678 2f6b4a 5e5a00 8f5200 aa3803 9d0006 8f3f71 5a524c`) },
  ];
  const DEFAULT = 'obsidian';
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
