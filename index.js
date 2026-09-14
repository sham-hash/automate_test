const path = require('path');
process.env.PUPPETEER_CACHE_DIR = path.join(__dirname, '.puppeteer-cache');

const express = require('express');
const puppeteer = require('puppeteer');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const app = express();
const port = Number(process.env.PORT || 3000);

app.get('/', (request, response) => {
    response.json({ status: 'ok', service: 'whatsapp-n8n' });
});

app.get('/health', (request, response) => {
    response.json({ status: 'ok' });
});

app.listen(port, () => {
    console.log(`Health server listening on port ${port}`);
});

let client;
const chatMenus = new Map();
let readyAt = 0;
let hasLoggedAuthenticated = false;
let waitingLogTimer = null;

function createClient() {
    const executablePath = puppeteer.executablePath();
    console.log(`Using Chrome executable: ${executablePath}`);

    return new Client({
        authStrategy: new LocalAuth(),
        webVersionCache: {
            type: 'none'
        },
        authTimeoutMs: 90000,
        puppeteer: {
            headless: true,
            executablePath,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        }
    });
}

function attachClientEvents(whatsappClient) {
    whatsappClient.on('loading_screen', (percent, message) => {
        console.log(`WhatsApp loading: ${percent}% ${message || ''}`.trim());
    });

    whatsappClient.on('qr', (qr) => {
        console.log('Scan this QR code with WhatsApp:');
        qrcode.generate(qr, { small: true });
        console.log(`QR_CODE_PAYLOAD:${qr}`);
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
        console.log('WhatsApp login session received. Finishing startup...');
        console.log('WhatsApp authenticated. Waiting for chats to finish loading...');
        startWaitingLog();
    });

    whatsappClient.on('ready', () => {
        stopWaitingLog();
        readyAt = Date.now();
        console.log('WhatsApp connected successfully!');
    });

    whatsappClient.on('auth_failure', (message) => {
        console.error('WhatsApp authentication failed:', message);
    });

    whatsappClient.on('disconnected', (reason) => {
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

function waitForReady(whatsappClient, timeoutMs = 90000) {
    if (readyAt) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const onReady = () => {
            clearTimeout(timer);
            resolve();
        };

        const timer = setTimeout(() => {
            whatsappClient.removeListener('ready', onReady);
            reject(new Error('WhatsApp stayed on chat sync too long'));
        }, timeoutMs);

        whatsappClient.once('ready', onReady);
    });
}

async function startWhatsApp(maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        readyAt = 0;
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
            console.log('Initializing WhatsApp client...');
            await Promise.race([
                client.initialize(),
                new Promise((resolve, reject) => {
                    setTimeout(() => {
                        reject(new Error('WhatsApp browser initialization timed out after 120 seconds'));
                    }, 120000);
                })
            ]);
            await waitForReady(client);
            return;
        } catch (error) {
            console.error('WhatsApp initialization failed:', error.message);

            try {
                await client.destroy();
            } catch (destroyError) {
                console.error('Failed to close the WhatsApp browser:', destroyError.message);
            }

            if (attempt === maxAttempts) {
                console.error('Could not connect after 3 attempts. Run node index.js again.');
                process.exitCode = 1;
                return;
            }

            await new Promise((resolve) => setTimeout(resolve, 3000));
        }
    }
}

startWhatsApp();
