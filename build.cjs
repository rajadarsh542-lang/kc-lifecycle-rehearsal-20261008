'use strict';
// Only Node built-ins. No installs, network calls, environment dump or app imports.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const sourceVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'source-version.json'), 'utf8')).sourceVersion;
if (!['fixture-v1', 'fixture-v2'].includes(sourceVersion)) throw new Error('Invalid fixture version');
const commit = /^[a-f0-9]{40}$/i.test(process.env.RENDER_GIT_COMMIT || '') ? process.env.RENDER_GIT_COMMIT : null;
const receipt = {
  buildId: randomUUID(), builtAt: new Date().toISOString(), sourceVersion,
  buildCommit: commit, buildNodeVersion: process.version
};
fs.writeFileSync(path.join(__dirname, 'build-receipt.json'), JSON.stringify(receipt) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ event: 'build_complete', ...receipt }));
