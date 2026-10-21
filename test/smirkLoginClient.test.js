const fs = require('fs');
const vm = require('vm');

function loadAuth(wallet) {
    const context = {
        window: { smirk: wallet, socket: { id: 'fixture-socket', on() {}, emit: jest.fn() }, location: { origin: 'https://game.test' } },
        localStorage: { getItem: () => 'fixture-session' },
        document: {}, URL, console: { log() {}, warn() {}, error() {} }, setTimeout() {},
        $: () => ({ ready() {}, prop() { return this; }, css() { return this; }, text() { return this; }, remove() {} }),
        SocketHandlers: { _smirkEnabled: true },
        fetch: jest.fn(async path => ({
            ok: true,
            json: async () => path.endsWith('challenge') ? { challenge: 'game-fixture-challenge' } : { linked: true }
        }))
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(require.resolve('../html/js/network/smirkAuth'), 'utf8') + '\nthis.auth = SmirkAuth;', context);
    return context;
}
function walletFixture() {
    return {
        connect: jest.fn().mockResolvedValue({ wow: 'fixture-wow-key' }),
        signNostrEvent: jest.fn().mockResolvedValue({ pubkey: 'fixture-nostr-key' }),
        getNostrPublicKey: jest.fn().mockResolvedValue('fixture-nostr-key'),
        getAddresses: jest.fn().mockResolvedValue({ wow: 'fixture-wow-address' }),
        getPublicKeys: jest.fn().mockResolvedValue({ wow: 'fixture-wow-key' }),
        signMessage: jest.fn().mockResolvedValue({ signatures: [{ asset: 'wow', publicKey: 'legacy-key', signature: 'fixture-proof' }] })
    };
}

describe('Smirk client identity and WOW grant boundaries', () => {
    test('keeps Nostr identity while explicitly acquiring only WOW asset scope', async () => {
        const wallet = walletFixture();
        const { auth } = loadAuth(wallet);
        await auth.login();
        expect(wallet.connect).toHaveBeenCalledWith(['wow']);
        expect(wallet.signNostrEvent).toHaveBeenCalledTimes(1);
        expect(wallet.signMessage).not.toHaveBeenCalled();
    });

    test('does not switch account credential method after Nostr transport failure', async () => {
        const wallet = walletFixture();
        wallet.signNostrEvent.mockRejectedValue(Object.assign(new Error('transport interrupted'), { code: 'TIMEOUT' }));
        const { auth } = loadAuth(wallet);
        await expect(auth.login()).rejects.toThrow('transport interrupted');
        expect(wallet.signMessage).not.toHaveBeenCalled();
    });

    test('WOW scope denial stops the flow without another signature popup', async () => {
        const wallet = walletFixture();
        wallet.connect.mockRejectedValue(Object.assign(new Error('denied'), { code: 'USER_REJECTED' }));
        const { auth } = loadAuth(wallet);
        await expect(auth.login()).rejects.toMatchObject({ code: 'USER_REJECTED' });
        expect(wallet.signNostrEvent).not.toHaveBeenCalled();
        expect(wallet.signMessage).not.toHaveBeenCalled();
    });

    test('a declined Nostr grant does not retry signing or switch credentials', async () => {
        const wallet = walletFixture();
        wallet.signNostrEvent.mockRejectedValue(Object.assign(new Error('scope required'), { code: 'NOT_AUTHORIZED' }));
        wallet.getNostrPublicKey.mockResolvedValue(null);
        const { auth } = loadAuth(wallet);
        await expect(auth.login()).rejects.toThrow();
        expect(wallet.signNostrEvent).toHaveBeenCalledTimes(1);
        expect(wallet.signMessage).not.toHaveBeenCalled();
    });

    test('legacy-only wallets still prove the same credential with an explicit WOW grant', async () => {
        const wallet = walletFixture();
        delete wallet.signNostrEvent;
        delete wallet.getNostrPublicKey;
        const { auth } = loadAuth(wallet);
        await auth.login();
        expect(wallet.connect).toHaveBeenCalledTimes(1);
        expect(wallet.connect).toHaveBeenCalledWith(['wow']);
        expect(wallet.signMessage).toHaveBeenCalledTimes(1);
    });

    test('backend account linkage does not imply a WOW grant and never prompts on status check', async () => {
        const wallet = walletFixture();
        wallet.getPublicKeys.mockResolvedValue({ wow: null });
        const { auth } = loadAuth(wallet);
        await auth.checkStatus();
        expect(auth._isLinked).toBe(true);
        expect(auth._wowReady).toBe(false);
        expect(wallet.connect).not.toHaveBeenCalled();
        await auth.requestWowAccess();
        expect(auth._wowReady).toBe(true);
        expect(wallet.signNostrEvent).not.toHaveBeenCalled();
    });

    test.each(['forbidden', 'offline'])('failed status lookup clears stale account and scope: %s', async failure => {
        const context = loadAuth(walletFixture());
        context.auth._isLinked = true;
        context.auth._wowReady = true;
        context.fetch.mockImplementation(async () => {
            if (failure === 'offline') throw new Error('offline fixture');
            return { ok: false };
        });
        await context.auth.checkStatus();
        expect(context.auth._isLinked).toBe(false);
        expect(context.auth._wowReady).toBe(false);
    });

    test('a prior account status response cannot relink the current session', async () => {
        const context = loadAuth(walletFixture());
        let finish;
        context.fetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        const pending = context.auth.checkStatus();
        context.SocketHandlers._paymentSessionEpoch = 2;
        finish({ ok: true, json: async () => ({ linked: true }) });
        await pending;
        expect(context.auth._isLinked).toBe(false);
        expect(context.auth._wowReady).toBe(false);
    });
});
