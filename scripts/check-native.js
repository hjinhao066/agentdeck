'use strict';
// node-pty 1.1 ships ABI-stable Node-API prebuilds for Windows and macOS.
// npm already runs its source-build fallback on unsupported platforms.
const fs = require('fs');
const path = require('path');
if (process.platform === 'darwin') {
  const root = path.dirname(require.resolve('node-pty/package.json'));
  // The 1.1.0 npm tarball records these executables as 0644. Restore both
  // architectures before testing/packaging (including cross-architecture DMGs).
  for (const arch of ['arm64', 'x64']) {
    const helper = path.join(root, 'prebuilds', `darwin-${arch}`, 'spawn-helper');
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
}
require('node-pty');
console.log(`node-pty loaded on ${process.platform}/${process.arch}`);
