const { createAdapter, paymentRequest } = require('../html/js/network/smirkPaymentAdapter');

const NOW = 1800000000000;
function invoice(extra = {}) {
    return {
        paymentId: 31, ownerUserId: 7, asset: 'wow', network: 'mainnet',
        amount: '123456789012', humanAmount: '1.23456789012',
        address: 'Wo' + '1'.repeat(95), expiresAt: new Date(NOW + 60000).toISOString(),
        paymentType: 'credits_package', memo: 'Buy 10 credits', package: { credits: 10 }, ...extra
    };
}
function setup(extra = {}) {
    const values = new Map();
    const storage = {
        getItem: key => values.get(key) || null,
        setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key)
    };
    let tail = Promise.resolve();
    const withLock = (_name, work) => {
        const result = tail.then(work);
        tail = result.catch(() => {});
        return result;
    };
    const options = { storage, withLock, crypto: require('crypto').webcrypto, now: () => NOW, ...extra };
    return { adapter: createAdapter(options), options, values };
}

describe('Smirk WOW invoice contract', () => {
    test('uses exact server decimal and memo without inventing wallet parameters', () => {
        expect(paymentRequest(invoice(), NOW)).toEqual({
            asset: 'wow', amount: '1.23456789012', address: invoice().address, memo: 'Buy 10 credits'
        });
    });

    test('accepts a WOW RPC subaddress as well as a standard address', () => {
        const address = 'WW3UyJFX6GPKdM21APyVYjGhfX3ebyHvPPgtFC3wHxkYTCGg8k2UM9DLTCzcgoaLHSKnvJKRtCPgJ1sxvgYiFCoK19vLk83Jn';
        expect(paymentRequest(invoice({ address }), NOW).address).toBe(address);
    });

    test('restored invoices keep the persisted memo without package display metadata', () => {
        expect(paymentRequest(invoice({ package: undefined, restored: true }), NOW).memo).toBe('Buy 10 credits');
    });

    test.each([
        { humanAmount: undefined, amountFormatted: undefined },
        { humanAmount: '0' }, { humanAmount: '-1' }, { humanAmount: '1e-3' },
        { humanAmount: '1.000000000001' }, { humanAmount: 1 },
        { humanAmount: '1.23' }, { amount: '1.2' },
        { asset: 'xmr' }, { asset: undefined }, { network: 'stagenet' }, { network: undefined },
        { paymentId: undefined }, { ownerUserId: undefined }, { address: 'not-a-wow-address' }, { memo: undefined },
        { expiresAt: undefined }, { expiresAt: new Date(NOW).toISOString() }
    ])('refuses invalid or mismatched invoice before wallet invocation: %j', async extra => {
        const { adapter } = setup();
        const wallet = { requestPayment: jest.fn() };
        await expect(adapter.pay(invoice(extra), wallet)).rejects.toThrow();
        expect(wallet.requestPayment).not.toHaveBeenCalled();
    });
});

describe('Smirk submission evidence and repeat protection', () => {
    test.each([
        [{ success: true, txid: 'a'.repeat(64) }, 'submitted'],
        [{ success: true }, 'unknown'],
        [{ success: false }, 'failed'],
        [{ success: false, txid: 'a'.repeat(64) }, 'unknown'],
        [undefined, 'unknown'], [true, 'unknown'], [{ txid: 'a'.repeat(64) }, 'unknown'],
        [{ success: true, txid: 'malformed' }, 'unknown']
    ])('classifies wallet result %j as %s without confirming credits', async (result, state) => {
        const { adapter } = setup();
        const wallet = { requestPayment: jest.fn().mockResolvedValue(result) };
        expect(await adapter.pay(invoice(), wallet)).toMatchObject({ state });
        expect(wallet.requestPayment).toHaveBeenCalledTimes(1);
        expect(await adapter.pay(invoice(), wallet)).toMatchObject({ state, repeated: true });
        expect(wallet.requestPayment).toHaveBeenCalledTimes(1);
    });

    test.each([['USER_REJECTED', 'cancelled'], ['NOT_AUTHORIZED', 'unavailable'], ['TIMEOUT', 'unknown']])(
        'classifies %s and never automatically retries', async (code, state) => {
            const { adapter } = setup();
            const wallet = { requestPayment: jest.fn().mockRejectedValue(Object.assign(new Error('fixture'), { code })) };
            expect(await adapter.pay(invoice(), wallet)).toMatchObject({ state });
            await adapter.pay(invoice(), wallet);
            expect(wallet.requestPayment).toHaveBeenCalledTimes(1);
        }
    );

    test('coordinates concurrent events, two tabs and a page reload for the same invoice', async () => {
        const { adapter, options } = setup();
        const secondTab = createAdapter(options);
        const wallet = { requestPayment: jest.fn().mockResolvedValue({ success: true }) };
        await Promise.all([adapter.pay(invoice(), wallet), secondTab.pay(invoice(), wallet)]);
        const reloaded = createAdapter(options);
        expect(await reloaded.pay(invoice({ reused: true }), wallet)).toMatchObject({ state: 'unknown', repeated: true });
        expect(wallet.requestPayment).toHaveBeenCalledTimes(1);
    });

    test('records intent before invoking a wallet and retains unknown after interruption', async () => {
        const { adapter, options } = setup();
        const wallet = { requestPayment: jest.fn(async () => {
            expect(createAdapter(options).status(invoice()).state).toBe('unknown');
            throw new Error('Transport closed after possible submission');
        }) };
        expect(await adapter.pay(invoice(), wallet)).toMatchObject({ state: 'unknown' });
        expect(createAdapter(options).status(invoice())).toMatchObject({ state: 'unknown' });
    });

    test.each([
        { ownerUserId: 8 }, { memo: 'different purchase' },
        { humanAmount: '2', amount: '200000000000' },
        { expiresAt: new Date(NOW + 120000).toISOString() }
    ])('refuses changed immutable invoice fields after an attempt: %j', async extra => {
        const { adapter } = setup();
        const wallet = { requestPayment: jest.fn().mockResolvedValue({ success: true }) };
        await adapter.pay(invoice(), wallet);
        await expect(adapter.pay(invoice(extra), wallet)).rejects.toThrow(/changed/i);
        expect(wallet.requestPayment).toHaveBeenCalledTimes(1);
    });

    test('rechecks session admission inside the cross-tab lock before writing intent', async () => {
        const { adapter } = setup();
        const wallet = { requestPayment: jest.fn() };
        await expect(adapter.pay(invoice(), wallet, () => { throw new Error('Account changed'); })).rejects.toThrow('Account changed');
        expect(wallet.requestPayment).not.toHaveBeenCalled();
        expect(adapter.status(invoice())).toBeNull();
    });

    test.each([
        { withLock: null },
        { storage: null },
        { storage: { getItem() { throw new Error('blocked'); }, setItem() {} } }
    ])('refuses unsafe repeat protection before requesting funds', async options => {
        const { adapter } = setup(options);
        const wallet = { requestPayment: jest.fn() };
        await expect(adapter.pay(invoice(), wallet)).rejects.toThrow();
        expect(wallet.requestPayment).not.toHaveBeenCalled();
    });
});
