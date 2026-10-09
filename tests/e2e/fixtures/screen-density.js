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
