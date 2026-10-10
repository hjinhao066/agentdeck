'use strict';
// The side pane's reading view: what an Obsidian note uses beyond plain
// Markdown (highlight, callouts, task boxes, properties, tags, footnotes,
// [[links]], pictures), and the colour themes it is shown in. The extra syntax
// is read only when asked for (`rich`): chat bubbles and the phone page keep
// their output.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../mobile-web/hub/core.js');
const Themes = require('../preview-themes');

const rich = (text) => Core.renderMarkdown(text, { rich: true, links: true });

test('without `rich` the reply renderer writes what it always wrote', () => {
  const src = '---\ntitle: a\n---\n\n==重点== #标签 [[笔记]] 脚注[^1]\n\n> [!note] 标题\n> 正文\n\n- [ ] 待办\n- [x] 做完\n\n[^1]: 出处\n\n![图](shots/a.png)';
  const html = Core.renderMarkdown(src);
  assert.doesNotMatch(html, /<mark>|md-callout|md-task|md-props|md-tag|md-wiki|md-fn|<img/);
  assert.match(html, /<li>☐ 待办<\/li><li>☑ 做完<\/li>/);
  assert.match(html, /==重点==/);
  assert.equal(Core.renderMarkdown(src, { breaks: true, links: true }).includes('md-callout'), false);
});

test('highlight, strike, bold and italic each get their own tag', () => {
  const html = rich('这是 ==高亮== 、~~删除~~ 、**粗体** 和 *斜体*，`a == b` 不算');
  assert.match(html, /<mark>高亮<\/mark>/);
  assert.match(html, /<del>删除<\/del>/);
  assert.match(html, /<strong>粗体<\/strong>/);
  assert.match(html, /<em>斜体<\/em>/);
  assert.match(html, /<code>a == b<\/code>/);
});

test('task items carry a box and a done state, ordinary items do not', () => {
  const html = rich('- [ ] 买菜\n- [x] 写周报\n- 普通一条');
  assert.match(html, /<li class="md-task"><span class="md-box" role="checkbox" aria-checked="false" aria-label="未完成"><\/span>买菜<\/li>/);
  assert.match(html, /<li class="md-task done"><span class="md-box" role="checkbox" aria-checked="true" aria-label="已完成"><\/span>写周报<\/li>/);
  assert.match(html, /<li>普通一条<\/li>/);
});

test('callouts: a kind, a title, a body laid out as Markdown, and the folding ones fold', () => {
  const note = rich('> [!warning] 小心\n> 第一行\n> - 一条\n> - 两条');
  assert.match(note, /<div class="md-callout" data-kind="warn"><div class="md-callout-title"><svg[^>]*>.*?<\/svg><span>小心<\/span><\/div><div class="md-callout-body"><p>第一行<\/p>\n<ul><li>一条<\/li><li>两条<\/li><\/ul><\/div><\/div>/);
  // no title: the kind's own name; an unknown kind reads as a note
  assert.match(rich('> [!tip]\n> 正文'), /data-kind="tip"><div class="md-callout-title"><svg.*?<\/svg><span>提示<\/span>/);
  assert.match(rich('> [!whatever] 自定义'), /data-kind="info".*<span>自定义<\/span>/);
  assert.match(rich('> [!faq]- 折起来\n> 答案'), /<details class="md-callout" data-kind="ask"><summary class="md-callout-title">.*<span>折起来<\/span><\/summary><div class="md-callout-body"><p>答案<\/p><\/div><\/details>/);
  assert.match(rich('> [!example]+ 展开的\n> 内容'), /<details class="md-callout" data-kind="eg" open>/);
  // an ordinary quote stays a quote
  assert.match(rich('> 只是引用'), /^<blockquote>只是引用<\/blockquote>$/);
});

