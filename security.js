'use strict';
const { pathToFileURL } = require('url');
const path = require('path');

function validId(value) {
  return typeof value === 'string' && value.length <= 160 &&
    /^[a-zA-Z0-9_-]/.test(value) && !/[^a-zA-Z0-9._-]/.test(value) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}
function trustedSender(event, win, filename) {
  return !!win && !win.isDestroyed() && event.sender === win.webContents &&
    event.senderFrame === win.webContents.mainFrame &&
    event.senderFrame.url === pathToFileURL(filename).href;
}
function privateFile(root, id, suffix = '.txt') {
  if (!validId(id)) throw new Error('Invalid terminal identifier');
  return path.join(root, id + suffix);
}
function boundedAppend(buffer, data, limit) {
  // A single giant write must obey the same bound as many small writes.
  const tail = data.length > limit ? data.slice(-limit) : data;
  buffer.chunks.push(tail);
  buffer.totalSize += tail.length;
  while (buffer.totalSize > limit && buffer.chunks.length > 1) {
    buffer.totalSize -= buffer.chunks.shift().length;
  }
  buffer.dirty = true;
}
module.exports = { validId, trustedSender, privateFile, boundedAppend };
