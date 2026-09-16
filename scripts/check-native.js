'use strict';
// node-pty 1.1 ships ABI-stable Node-API prebuilds for Windows and macOS.
// npm already runs its source-build fallback on unsupported platforms.
require('node-pty');
console.log(`node-pty loaded on ${process.platform}/${process.arch}`);
