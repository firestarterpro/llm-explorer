// Installs the Chromium build this Playwright version expects into ./pw-browsers.
// electron-builder ships that folder as resources/ms-playwright (see package.json
// "extraResources"), and scrapers.js points PLAYWRIGHT_BROWSERS_PATH at it, so the
// installed .exe never depends on a browser cache on the build machine.
const { spawnSync } = require('child_process');
const path = require('path');

const target = path.join(__dirname, '..', 'pw-browsers');
const cli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');

// Headed scraping only needs full Chromium. Playwright adds winldd (Windows
// dependency checks at launch) and ffmpeg on its own.
const result = spawnSync(process.execPath, [cli, 'install', '--no-shell', 'chromium'], {
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: target }
});

process.exit(result.status === null ? 1 : result.status);
