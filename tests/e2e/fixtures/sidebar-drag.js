// Drag a sidebar row onto another sidebar target with the real mouse.
// The session list scrolls. In a short window (Windows' title bar and menu take
// about 60px the Mac does not lose) a row can sit below the list's visible edge,
// and the point boundingBox() gives for it then belongs to the panel covering it,
// so the drag never starts. Grab the row where it shows, then bring the target
// into view while the button is held, as the list does for a person dragging.
module.exports = async function dragRow(page, from, to, { fromX = 30, toX = 30 } = {}) {
  await from.scrollIntoViewIfNeeded();
  const a = await from.boundingBox();
  await page.mouse.move(a.x + fromX, a.y + a.height / 2);
  await page.mouse.down();
  // past the 4px threshold that tells a drag from a click
  await page.mouse.move(a.x + fromX, a.y + a.height / 2 - 8, { steps: 2 });
  await to.scrollIntoViewIfNeeded();
  const b = await to.boundingBox();
  await page.mouse.move(b.x + toX, b.y + b.height / 2, { steps: 6 });
  await page.mouse.up();
};
