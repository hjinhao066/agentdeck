// The screen a spec's window stands on: how many device pixels a CSS pixel takes.
// Playwright's page.setViewportSize emulates a 1x screen in Electron, whatever the machine's (it sends
// deviceScaleFactor 1, and an Electron app takes no deviceScaleFactor option); a window it never resized has the
// machine's own (a MacBook 2, the Windows PC 1). The crew map's least scale depends on it (no text under 10 device
// px), so a spec says which screen it means, after every resize: 2 for the layouts drawn on a MacBook, 1 in
// crew-map-readable.
const sessions = new WeakMap();

module.exports = async function screenDensity(page, deviceScaleFactor) {
  if (!sessions.has(page)) sessions.set(page, await page.context().newCDPSession(page));
  const [width, height] = await page.evaluate(() => [innerWidth, innerHeight]);
  await sessions.get(page).send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false });
  await page.waitForFunction((d) => devicePixelRatio === d, deviceScaleFactor);
};
