const path = require('path');
process.env.PUPPETEER_CACHE_DIR = path.join(__dirname, '.puppeteer-cache');

const { fork } = require('child_process');
const express = require('express');

const app = express();
const port = Number(process.env.PORT || 3000);
const publicUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;

const state = {
    whatsappStatus: 'starting',
    latestQrImage: '',
    hasQr: false,
    readyAt: 0,
    hasLoggedAuthenticated: false,
    loadingPercent: 0,
    loadingMessage: 'Starting WhatsApp worker...',
    startupStartedAt: Date.now()
};

let worker = null;
let restartTimer = null;
let restartDelayMs = 3000;

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function elapsedLabel() {
    const seconds = Math.max(0, Math.round((Date.now() - state.startupStartedAt) / 1000));
    const minutes = Math.floor(seconds / 60);
    const remaining = seconds % 60;
    return minutes > 0 ? `${minutes}m ${remaining}s` : `${seconds}s`;
}

function renderQrPage() {
    const connected = Boolean(state.readyAt);
    const scanned = state.hasLoggedAuthenticated && !connected;
    const hasQr = Boolean(state.latestQrImage) && !connected && !scanned;
    const heading = connected
        ? 'WhatsApp is connected'
        : scanned
            ? 'QR scanned. Connecting the bot...'
            : hasQr
                ? 'Scan this QR code first'
                : 'Getting WhatsApp QR code...';
    const details = connected
        ? 'The bot is live. Keep the Render service running.'
        : scanned
            ? 'Login succeeded. Waiting a few seconds for the bot to come online.'
            : hasQr
                ? 'Scan this code in WhatsApp first. After that, the bot will finish connecting.'
                : 'The website stays online while Chrome starts. The QR can take several minutes on Render.';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${connected ? '' : '<meta http-equiv="refresh" content="5">'}
    <title>WhatsApp login</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 420px; margin: 40px auto; padding: 0 16px; text-align: center; color: #111; }
        img { width: 280px; height: 280px; background: #fff; padding: 12px; border: 1px solid #ddd; }
        .status { color: #555; }
    </style>
</head>
<body>
    <h1>${escapeHtml(heading)}</h1>
    <p class="status">Status: ${escapeHtml(state.whatsappStatus)}</p>
    ${hasQr ? `<img alt="WhatsApp QR code" src="${state.latestQrImage}">` : `<p>${escapeHtml(state.loadingMessage)}</p>`}
    ${scanned ? `<p>QR scanned. Finishing login: ${escapeHtml(String(state.loadingPercent))}%</p>` : ''}
    <p class="status">Elapsed: ${escapeHtml(elapsedLabel())}</p>
    <p>${escapeHtml(details)}</p>
</body>
</html>`;
}

function startWorker() {
    if (worker) {
        return;
    }

    state.whatsappStatus = 'starting';
    state.loadingMessage = 'Starting WhatsApp worker...';
    state.startupStartedAt = Date.now();

    worker = fork(path.join(__dirname, 'whatsapp-worker.js'), [], {
        execArgv: ['--max-old-space-size=192'],
        env: {
            ...process.env,
            PUPPETEER_CACHE_DIR: process.env.PUPPETEER_CACHE_DIR,
            PUBLIC_URL: publicUrl
        },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    });

    worker.on('message', (message) => {
        if (!message || message.type !== 'state') {
            return;
        }

        state.whatsappStatus = message.whatsappStatus || state.whatsappStatus;
        state.latestQrImage = message.latestQrImage || '';
        state.hasQr = Boolean(message.hasQr);
        state.readyAt = Number(message.readyAt || 0);
        state.hasLoggedAuthenticated = Boolean(message.hasLoggedAuthenticated);
        state.loadingPercent = Number(message.loadingPercent || 0);
        state.loadingMessage = message.loadingMessage || state.loadingMessage;
        state.startupStartedAt = Number(message.startupStartedAt || state.startupStartedAt);
        restartDelayMs = 3000;
    });

    worker.on('exit', (code, signal) => {
        console.error(`WhatsApp worker stopped (${signal || code}). Keeping the website online.`);
        worker = null;
        state.readyAt = 0;
        state.hasLoggedAuthenticated = false;
        state.latestQrImage = '';
        state.hasQr = false;
        state.whatsappStatus = 'restarting';
        state.loadingMessage = 'WhatsApp worker stopped. Restarting Chrome without taking the website down...';

        clearTimeout(restartTimer);
        restartTimer = setTimeout(() => {
            restartDelayMs = Math.min(restartDelayMs * 2, 30000);
            startWorker();
        }, restartDelayMs);
    });
}

app.get('/', (request, response) => {
    response.type('html').send(renderQrPage());
});

app.get('/health', (request, response) => {
    response.json({ status: 'ok' });
});

app.get('/status', (request, response) => {
    response.json({
        status: state.whatsappStatus,
        ready: Boolean(state.readyAt),
        hasQr: state.hasQr,
        loadingPercent: state.loadingPercent,
        elapsedSeconds: Math.round((Date.now() - state.startupStartedAt) / 1000)
    });
});

app.listen(port, () => {
    console.log(`Health server listening on port ${port}`);
    console.log(`Open ${publicUrl} to scan the WhatsApp QR code.`);
    console.log('Set the Render health check path to /health');
    setTimeout(startWorker, 1000);
});

process.on('uncaughtException', (error) => {
    console.error('uncaughtException:', error.message || error);
});

process.on('unhandledRejection', (error) => {
    console.error('unhandledRejection:', error && error.message ? error.message : error);
});
