'use strict';

// Local browser checks cover the real TavernManager, pack-gated rendering, and a client-only
// account/payout visibility matrix. They do not start the application entrypoint, database, live
// wallet, payment handlers, or multiplayer queue. Mica receives synthetic Interior and Iso grants;
// Moth receives the source-owned zero-grant catalog fixture and must remain original-only.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');
const { chromium } = require('playwright-core');
const TavernManager = require('../network/tavernManager');
const Entitlements = require('../multiplayer/entitlements');

const ROOT = path.resolve(__dirname, '../..');
const HTML_ROOT = path.join(ROOT, 'html');
const OUTPUT_BASE = path.join(os.homedir(), 'Build', 'wowngeon', 'showcase-browser');
const ZERO_FUNDS_USER = Object.freeze({ credits: 0, total_credits_purchased: 0 });
const FIXTURE_PACK_GRANTS = Object.freeze([
    Object.freeze({ pack_id: 'roguelike-interior' }),
    Object.freeze({ pack_id: 'iso-dungeon' })
]);
const FIXTURE_ENTITLEMENTS = Object.freeze(Entitlements.snapshotForUser(ZERO_FUNDS_USER, FIXTURE_PACK_GRANTS));
const FREE_ENTITLEMENTS = Object.freeze(Entitlements.snapshotForUser(ZERO_FUNDS_USER, []));

function entitlementsForSocket(socket) {
    return socket.data.showcaseFixture === true ? FIXTURE_ENTITLEMENTS : FREE_ENTITLEMENTS;
}

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

function accountGameModeInfo({ smirkEnabled, payoutsEnabled }) {
    return {
        mode: payoutsEnabled ? 'PAID_SINGLE' : 'FREE',
        freePlayEnabled: true,
        earlyEntry: { enabled: false },
        creditsPerGame: 1,
        creditsPayoutsEnabled: false,
        directModeEnabled: payoutsEnabled,
        directPayoutsEnabled: payoutsEnabled,
        paymentsEnabled: payoutsEnabled,
        smirkEnabled,
        cryptoType: 'WOW',
        currencyLabel: 'WOW',
        network: 'mainnet',
        singleGamePrice: 100000000000,
        singleGamePriceFormatted: '1 WOW',
        creditPackages: [],
        cosmeticProducts: [],
        payoutOutcomes: {},
        modes: {
            solo: false,
            tavern: true,
            multiplayer: true,
            match: { enabled: true, economies: { free: true } }
        }
    };
}

