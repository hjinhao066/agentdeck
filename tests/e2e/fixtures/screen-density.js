// The window a spec draws in: its size in CSS px and the screen's density (device pixels per CSS pixel), set
// together in one step through the DevTools protocol.
// Not page.setViewportSize: in Electron that emulates a 1x screen, whatever the machine's (Playwright sends
// deviceScaleFactor 1, and an Electron app takes no deviceScaleFactor option), and a density put back after it
// leaves the map arranged once for a 1x screen in between. The crew map's least scale depends on the density
// (no text under 10 device px), so a spec says which screen it means: 2 for the layouts drawn on a MacBook, 1 in
// crew-map-readable. Without a size, the window keeps the one it has.
const sessions = new WeakMap();

module.exports = async function emulateScreen(page, width, height, deviceScaleFactor) {
  if (!sessions.has(page)) sessions.set(page, await page.context().newCDPSession(page));
  if (!width || !height) [width, height] = await page.evaluate(() => [innerWidth, innerHeight]);
  await sessions.get(page).send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false });
  // (polled on a timer, not on frames: an inactive test window may draw none for a while)
  await page.waitForFunction(([w, h, d]) => innerWidth === w && innerHeight === h && devicePixelRatio === d, [width, height, deviceScaleFactor], { polling: 100 });
};

// A picture taken through the same DevTools session: page.screenshot sets the density back to the window's own
// (and an identical setting sent again does not bring it back). clip in CSS px; scale 'css' gives a CSS-px picture,
// 'device' (the default, as page.screenshot's) a device-px one; path writes it there. animations 'disabled' finishes
// the ones that end and holds the rest still while the picture is taken.
module.exports.capture = async function capture(page, { path: file, clip, scale = 'device', animations = 'allow' } = {}) {
  if (!sessions.has(page)) sessions.set(page, await page.context().newCDPSession(page));
  const [width, height, dpr] = await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
  if (animations === 'disabled') await page.evaluate(() => document.getAnimations().forEach((a) => { if (a.effect && Number.isFinite(a.effect.getComputedTiming().iterations)) a.finish(); else if (a.playState === 'running') { a.pause(); a.held = true; } }));
  const { data } = await sessions.get(page).send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, ...clip, scale: scale === 'css' ? 1 / dpr : 1 } });
  if (animations === 'disabled') await page.evaluate(() => document.getAnimations().forEach((a) => { if (a.held) { delete a.held; a.play(); } }));
  const png = Buffer.from(data, 'base64');
  if (file) require('fs').writeFileSync(file, png);
  return png;
};
