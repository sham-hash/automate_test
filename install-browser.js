const path = require('path');
const { spawnSync } = require('child_process');

const cacheDir = path.join(__dirname, '.puppeteer-cache');
const cliPath = require.resolve('puppeteer/lib/cjs/puppeteer/node/cli.js');
const result = spawnSync(
    process.execPath,
    [cliPath, 'browsers', 'install', 'chrome'],
    {
        env: { ...process.env, PUPPETEER_CACHE_DIR: cacheDir },
        stdio: 'inherit'
    }
);

if (result.error) {
    throw result.error;
}

process.exit(result.status ?? 1);