async function runAccountVisibilityMatrix(page) {
    const initial = await page.evaluate(() => ({
        smirkSectionHidden: getComputedStyle(document.getElementById('smirkAccountSection')).display === 'none',
        payoutControlHidden: getComputedStyle(document.getElementById('manageAddressButton')).display === 'none'
    }));
    assert(initial.smirkSectionHidden && initial.payoutControlHidden,
        'Account or payout controls were visible before an explicit server game-mode snapshot');

    await page.evaluate(data => SocketHandlers.onGameModeInfo(data),
        accountGameModeInfo({ smirkEnabled: true, payoutsEnabled: false }));
    const connectButton = page.getByRole('button', { name: 'Connect Smirk', exact: true });
    try {
        await connectButton.waitFor({ state: 'visible', timeout: 1500 });
    } catch (error) {
        const state = await page.evaluate(() => ({
            explicitFlag: SocketHandlers._smirkEnabled,
            authInitialized: SmirkAuth._initialized,
            providerAvailable: SmirkAuth.isAvailable(),
            sectionDisplay: getComputedStyle(document.getElementById('smirkAccountSection')).display,
            containerPresent: !!document.getElementById('smirkButtonContainer'),
            buttonPresent: !!document.getElementById('smirkLoginBtn'),
            containerContents: document.getElementById('smirkButtonContainer')?.textContent || ''
        }));
        throw new Error(`Smirk account entry did not become visible (${JSON.stringify(state)}): ${error.message}`);
    }
    await page.locator('#tavernButton').waitFor({ state: 'visible' });
    const freeAccount = await page.evaluate(() => {
        const region = document.getElementById('smirkAccountSection');
        const button = document.getElementById('smirkLoginBtn');
        const bounds = button.getBoundingClientRect();
        return {
            regionLabel: region.getAttribute('aria-label'),
            tavernEnabled: getComputedStyle(document.getElementById('tavernButton')).display !== 'none',
            payoutsControlHidden: getComputedStyle(document.getElementById('manageAddressButton')).display === 'none',
            addressModalHidden: document.getElementById('addressModal').classList.contains('hidden'),
            buttonText: button.textContent.trim(),
            buttonWidth: bounds.width,
            buttonRight: bounds.right,
            viewportWidth: document.documentElement.clientWidth,
            documentWidth: document.documentElement.scrollWidth
        };
    });
    assert(freeAccount.regionLabel === 'Smirk account' && freeAccount.tavernEnabled
        && freeAccount.payoutsControlHidden && freeAccount.addressModalHidden,
    'Explicit Smirk access did not expose an accessible account entry while keeping payout controls closed');
    assert(freeAccount.buttonWidth > 0 && freeAccount.buttonRight <= freeAccount.viewportWidth
        && freeAccount.documentWidth <= freeAccount.viewportWidth,
    'Smirk account entry is not usable within the mobile viewport');
    await page.evaluate(() => {
        window.__smirkAccountClickCount = 0;
        SmirkAuth._handleClick = function () { window.__smirkAccountClickCount += 1; };
    });
    await connectButton.click();
    await page.waitForFunction(() => window.__smirkAccountClickCount === 1);
    await page.evaluate(() => {
        AddressModal.show();
        SocketHandlers.onAddressPrompt({});
    });
    assert(await page.locator('#addressModal').evaluate(node => node.classList.contains('hidden')),
        'A payout address prompt opened while payout modes were disabled');

    await page.evaluate(data => SocketHandlers.onGameModeInfo(data),
        accountGameModeInfo({ smirkEnabled: false, payoutsEnabled: false }));
    const defaultClosed = await page.evaluate(() => ({
        accountHidden: getComputedStyle(document.getElementById('smirkAccountSection')).display === 'none',
        payoutControlHidden: getComputedStyle(document.getElementById('manageAddressButton')).display === 'none'
    }));
    assert(defaultClosed.accountHidden && defaultClosed.payoutControlHidden,
        'The server-off baseline exposed Smirk or payout controls');

    await page.evaluate(data => SocketHandlers.onGameModeInfo(data),
        accountGameModeInfo({ smirkEnabled: false, payoutsEnabled: true }));
    const payoutAccess = await page.evaluate(() => ({
        accountHidden: getComputedStyle(document.getElementById('smirkAccountSection')).display === 'none',
        payoutControlVisible: getComputedStyle(document.getElementById('manageAddressButton')).display !== 'none'
    }));
    assert(payoutAccess.accountHidden && payoutAccess.payoutControlVisible,
        'A permitted payout mode did not expose address management independently of Smirk');
    await page.locator('#manageAddressButton').click();
    await page.locator('#addressModal').waitFor({ state: 'visible' });
    await page.evaluate(data => SocketHandlers.onGameModeInfo(data),
        accountGameModeInfo({ smirkEnabled: false, payoutsEnabled: false }));
    assert(await page.locator('#addressModal').evaluate(node => node.classList.contains('hidden')),
        'Payout address modal stayed open after the server disabled payout modes');

    return {
        explicitSmirkWithFreeTavern: freeAccount,
        serverOffBaseline: defaultClosed,
        permittedPayoutAddressManagement: payoutAccess,
        visibleSmirkButtonClickWired: true,
        unsolicitedPayoutPromptIgnored: true,
        payoutModalClosedWhenFeatureDisabled: true,
        syntheticSnapshotsOnly: true,
        provider: 'local Smirk stub; click handler intercepted before authentication'
    };
}

