const path = require('path');
process.env.PUPPETEER_CACHE_DIR = path.join(__dirname, '.puppeteer-cache');

const express = require('express');
const puppeteer = require('puppeteer');
const QRCode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const app = express();
const port = Number(process.env.PORT || 3000);
const publicUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;

let client;
const chatMenus = new Map();
let whatsappStatus = 'starting';
let latestQr = '';
let latestQrImage = '';
let readyAt = 0;
let hasLoggedAuthenticated = false;
let waitingLogTimer = null;
let startupStartedAt = Date.now();
let loadingPercent = 0;
let loadingMessage = 'Starting Chrome...';

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function elapsedLabel() {
    const seconds = Math.max(0, Math.round((Date.now() - startupStartedAt) / 1000));
    const minutes = Math.floor(seconds / 60);
    const remaining = seconds % 60;
    return minutes > 0 ? `${minutes}m ${remaining}s` : `${seconds}s`;
}

function renderQrPage() {
    const connected = Boolean(readyAt);
    const heading = connected
        ? 'WhatsApp is connected'
        : latestQrImage
            ? 'Scan this QR code with WhatsApp'
            : 'WhatsApp is starting...';
    const details = connected
        ? 'You can close this page. Keep the Render service running.'
        : latestQrImage
            ? 'Open WhatsApp → Linked devices → Link a device, then scan this code.'
            : 'On Render this can take 2 to 5 minutes the first time. Keep this tab open.';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${connected ? '' : '<meta http-equiv="refresh" content="3">'}
    <title>WhatsApp login</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 420px; margin: 40px auto; padding: 0 16px; text-align: center; color: #111; }
        img { width: 280px; height: 280px; background: #fff; padding: 12px; border: 1px solid #ddd; }
        .status { color: #555; }
    </style>
</head>
<body>
    <h1>${escapeHtml(heading)}</h1>
    <p class="status">Status: ${escapeHtml(whatsappStatus)}</p>
    ${connected || latestQrImage ? '' : `<p>Loading: ${escapeHtml(String(loadingPercent))}% ${escapeHtml(loadingMessage)}</p>`}
    <p class="status">Elapsed: ${escapeHtml(elapsedLabel())}</p>
    ${latestQrImage && !connected ? `<img alt="WhatsApp QR code" src="${latestQrImage}">` : ''}
    <p>${escapeHtml(details)}</p>
</body>
</html>`;
}

app.get('/', (request, response) => {
    response.type('html').send(renderQrPage());
});

app.get('/health', (request, response) => {
    response.json({ status: 'ok' });
});

app.get('/status', (request, response) => {
    response.json({
        status: whatsappStatus,
        ready: Boolean(readyAt),
        hasQr: Boolean(latestQr),
        loadingPercent,
        elapsedSeconds: Math.round((Date.now() - startupStartedAt) / 1000)
    });
});

app.listen(port, () => {
    console.log(`Health server listening on port ${port}`);
    console.log(`Open ${publicUrl} to scan the WhatsApp QR code.`);
});

function createClient() {
    const executablePath = puppeteer.executablePath();
    console.log(`Using Chrome executable: ${executablePath}`);

    return new Client({
        authStrategy: new LocalAuth(),
        webVersionCache: {
            type: 'local'
        },
        authTimeoutMs: 360000,
        userAgent:
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.31 Safari/537.36',
        puppeteer: {
            headless: true,
            executablePath,
            dumpio: process.env.DEBUG_CHROME === '1',
            protocolTimeout: 420000,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--no-first-run',
                '--no-zygote',
                '--mute-audio',
                ...(process.env.WHATSAPP_SINGLE_PROCESS === '1' ? ['--single-process'] : [])
            ]
        }
    });
}

function attachClientEvents(whatsappClient) {
    whatsappClient.on('loading_screen', (percent, message) => {
        loadingPercent = Number(percent) || 0;
        loadingMessage = message || 'WhatsApp';
        console.log(`WhatsApp loading: ${percent}% ${message || ''}`.trim());
    });

    whatsappClient.on('qr', async (qr) => {
        whatsappStatus = 'waiting_for_qr_scan';
        latestQr = qr;

        try {
            latestQrImage = await QRCode.toDataURL(qr, { width: 320, margin: 1 });
        } catch (error) {
            latestQrImage = '';
            console.error('Failed to render QR image:', error.message || error);
        }

        console.log('Scan this QR code with WhatsApp:');
        qrcode.generate(qr, { small: true });
        console.log(`Open ${publicUrl} to scan the QR code in your browser.`);
    });

    whatsappClient.on('error', (error) => {
        whatsappStatus = 'error';
        console.error('WhatsApp browser error:', error.message || error);
    });

    whatsappClient.on('change_state', (state) => {
        console.log(`WhatsApp state changed: ${state}`);
    });

    whatsappClient.on('browser_opening', () => {
        console.log('WhatsApp browser is opening...');
    });

    whatsappClient.on('browser_close', () => {
        console.log('WhatsApp browser closed.');
    });

    whatsappClient.on('authenticated', () => {
        if (hasLoggedAuthenticated) {
            return;
        }

        hasLoggedAuthenticated = true;
        latestQr = '';
        latestQrImage = '';
        whatsappStatus = 'authenticated';
        console.log('WhatsApp login session received. Finishing startup...');
        console.log('WhatsApp authenticated. Waiting for chats to finish loading...');
        startWaitingLog();
    });

    whatsappClient.on('ready', () => {
        stopWaitingLog();
        readyAt = Date.now();
        latestQr = '';
        latestQrImage = '';
        whatsappStatus = 'ready';
        console.log('WhatsApp connected successfully!');
    });

    whatsappClient.on('auth_failure', (message) => {
        whatsappStatus = 'auth_failure';
        console.error('WhatsApp authentication failed:', message);
    });

    whatsappClient.on('disconnected', (reason) => {
        whatsappStatus = 'disconnected';
        console.error('WhatsApp disconnected:', reason);
    });

    whatsappClient.on('message', async (message) => {
        try {
            if (!shouldHandleMessage(message)) {
                return;
            }

            const body = normalize(message.body);

            console.log('Message received:', message.body);

            const greetingPattern = /^(?:h+i+|hello+|hey+)$/;
            if (greetingPattern.test(body)) {
                chatMenus.set(message.from, 'service');
                await sendServiceMenu(message.from, message);
                return;
            }

            const selection = getSelectionFromText(body, message.from);
            if (selection) {
                await handleSelection(selection, message.from, message);
                return;
            }

            await sendTeamContact(message.from, message);
        } catch (error) {
            console.error('Failed to process WhatsApp message:', error.message || error);
        }
    });
}

// Edit these replies to update the bot's messages.
const REPLIES = {
    serviceMenu: [
        'Hi 👋 Welcome to ShaTechX IT Solutions!',
        '',
        'Please select a service:',
        '',
        '1. Website Development',
        '2. App Development',
        '3. Digital Marketing',
        '4. Smart Menu'
    ].join('\n'),
    websiteMenu: [
        'Please select a website type:',
        '',
        '1. Static website',
        '2. Dynamic website'
    ].join('\n'),
    teamContact: 'Our Team will contact you soon✨...',
    websitePackagesCaption: 'Here are our website development packages.'
};

function normalize(text) {
    return String(text || '').trim().toLowerCase();
}

function shouldHandleMessage(message) {
    if (!readyAt || message.fromMe || message.isStatus) {
        return false;
    }

    const messageTime = Number(message.timestamp || 0) * 1000;
    if (messageTime && messageTime < readyAt - 2000) {
        return false;
    }

    return Boolean(normalize(message.body));
}

function startWaitingLog() {
    stopWaitingLog();

    const startedAt = Date.now();
    waitingLogTimer = setInterval(() => {
        const seconds = Math.round((Date.now() - startedAt) / 1000);
        console.log(`Still syncing WhatsApp chats... ${seconds}s`);
    }, 10000);
}

function stopWaitingLog() {
    if (waitingLogTimer) {
        clearInterval(waitingLogTimer);
        waitingLogTimer = null;
    }
}

async function sendServiceMenu(chatId, message) {
    chatMenus.set(chatId, 'service');

    if (message) {
        await message.reply(REPLIES.serviceMenu);
        return;
    }

    await client.sendMessage(chatId, REPLIES.serviceMenu);
}

async function sendWebsiteMenu(chatId, message) {
    chatMenus.set(chatId, 'website');

    if (message) {
        await message.reply(REPLIES.websiteMenu);
        return;
    }

    await client.sendMessage(chatId, REPLIES.websiteMenu);
}

async function sendWebsitePackages(chatId, message) {
    const imagePath = path.join(__dirname, 'assets', 'web', 'pack.jpeg');
    const image = MessageMedia.fromFilePath(imagePath);
    const options = { caption: REPLIES.websitePackagesCaption };

    if (message) {
        await message.reply(image, undefined, options);
        return;
    }

    await client.sendMessage(chatId, image, options);
}

async function sendTeamContact(chatId, message) {
    if (message) {
        await message.reply(REPLIES.teamContact);
        return;
    }

    await client.sendMessage(chatId, REPLIES.teamContact);
}

async function handleSelection(selection, chatId, message) {
    if (selection === 'website') {
        await sendWebsiteMenu(chatId, message);
        return;
    }

    if (selection === 'website-package') {
        await sendWebsitePackages(chatId, message);
        return;
    }

    await sendTeamContact(chatId, message);
}

function getSelectionFromText(body, chatId) {
    if (chatMenus.get(chatId) === 'website') {
        if (
            body === '1' ||
            body === '2' ||
            body === 'static' ||
            body === 'dynamic' ||
            /^(?:static|dynamic)(?:\s|-)?website$/.test(body)
        ) {
            chatMenus.set(chatId, 'service');
            return 'website-package';
        }
    }

    if (body === '1' || body === 'website development' || body === 'website-development') {
        return 'website';
    }

    if (
        body === '2' ||
        body === '3' ||
        body === '4' ||
        body === 'app development' ||
        body === 'app-development' ||
        body === 'digital marketing' ||
        body === 'digital-marketing' ||
        body === 'smart menu' ||
        body === 'smart-menu'
    ) {
        return 'contact';
    }

    if (
        body === 'static' ||
        body === 'dynamic' ||
        /^(?:static|dynamic)(?:\s|-)?website$/.test(body)
    ) {
        return 'website-package';
    }

    return null;
}

function waitForReady(whatsappClient, timeoutMs = 120000) {
    if (readyAt) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        let timer;

        const cleanup = () => {
            clearTimeout(timer);
            whatsappClient.removeListener('ready', onReady);
            whatsappClient.removeListener('qr', onQr);
            whatsappClient.removeListener('authenticated', onAuthenticated);
        };

        const startSyncTimeout = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                cleanup();
                reject(new Error('WhatsApp stayed on chat sync too long'));
            }, timeoutMs);
        };

        const onReady = () => {
            cleanup();
            resolve();
        };

        const onQr = () => {
            clearTimeout(timer);
            console.log(`QR is ready. Keep this service running and open ${publicUrl}`);
        };

        const onAuthenticated = () => {
            startSyncTimeout();
        };

        if (whatsappStatus === 'waiting_for_qr_scan') {
            console.log(`QR is ready. Keep this service running and open ${publicUrl}`);
        } else if (whatsappStatus === 'authenticated') {
            startSyncTimeout();
        }

        whatsappClient.on('qr', onQr);
        whatsappClient.on('authenticated', onAuthenticated);
        whatsappClient.once('ready', onReady);
    });
}

async function startWhatsApp(maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        readyAt = 0;
        latestQr = '';
        latestQrImage = '';
        loadingPercent = 0;
        loadingMessage = 'Starting Chrome...';
        startupStartedAt = Date.now();
        hasLoggedAuthenticated = false;
        stopWaitingLog();
        client = createClient();
        attachClientEvents(client);

        console.log(
            attempt === 1
                ? 'Starting WhatsApp...'
                : `Retrying WhatsApp connection (${attempt}/${maxAttempts})...`
        );

        try {
            whatsappStatus = 'initializing';
            console.log('Initializing WhatsApp client...');
            const readyPromise = waitForReady(client);
            await Promise.race([
                client.initialize(),
                new Promise((resolve, reject) => {
                    setTimeout(() => {
                        reject(new Error('WhatsApp browser initialization timed out after 7 minutes'));
                    }, 420000);
                })
            ]);
            await readyPromise;
            return;
        } catch (error) {
            console.error('WhatsApp initialization failed:', error.message);

            try {
                await client.destroy();
            } catch (destroyError) {
                console.error('Failed to close the WhatsApp browser:', destroyError.message);
            }

            if (attempt === maxAttempts) {
                console.error('Could not connect after 3 attempts. Redeploy or restart the Render service.');
                process.exitCode = 1;
                return;
            }

            await new Promise((resolve) => setTimeout(resolve, 3000));
        }
    }
}

startWhatsApp();
