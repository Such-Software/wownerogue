'use strict';

// Gameplay-only browser check. This deliberately avoids the application entrypoint, database,
// wallet, payment handlers, and queue/race transitions. The Iso grant below is a visible fixture.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');
const { chromium } = require('playwright-core');
const TavernManager = require('../network/tavernManager');

const ROOT = path.resolve(__dirname, '../..');
const HTML_ROOT = path.join(ROOT, 'html');
const OUTPUT_BASE = path.join(os.homedir(), 'Build', 'wowngeon', 'showcase-browser');
const FIXTURE_ENTITLEMENTS = Object.freeze({
    premium: true,
    level: 'free',
    credits: 0,
    totalCreditsPurchased: 0,
    packs: Object.freeze({
        'iso-dungeon': true,
        'generated-skins': false,
        'kenney-3d-characters': false,
        'roguelike-dungeon': false,
        'iso-medieval': false
    })
});

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function parseArgs(argv) {
    let outputRoot = OUTPUT_BASE;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--output-root') {
            assert(argv[i + 1], '--output-root requires a directory');
            outputRoot = path.resolve(argv[++i]);
        } else {
            throw new Error(`Unknown argument: ${argv[i]}`);
        }
    }
    return outputRoot;
}

function isLoopback(hostname) {
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

async function main() {
    assert(process.env.NODE_ENV !== 'production', 'Refusing to run with NODE_ENV=production');
    assert(fs.existsSync(path.join(HTML_ROOT, 'tavern.html')), 'Tavern source page is missing');

    const outputRoot = parseArgs(process.argv.slice(2));
    fs.mkdirSync(outputRoot, { recursive: true });
    const outputDir = fs.mkdtempSync(path.join(outputRoot, 'run-'));

    process.env.TAVERN_ENABLED = 'true';
    process.env.TAVERN_TICK_MS = '50';

    const app = express();
    const httpServer = require('node:http').createServer(app);
    const io = new Server(httpServer, { serveClient: true });
    const manager = new TavernManager({
        io,
        tickMs: 50,
        entitlementProvider: socket => socket.data.showcaseFixture === true
            ? FIXTURE_ENTITLEMENTS
            : { premium: false, totalCreditsPurchased: 0, packs: {} },
        globalChatProvider: {
            publish(message) {
                io.emit('chat_broadcast', {
                    scope: 'global', username: message.username, message: message.text
                });
            }
        }
    });
    const browserFailures = [];
    const blockedExternal = [];
    const clientsByRole = new Map();
    const expectedMissingSkin = '/assets/generated/wownero_walk.webp';
    const observedHttpFailures = [];

    app.use((req, res, next) => {
        res.setHeader('Content-Security-Policy', [
            "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:", "font-src 'self'", "connect-src 'self'", "object-src 'none'",
            "base-uri 'self'", "frame-ancestors 'self'", "form-action 'self'"
        ].join('; '));
        next();
    });
    app.get('/runtime-config.js', (_req, res) => {
        res.type('application/javascript').send('window.WOWNGEON_RUNTIME = {rendererLocalEnabled:false, rendererCdnEnabled:false};');
    });
    app.get('/tavern', (_req, res) => res.sendFile(path.join(HTML_ROOT, 'tavern.html')));
    app.use(express.static(HTML_ROOT));

    io.on('connection', socket => {
        socket.on('register_client', data => {
            const role = socket.handshake.headers['user-agent']?.match(/WowngeonShowcaseSmoke\/(mica|moth)/)?.[1];
            assert(data && data.clientId === socket.id, 'Page registration did not use its own Socket.IO id');
            assert(role, 'Unexpected browser user agent in local fixture');
            assert(!clientsByRole.has(role), `Duplicate browser role: ${role}`);
            clientsByRole.set(role, socket.id);
            socket.data.showcaseFixture = role === 'mica';
        });
        socket.on('identity:get', () => socket.emit('identity_update', {
            appearance: { avatar: 'default' },
            entitlements: socket.data.showcaseFixture ? FIXTURE_ENTITLEMENTS : {
                premium: false, level: 'free', credits: 0, totalCreditsPurchased: 0, packs: {}
            }
        }));
        socket.on('identity:update', data => socket.emit('identity_update', {
            appearance: data?.appearance || { avatar: 'default' },
            entitlements: socket.data.showcaseFixture ? FIXTURE_ENTITLEMENTS : {
                premium: false, level: 'free', credits: 0, totalCreditsPurchased: 0, packs: {}
            }
        }));
        socket.on('tavern_join', data => manager.join(socket, data));
        socket.on('tavern_move', data => manager.move(socket, data));
        socket.on('tavern_chat', data => manager.chat(socket, data));
        socket.on('disconnect', () => manager.handleDisconnect(socket.id, socket));
    });

    let browser;
    try {
        manager.initialize();
        await new Promise((resolve, reject) => {
            httpServer.once('error', reject);
            httpServer.listen(0, '127.0.0.1', resolve);
        });
        const address = httpServer.address();
        assert(address && isLoopback(address.address), 'Local server did not bind to loopback');
        const origin = `http://127.0.0.1:${address.port}`;

        browser = await chromium.launch({ headless: true });
        const views = {};
        for (const role of ['mica', 'moth']) {
            const context = await browser.newContext({ userAgent: `WowngeonShowcaseSmoke/${role}` });
            context.on('requestfailed', request => {
                const url = new URL(request.url());
                if (!isLoopback(url.hostname) || Number(url.port || 80) !== address.port) {
                    blockedExternal.push(url.origin);
                }
            });
            await context.route('**/*', route => {
                const url = new URL(route.request().url());
                if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
                if (url.protocol === 'http:' && isLoopback(url.hostname) && Number(url.port || 80) === address.port) {
                    return route.continue();
                }
                blockedExternal.push(url.origin);
                return route.abort('blockedbyclient');
            });
            await context.routeWebSocket('**/*', ws => {
                const url = new URL(ws.url());
                if (url.protocol === 'ws:' && isLoopback(url.hostname) && Number(url.port || 80) === address.port) {
                    ws.connectToServer();
                } else {
                    blockedExternal.push(url.origin);
                }
            });
            const page = await context.newPage();
            await page.route(`**${expectedMissingSkin}`, route => route.fulfill({
                status: 404,
                contentType: 'text/plain',
                body: 'Generated skin failure fixture'
            }));
            page.on('response', response => {
                if (response.status() >= 400) {
                    observedHttpFailures.push({ path: new URL(response.url()).pathname, status: response.status() });
                }
            });
            page.on('pageerror', error => browserFailures.push(error.message));
            page.on('console', message => {
                if (message.type() !== 'error') return;
                const expectedAssetFailure = message.text().includes('Failed to load resource')
                    && observedHttpFailures.some(f => f.status === 404 && f.path === expectedMissingSkin);
                if (!expectedAssetFailure) browserFailures.push(message.text());
            });
            views[role] = { context, page };
        }

        await Promise.all(Object.values(views).map(({ page }) => page.goto(`${origin}/tavern`)));
        for (const { page } of Object.values(views)) {
            await page.locator('#joinBtn').waitFor({ state: 'visible' });
            await page.waitForFunction(() => document.getElementById('joinBtn') && !document.getElementById('joinBtn').disabled);
        }
        await views.mica.page.locator('#name').fill('Mica');
        await views.mica.page.locator('#joinBtn').click();
        await views.moth.page.locator('#name').fill('Moth');
        await views.moth.page.locator('#joinBtn').click();
        await Promise.all(Object.values(views).map(({ page }) => page.locator('#stage canvas.rk-canvas').waitFor({ state: 'visible' })));
        await pageWaitFor(() => manager.room.size === 2, 3000, 'Two browser clients joined TavernManager');
        assert(clientsByRole.size === 2, 'Both page-owned client ids were not registered');
        const ids = { mica: clientsByRole.get('mica'), moth: clientsByRole.get('moth') };
        assert(ids.mica && ids.moth && ids.mica !== ids.moth, 'Browser socket ids are not distinct');
        assert(manager.room.getOccupant(ids.mica)?.name === 'Mica', 'Mica page id does not map to its server occupant');
        assert(manager.room.getOccupant(ids.moth)?.name === 'Moth', 'Moth page id does not map to its server occupant');

        const chatInput = views.mica.page.locator('#chatInput');
        await chatInput.fill('Room check');
        await views.mica.page.locator('#chatForm button[type="submit"]').click();
        await views.moth.page.locator('#chatLog').getByText('Room check').waitFor();

        const keyboard = views.mica.page;
        const micaStart = { ...manager.room.getOccupant(ids.mica) };
        for (const selector of ['#chatInput', 'select', '[contenteditable="true"]']) {
            await keyboard.evaluate(selectorText => {
                let node = document.querySelector(selectorText);
                if (!node) {
                    node = selectorText === 'select' ? document.createElement('select') : document.createElement('div');
                    if (selectorText === '[contenteditable="true"]') node.contentEditable = 'true';
                    document.body.appendChild(node);
                }
                node.focus();
            }, selector);
            await keyboard.keyboard.press('ArrowRight');
            await new Promise(resolve => setTimeout(resolve, 100));
            const after = manager.room.getOccupant(ids.mica);
            assert(after.x === micaStart.x && after.y === micaStart.y, `Arrow key moved player while ${selector} had focus`);
        }
        await keyboard.locator('#stage').click({ position: { x: 15, y: 15 } });
        await keyboard.keyboard.press('ArrowRight');
        await pageWaitFor(() => {
            const current = manager.room.getOccupant(ids.mica);
            return current.x !== micaStart.x || current.y !== micaStart.y;
        }, 1500, 'Game-surface arrow key moves the active player');

        const modeResults = {};
        for (const mode of ['tiles', 'ascii', 'iso']) {
            const page = views.mica.page;
            await page.locator(`.modebtn[data-mode="${mode}"]`).click();
            await page.waitForFunction(expected => {
                const button = document.querySelector(`.modebtn[data-mode="${expected}"]`);
                const canvas = document.querySelector('#stage canvas.rk-canvas');
                if (!button || button.getAttribute('aria-pressed') !== 'true' || !canvas) return false;
                const ctx = canvas.getContext('2d');
                if (!ctx || !canvas.width || !canvas.height) return false;
                const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                const colors = new Set();
                const sampleCols = 32, sampleRows = 32;
                for (let row = 0; row < sampleRows; row++) {
                    const y = Math.min(canvas.height - 1, Math.floor((row + 0.5) * canvas.height / sampleRows));
                    for (let col = 0; col < sampleCols; col++) {
                        const x = Math.min(canvas.width - 1, Math.floor((col + 0.5) * canvas.width / sampleCols));
                        const i = (y * canvas.width + x) * 4;
                        colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
                    }
                }
                return colors.size >= 3;
            }, mode);
            modeResults[mode] = await page.locator('#stage canvas.rk-canvas').evaluate(canvas => {
                const ctx = canvas.getContext('2d'), pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                const colors = new Set(), cols = 32, rows = 32;
                for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
                    const x = Math.min(canvas.width - 1, Math.floor((col + 0.5) * canvas.width / cols));
                    const y = Math.min(canvas.height - 1, Math.floor((row + 0.5) * canvas.height / rows));
                    const i = (y * canvas.width + x) * 4;
                    colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
                }
                return { width: canvas.width, height: canvas.height, distinctSampleColors: colors.size };
            });
            if (mode === 'iso') {
                await page.screenshot({ path: path.join(outputDir, 'tavern-desktop-iso.png'), fullPage: true });
            }
        }

        await views.mica.page.evaluate(() => RK.loadSkin('wownero-rogue'));
        await views.mica.page.waitForFunction(() => RK.skinSheetFailed('wownero-rogue'));
        const skinFailure = await views.mica.page.evaluate(() => ({
            failed: RK.skinSheetFailed('wownero-rogue'), ready: !!RK.skinSheet('wownero-rogue'), failureInjected: true
        }));
        assert(skinFailure.failed && !skinFailure.ready, 'Missing generated skin did not reach failed fallback state');

        await Promise.all(Object.values(views).map(({ page }) => page.setViewportSize({ width: 390, height: 844 })));
        const mobile = await views.moth.page.evaluate(() => ({
            viewport: document.documentElement.clientWidth,
            document: document.documentElement.scrollWidth,
            stage: document.getElementById('stage').clientWidth,
            dpadVisible: getComputedStyle(document.getElementById('tavernDpad')).display !== 'none'
        }));
        assert(mobile.document <= mobile.viewport, 'Tavern overflows the narrow viewport horizontally');
        assert(mobile.stage > 0 && mobile.dpadVisible, 'Mobile stage or movement controls are hidden');
        const mothStart = { ...manager.room.getOccupant(ids.moth) };
        await views.moth.page.getByRole('button', { name: 'Move up' }).click();
        await pageWaitFor(() => {
            const current = manager.room.getOccupant(ids.moth);
            return current.x !== mothStart.x || current.y !== mothStart.y;
        }, 1500, 'Mobile movement control moves the other player');

        const unexpectedHttpFailures = observedHttpFailures.filter(f => !(f.status === 404 && f.path === expectedMissingSkin));
        assert(observedHttpFailures.some(f => f.status === 404 && f.path === expectedMissingSkin), 'Expected missing generated skin was not requested');
        assert(unexpectedHttpFailures.length === 0, `Unexpected HTTP failures: ${JSON.stringify(unexpectedHttpFailures)}`);
        assert(blockedExternal.length === 0, `Browser attempted external network access: ${blockedExternal.join(', ')}`);
        assert(browserFailures.length === 0, `Browser errors: ${browserFailures.join(' | ')}`);

        const screenshotPaths = {};
        for (const role of ['mica', 'moth']) {
            const filename = `tavern-mobile-${role}.png`;
            await views[role].page.screenshot({ path: path.join(outputDir, filename), fullPage: true });
            screenshotPaths[role] = filename;
        }
        const result = {
            ok: true,
            scope: 'gameplay-only Tavern browser smoke; no queue/race transitions',
            origin: '127.0.0.1 loopback only',
            fixture: 'synthetic Iso entitlement fixture; zero credits, no purchase, no generated skins or 3D grant',
            clients: { count: clientsByRole.size, mappedByPageOwnedSocketId: true },
            modes: modeResults,
            chat: 'broadcast to both clients',
            keyboardFocusGuards: ['input', 'select', 'contenteditable'],
            mobile,
            missingGeneratedSkin: skinFailure,
            screenshots: { desktopIso: 'tavern-desktop-iso.png', mobile: screenshotPaths },
            unexpectedHttpFailures,
            externalRequestsBlocked: blockedExternal.length,
            outputDir
        };
        fs.writeFileSync(path.join(outputDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
        if (browser) await browser.close();
        manager.shutdown();
        await new Promise(resolve => io.close(() => resolve()));
        if (httpServer.listening) await new Promise(resolve => httpServer.close(() => resolve()));
    }
}

function pageWaitFor(predicate, timeoutMs, message) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            let value;
            try { value = predicate(); } catch (error) { reject(error); return; }
            if (value) return resolve(value);
            if (Date.now() - started >= timeoutMs) return reject(new Error(`Timed out: ${message}`));
            setTimeout(tick, 25);
        };
        tick();
    });
}

main().catch(error => {
    process.stderr.write(`Showcase browser smoke failed: ${error.message}\n`);
    process.exitCode = 1;
});