async function runTavernAccountLink(page, outputDir) {
    await page.goto(`${page.url().split('/').slice(0, 3).join('/')}/tavern`);
    const accountLink = page.locator('#smirkAccountLink');
    await accountLink.waitFor({ state: 'attached' });
    assert(await accountLink.evaluate(node => node.hidden),
        'The Tavern exposed its Smirk account link before an explicit enabled snapshot');
    await page.evaluate(data => window.__deliverSocketEvent('game_mode_info', data),
        accountGameModeInfo({ smirkEnabled: false, payoutsEnabled: false }));
    assert(await accountLink.evaluate(node => node.hidden),
        'The Tavern exposed its Smirk account link when the server flag was off');
    await page.evaluate(data => window.__deliverSocketEvent('game_mode_info', data),
        accountGameModeInfo({ smirkEnabled: true, payoutsEnabled: false }));
    await accountLink.waitFor({ state: 'visible' });
    const linkState = await page.evaluate(() => {
        const link = document.getElementById('smirkAccountLink');
        const bounds = link.getBoundingClientRect();
        const header = document.querySelector('.tavern-head').getBoundingClientRect();
        const title = document.querySelector('.tavern-head h1').getBoundingClientRect();
        const nav = link.parentElement.getBoundingClientRect();
        return {
            href: link.getAttribute('href'),
            viewportWidth: document.documentElement.clientWidth,
            documentWidth: document.documentElement.scrollWidth,
            linkRight: bounds.right,
            linkWidth: bounds.width,
            header: { left: header.left, right: header.right, width: header.width },
            title: { left: title.left, right: title.right, width: title.width },
            nav: { left: nav.left, right: nav.right, width: nav.width },
            controlsInsideHeader: header.left <= title.left && title.right <= header.right
                && header.left <= nav.left && nav.right <= header.right
        };
    });
    assert(linkState.href === '/#smirkAccountSection' && linkState.linkWidth > 0
        && linkState.linkRight <= linkState.viewportWidth
        && linkState.documentWidth <= linkState.viewportWidth
        && linkState.header.right <= linkState.viewportWidth && linkState.controlsInsideHeader,
    'The enabled Tavern account link is not usable within the mobile viewport');
    await page.getByRole('link', { name: 'Smirk account', exact: true }).focus();
    assert(await accountLink.evaluate(node => document.activeElement === node),
        'The enabled Tavern account link is not keyboard focusable');
    await page.screenshot({ path: path.join(outputDir, 'tavern-smirk-account-link.png'), fullPage: true });
    await accountLink.click();
    await page.waitForURL('**/#smirkAccountSection');
    await page.waitForFunction(() => document.readyState === 'complete'
        && typeof SocketHandlers !== 'undefined' && typeof SmirkAuth !== 'undefined');
    await page.evaluate(data => SocketHandlers.onGameModeInfo(data),
        accountGameModeInfo({ smirkEnabled: true, payoutsEnabled: false }));
    const destination = await page.evaluate(() => ({
        path: location.pathname,
        hash: location.hash,
        sectionFocusable: document.activeElement === document.getElementById('smirkAccountSection'),
        sectionVisible: getComputedStyle(document.getElementById('smirkAccountSection')).display !== 'none',
        payoutControlHidden: getComputedStyle(document.getElementById('manageAddressButton')).display === 'none'
    }));
    assert(destination.path === '/' && destination.hash === '#smirkAccountSection'
        && destination.sectionFocusable && destination.sectionVisible && destination.payoutControlHidden,
    'The Tavern account link did not land at the enabled, payout-free lobby account section');
    await page.screenshot({ path: path.join(outputDir, 'lobby-smirk-account-entry.png'), fullPage: true });
    const connectButton = page.getByRole('button', { name: 'Connect Smirk', exact: true });
    await connectButton.waitFor({ state: 'visible' });
    await page.evaluate(() => {
        window.__smirkAccountClickCount = 0;
        SmirkAuth._handleClick = function () { window.__smirkAccountClickCount += 1; };
    });
    await connectButton.click();
    await page.waitForFunction(() => window.__smirkAccountClickCount === 1);
    return {
        mobileTavernLink: linkState,
        keyboardFocusable: true,
        lobbyDestination: destination,
        visibleButtonClickWired: true,
        screenshots: {
            tavern: 'tavern-smirk-account-link.png',
            lobby: 'lobby-smirk-account-entry.png'
        }
    };
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
        entitlementProvider: entitlementsForSocket,
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
    app.get('/api/game-modes', (_req, res) => res.json({ hostedBy: null }));
    app.get('/api/disclosures', (_req, res) => res.json({
        policyVersion: 'local-browser-fixture-v1',
        service: { anyPayoutsEnabled: false }
    }));
    app.get('/api/stats', (_req, res) => res.json({ gamesToday: 0, escapesToday: 0, payoutsEnabled: false }));
    app.get('/api/auth/smirk/status', (_req, res) => res.json({ linked: false, hasPayoutAddress: false }));
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
            entitlements: entitlementsForSocket(socket)
        }));
        socket.on('identity:update', data => socket.emit('identity_update', {
            appearance: data?.appearance || { avatar: 'default' },
            entitlements: entitlementsForSocket(socket)
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

        const accountContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
        accountContext.on('requestfailed', request => {
            const url = new URL(request.url());
            if (!isLoopback(url.hostname) || Number(url.port || 80) !== address.port) {
                blockedExternal.push(url.origin);
            }
        });
        await accountContext.route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
            if (url.protocol === 'http:' && isLoopback(url.hostname) && Number(url.port || 80) === address.port) {
                return route.continue();
            }
            blockedExternal.push(url.origin);
            return route.abort('blockedbyclient');
        });
        const accountPage = await accountContext.newPage();
        await accountPage.addInitScript(() => {
            window.smirk = {
                async connect() { return { wow: {} }; },
                async getPublicKeys() { return {}; },
                async getAddresses() { return {}; }
            };
        });
        await accountPage.route('**/socket.io/socket.io.js', route => route.fulfill({
            status: 200,
            contentType: 'application/javascript',
            body: `window.io = function () {\n` +
                `  var listeners = {};\n` +
                `  var client = { id: 'smirk-account-browser-fixture', connected: true,\n` +
                `    on: function (name, fn) { (listeners[name] || (listeners[name] = [])).push(fn); },\n` +
                `    emit: function () {}\n` +
                `  };\n` +
                `  window.__deliverSocketEvent = function (name, data) { (listeners[name] || []).forEach(function (fn) { fn(data); }); };\n` +
                `  window.socket = client;\n` +
                `  return client;\n` +
                `};`
        }));
        accountPage.on('pageerror', error => browserFailures.push(error.message));
        accountPage.on('console', message => {
            if (message.type() === 'error') browserFailures.push(message.text());
        });
        accountPage.on('response', response => {
            if (response.status() >= 400) {
                observedHttpFailures.push({ path: new URL(response.url()).pathname, status: response.status() });
            }
        });
        await accountPage.goto(`${origin}/`);
        await accountPage.waitForFunction(() => document.readyState === 'complete'
            && typeof SocketHandlers !== 'undefined' && typeof SmirkAuth !== 'undefined'
            && typeof InputHandler !== 'undefined' && window.socket?.connected);
        await accountPage.waitForTimeout(250);
        const accountUi = await runAccountVisibilityMatrix(accountPage);
        const tavernAccountLink = await runTavernAccountLink(accountPage, outputDir);

        for (const { page } of Object.values(views)) {
            await page.locator('#joinBtn').waitFor({ state: 'visible' });
            await page.waitForFunction(() => document.getElementById('joinBtn') && !document.getElementById('joinBtn').disabled);
            await page.waitForFunction(() => window.RK && window.RK.entitlements
                && Object.prototype.hasOwnProperty.call(window.RK.entitlements.packs, 'roguelike-interior'));
        }
        const packPolicy = {};
        for (const role of ['mica', 'moth']) {
            packPolicy[role] = await views[role].page.evaluate(() => {
                const ids = ['original', 'roguelike-interior', 'generated-skins', 'iso-dungeon',
                    'roguelike-dungeon', 'iso-medieval', 'kenney-3d-characters'];
                const appearance = RK.avatarVisuals.resolve({ avatar: 'default' }, { projection: 'topdown' });
                return {
                    canUse: Object.fromEntries(ids.map(id => [id, RK.canUsePack(id)])),
                    resolvedDefaultPack: appearance.pack,
                    resolvedDefaultAllowed: appearance.allowed,
                    activeTopdownPack: RK.activePackId('topdown'),
                    credits: RK.entitlements.credits,
                    totalCreditsPurchased: RK.entitlements.totalCreditsPurchased
                };
            });
        }
        assert(packPolicy.moth.canUse.original && !packPolicy.moth.canUse['roguelike-interior']
            && !packPolicy.moth.canUse['generated-skins'] && !packPolicy.moth.canUse['iso-dungeon']
            && !packPolicy.moth.canUse['roguelike-dungeon'] && !packPolicy.moth.canUse['iso-medieval']
            && !packPolicy.moth.canUse['kenney-3d-characters'], 'Moth did not retain original-only zero-grant policy');
        assert(packPolicy.moth.resolvedDefaultPack === 'roguelike-interior'
            && !packPolicy.moth.resolvedDefaultAllowed && packPolicy.moth.activeTopdownPack === 'original'
            && packPolicy.moth.credits === 0 && packPolicy.moth.totalCreditsPurchased === 0,
        'Moth default character or active tileset bypassed the real pack policy');
        assert(packPolicy.mica.canUse.original && packPolicy.mica.canUse['roguelike-interior']
            && packPolicy.mica.canUse['iso-dungeon'] && !packPolicy.mica.canUse['generated-skins']
            && !packPolicy.mica.canUse['roguelike-dungeon'] && !packPolicy.mica.canUse['iso-medieval']
            && !packPolicy.mica.canUse['kenney-3d-characters'], 'Mica fixture did not match its two explicit pack grants');
        assert(packPolicy.mica.resolvedDefaultPack === 'roguelike-interior'
            && packPolicy.mica.resolvedDefaultAllowed && packPolicy.mica.credits === 0
            && packPolicy.mica.totalCreditsPurchased === 0,
        'Mica synthetic character grant changed the no-funds balance or failed to permit the asset');
        for (const { page } of Object.values(views)) {
            await page.evaluate(() => {
                const original = RK.drawCharTileCanvas;
                window.__showcaseCharTileDraws = 0;
                RK.drawCharTileCanvas = function () {
                    window.__showcaseCharTileDraws += 1;
                    return original.apply(this, arguments);
                };
            });
        }
        await views.mica.page.locator('#name').fill('Mica');
        await views.mica.page.locator('#joinBtn').click();
        await views.moth.page.locator('#name').fill('Moth');
        await views.moth.page.locator('#joinBtn').click();
        await Promise.all(Object.values(views).map(({ page }) => page.locator('#stage canvas.rk-canvas').waitFor({ state: 'visible' })));
        await views.mica.page.waitForFunction(() => RK.charAtlas() && window.__showcaseCharTileDraws > 0,
            undefined, { timeout: 5000 });
        const characterRenderProof = {};
        for (const role of ['mica', 'moth']) {
            characterRenderProof[role] = await views[role].page.evaluate(() => ({
                atlasReady: !!RK.charAtlas(),
                drawCalls: window.__showcaseCharTileDraws,
                defaultAllowed: RK.avatarVisuals.resolve({ avatar: 'default' }, { projection: 'topdown' }).allowed
            }));
        }
        assert(characterRenderProof.mica.atlasReady && characterRenderProof.mica.drawCalls > 0
            && characterRenderProof.mica.defaultAllowed, 'Permitted synthetic Interior character was not actually drawn');
        assert(characterRenderProof.moth.drawCalls === 0 && !characterRenderProof.moth.defaultAllowed,
            'Original-only free client unexpectedly drew a gated character');
        await views.mica.page.screenshot({
            path: path.join(outputDir, 'tavern-synthetic-interior-character.png'), fullPage: true
        });
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

        const layoutScene = {
            visibleTiles: Array.from({ length: 12 }, () => Array(12).fill("'1")),
            exploredTiles: Array.from({ length: 12 }, () => Array(12).fill("'1")),
            players: [{ id: ids.mica, name: 'Layout fixture', x: 5, y: 5, appearance: { avatar: 'default' } }],
            entrance: [0, 0], exit: [11, 11], monster: null, items: {}, isSpectating: true
        };
        const desktopPage = views.mica.page;
        await desktopPage.setViewportSize({ width: 1280, height: 900 });
        await desktopPage.locator('#chatInput').focus();
        io.to(ids.mica).emit('spectate_start', { playerId: 'layout fixture', initialState: layoutScene });
        await desktopPage.locator('#spectatorStage').waitFor({ state: 'visible' });
        await desktopPage.waitForFunction(() => document.activeElement === document.getElementById('spectatorStage'));
        await desktopPage.keyboard.press('Enter');
        await desktopPage.keyboard.press('Space');
        assert(await desktopPage.locator('#spectatorStage').isVisible(),
            'Enter or Space activated a control when the active arena received focus');
        const desktopArena = await desktopPage.evaluate(() => {
            const arena = document.getElementById('spectatorStage').getBoundingClientRect();
            const chat = document.getElementById('chatPanel').getBoundingClientRect();
            return {
                arenaTop: arena.top, arenaBottom: arena.bottom, arenaHeight: arena.height,
                chatTop: chat.top, viewportHeight: document.documentElement.clientHeight,
                orderedBeforeChat: !!(document.getElementById('spectatorStage').compareDocumentPosition(
                    document.getElementById('chatPanel')) & Node.DOCUMENT_POSITION_FOLLOWING)
            };
        });
        assert(desktopArena.orderedBeforeChat && desktopArena.arenaBottom <= desktopArena.chatTop,
            'Active arena does not precede chat in reading and viewport order');
        assert(desktopArena.arenaHeight >= 300 && desktopArena.arenaTop < desktopArena.viewportHeight,
            'Desktop active arena is not meaningfully visible in the initial viewport');
        await desktopPage.locator('#leaveSpectateBtn').click();
        await desktopPage.waitForFunction(() => document.activeElement === document.getElementById('chatInput'));

        const mobilePage = views.moth.page;
        await mobilePage.locator('#tavernDpad [data-dir="up"]').focus();
        io.to(ids.moth).emit('spectate_start', { playerId: 'layout fixture', initialState: layoutScene });
        await mobilePage.locator('#spectatorStage').waitFor({ state: 'visible' });
        await mobilePage.waitForFunction(() => document.activeElement === document.getElementById('spectatorStage'));
        const mobileArena = await mobilePage.evaluate(() => {
            const arena = document.getElementById('spectatorStage').getBoundingClientRect();
            const chat = document.getElementById('chatPanel').getBoundingClientRect();
            return {
                viewport: document.documentElement.clientWidth,
                document: document.documentElement.scrollWidth,
                arenaTop: arena.top, arenaBottom: arena.bottom, arenaHeight: arena.height,
                chatTop: chat.top,
                orderedBeforeChat: !!(document.getElementById('spectatorStage').compareDocumentPosition(
                    document.getElementById('chatPanel')) & Node.DOCUMENT_POSITION_FOLLOWING)
            };
        });
        assert(mobileArena.orderedBeforeChat && mobileArena.arenaBottom <= mobileArena.chatTop,
            'Mobile active arena does not precede chat in reading and viewport order');
        assert(mobileArena.document <= mobileArena.viewport && mobileArena.arenaHeight >= 300
            && mobileArena.arenaTop < 844, 'Mobile active arena overflows or falls below the initial viewport');
        await mobilePage.locator('#leaveSpectateBtn').click();
        await mobilePage.waitForFunction(() => document.activeElement === document.querySelector('#tavernDpad [data-dir="up"]'));

        const unexpectedHttpFailures = observedHttpFailures.filter(f => !(f.status === 404 && f.path === expectedMissingSkin));
        assert(observedHttpFailures.some(f => f.status === 404 && f.path === expectedMissingSkin), 'Expected missing generated skin was not requested');
        assert(unexpectedHttpFailures.length === 0, `Unexpected HTTP failures: ${JSON.stringify(unexpectedHttpFailures)}`);
        assert(blockedExternal.length === 0, `Browser attempted external network access: ${blockedExternal.join(', ')}`);
        assert(browserFailures.length === 0, `Browser errors: ${browserFailures.join(' | ')}`);

        const screenshotPaths = {};
        for (const role of ['mica', 'moth']) {
            const filename = role === 'moth'
                ? 'tavern-mobile-free-original-baseline.png'
                : `tavern-mobile-${role}.png`;
            await views[role].page.screenshot({ path: path.join(outputDir, filename), fullPage: true });
            screenshotPaths[role] = filename;
        }
        const result = {
            ok: true,
            scope: 'local Tavern lifecycle/graphics smoke plus a client-only account visibility matrix; no paid gameplay, queue/race transitions, database, or live wallet',
            origin: '127.0.0.1 loopback only',
            fixture: 'Mica receives synthetic roguelike-interior and iso-dungeon grants; Moth receives the authoritative zero-grant, original-only snapshot; both have zero balances and no purchase, skin or 3D grant',
            clients: { count: clientsByRole.size, mappedByPageOwnedSocketId: true },
            packPolicy,
            characterRenderProof,
            modes: modeResults,
            chat: 'broadcast to both clients',
            keyboardFocusGuards: ['input', 'select', 'contenteditable'],
            mobile,
            activeArena: { desktop: desktopArena, mobile: mobileArena, arenaReceivesSafeInitialFocus: true, tavernFocusRestored: true },
            missingGeneratedSkin: skinFailure,
            accountUi,
            tavernAccountLink,
            screenshots: {
                syntheticInteriorCharacter: 'tavern-synthetic-interior-character.png',
                freeOriginalBaseline: screenshotPaths.moth,
                desktopIso: 'tavern-desktop-iso.png', mobile: screenshotPaths,
                smirkAccount: tavernAccountLink.screenshots
            },
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