test('properties at the top become a table; a rule at the top stays a rule', () => {
  const html = rich('---\ntitle: 周报\ntags: [项目, 复盘]\naliases:\n  - 第 41 周\n  - W41\ndate: 2026-10-09\n---\n\n# 正文');
  assert.match(html, /^<div class="md-props"><table><tbody><tr><th>title<\/th><td><span class="md-prop">周报<\/span><\/td><\/tr><tr><th>tags<\/th><td><span class="md-prop md-tag">项目<\/span><span class="md-prop md-tag">复盘<\/span><\/td><\/tr><tr><th>aliases<\/th><td><span class="md-prop">第 41 周<\/span><span class="md-prop">W41<\/span><\/td><\/tr><tr><th>date<\/th><td><span class="md-prop">2026-10-09<\/span><\/td><\/tr><\/tbody><\/table><\/div>\n<h1>正文<\/h1>$/);
  assert.match(rich('---\n\n随便一段话，不是属性\n\n---\n'), /^<hr>\n<p>随便一段话，不是属性<\/p>\n<hr>$/);
});

test('tags, [[links]], pictures and comments', () => {
  assert.match(rich('见 #项目/复盘 和 #todo，#1 不是标签，a#b 也不是'), /见 <span class="md-tag">#项目\/复盘<\/span> 和 <span class="md-tag">#todo<\/span>，#1 不是标签，a#b 也不是/);
  assert.match(rich('[[周报]] 和 [[notes/计划.md|计划]] 和 [[周报#第二节]]'),
    /<a class="md-wiki" data-file="周报\.md" data-rel="1">周报<\/a> 和 <a class="md-wiki" data-file="notes\/计划\.md" data-rel="1">计划<\/a> 和 <a class="md-wiki" data-file="周报\.md" data-rel="1">周报#第二节<\/a>/);
  assert.match(rich('![界面](shots/a%20b.png) ![[图/c.png]]'), /<img class="md-img" data-src="shots\/a%20b\.png" alt="界面"> <img class="md-img" data-src="图\/c\.png" alt="图\/c\.png">/);
  // a picture on the web is named, not loaded (the page's own rules forbid fetching it)
  assert.match(rich('![远程](https://example.com/a.png)'), /<a href="https:\/\/example\.com\/a\.png" data-ext="1">远程<\/a>/);
  assert.equal(rich('看得见 %%看不见%% 也看得见\n\n%%\n整段\n都看不见\n%%\n\n结尾'), '<p>看得见  也看得见</p>\n<p>结尾</p>');
  // inside a code block none of it is read
  assert.match(rich('```\n==x== #tag [[a]] %%c%%\n[^1]: 定义\n```'), /==x== #tag \[\[a\]\] %%c%%\n\[\^1\]: 定义/);
});

test('footnotes are numbered in the order they are used and listed at the end', () => {
  const html = rich('先引第二条[^b]，再引第一条[^a]，又引第二条[^b]。没定义的[^zz]留原样。\n\n[^a]: 甲的出处\n[^b]: 乙的 **出处**');
  assert.match(html, /先引第二条<sup class="md-fn" data-fn="1">1<\/sup>，再引第一条<sup class="md-fn" data-fn="2">2<\/sup>，又引第二条<sup class="md-fn" data-fn="1">1<\/sup>。没定义的\[\^zz\]留原样。/);
  assert.match(html, /<section class="md-footnotes"><ol><li data-fn="1">乙的 <strong>出处<\/strong><\/li><li data-fn="2">甲的出处<\/li><\/ol><\/section>$/);
});

test('nothing in a note becomes markup of its own', () => {
  const html = rich('---\ntitle: <img src=x onerror=alert(1)>\n---\n> [!note] <script>alert(1)</script>\n> <b onclick=x>正文</b>\n\n[[a" onmouseover="x]] ![[b".png]] ![x" onerror="y](a".png) ==<i>== #标签<b>\n\n[^1]: <svg onload=1>\n\n脚注[^1]');
  assert.doesNotMatch(html, /<script|<img src|<b |<i>|<svg onload|" on\w+="/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

// ---- themes ----
test('there are four to six themes, each with a light and a dark side and a name to show', () => {
  assert.ok(Themes.THEMES.length >= 4 && Themes.THEMES.length <= 6);
  assert.equal(new Set(Themes.THEMES.map((t) => t.id)).size, Themes.THEMES.length);
  for (const theme of Themes.THEMES) {
    assert.match(theme.id, /^[a-z]+$/);
    assert.ok(theme.name && theme.light && theme.dark, theme.id);
    assert.deepEqual(Object.keys(theme.light).sort(), Object.keys(theme.dark).sort(), theme.id);
    for (const mode of ['light', 'dark']) for (const [key, value] of Object.entries(theme[mode])) assert.match(value, /^#[0-9a-f]{6}$/, `${theme.id} ${mode} ${key}`);
  }
  assert.equal(Themes.normalize('nope'), Themes.DEFAULT);
  assert.equal(Themes.normalize(Themes.THEMES[2].id), Themes.THEMES[2].id);
  assert.equal(Themes.normalize(undefined), Themes.DEFAULT);
});

test('headings one to three differ from each other and from the body text in every theme but the quiet one', () => {
  for (const theme of Themes.THEMES) for (const mode of ['light', 'dark']) {
    const c = theme[mode];
    const distinct = new Set([c.h1, c.h2, c.h3]).size;
    if (theme.quiet) assert.ok(distinct >= 2, `${theme.id} ${mode}`);
    else assert.equal(distinct, 3, `${theme.id} ${mode}: h1 h2 h3 must be three colours`);
    for (const key of ['strong', 'em', 'code', 'link', 'mark', 'quote', 'marker', 'tag']) assert.ok(c[key], `${theme.id} ${mode} ${key}`);
    if (!theme.quiet) assert.ok(new Set([c.text, c.strong, c.em, c.code, c.link]).size >= 4, `${theme.id} ${mode}: bold, italic, code and links have colours of their own`);
  }
});

test('every text colour reads at 4.5:1 or better on what it sits on, marks and bars at 3:1', () => {
  assert.equal(Themes.contrast('#000000', '#ffffff'), 21);
  assert.ok(Math.abs(Themes.contrast('#777777', '#ffffff') - 4.48) < 0.01);
  const low = [];
  for (const theme of Themes.THEMES) for (const mode of ['light', 'dark']) {
    const pairs = Themes.pairs(theme.id, mode);
    assert.ok(pairs.length >= 30, `${theme.id} ${mode}: ${pairs.length} pairs checked`);
    for (const [name, fg, bg, need] of pairs) {
      const ratio = Themes.contrast(fg, bg);
      if (ratio < need) low.push(`${theme.id} ${mode} ${name}: ${fg} on ${bg} = ${ratio.toFixed(2)} (needs ${need})`);
    }
  }
  assert.deepEqual(low, []);
});

test('the style sheet colours only through the theme and never sets a size under 11.5px', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'preview-themes.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, 'colours come from the theme variables');
  for (const [, size] of css.matchAll(/font(?:-size)?:[^;]*?(\d+(?:\.\d+)?)px/g)) assert.ok(Number(size) >= 11.5, `font-size ${size}px`);
  // sizes given relative to the text are floored
  for (const [all] of css.matchAll(/font-size:\s*[^;]+;/g)) if (/(?<![\d.])0?\.\d+em/.test(all)) assert.match(all, /max\(11\.5px/, all);
  // every variable the sheet reads is one the themes define
  const defined = new Set(Object.keys(Themes.vars(Themes.DEFAULT, 'dark')));
  for (const [, name] of css.matchAll(/var\((--md-[a-z0-9-]+)/g)) assert.ok(defined.has(name), name);
  const sheet = Themes.sheet();
  for (const theme of Themes.THEMES) for (const mode of ['light', 'dark']) assert.ok(sheet.includes(`:root[data-theme="${mode}"] .pv-md[data-md-theme="${theme.id}"]`), `${theme.id} ${mode}`);
});
