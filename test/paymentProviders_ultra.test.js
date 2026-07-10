/**
 * Modular payment-provider system (Pillar 3, reframed around BTCPay).
 */
const { PaymentProviderRegistry } = require('../src/payments/providers/paymentProvider');
const BTCPayProvider = require('../src/payments/providers/btcpayProvider');
const NativeMoneroProvider = require('../src/payments/providers/nativeMoneroProvider');

function recordingFetch(routes) {
    const calls = [];
    const fn = async (url, opts) => {
        const method = (opts && opts.method) || 'GET';
        let body = null;
        try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch (_) {}
        calls.push({ url, method, body });
        for (const r of routes) {
            if (r.method === method && r.match.test(url)) {
                return { ok: r.ok !== false, status: r.status || 200, text: async () => JSON.stringify(r.body) };
            }
        }
        return { ok: false, status: 404, text: async () => '{}' };
    };
    fn.calls = calls;
    return fn;
}

describe('PaymentProviderRegistry routing', () => {
    const btc = new BTCPayProvider({ baseUrl: 'x', storeId: 's', apiKey: 'k', chains: ['BTC', 'LTC', 'GRIN'], fetchImpl: async () => ({}) });
    const native = new NativeMoneroProvider({ walletService: {}, chains: ['XMR', 'WOW'] });

    test('routes each chain to its configured provider', () => {
        const reg = new PaymentProviderRegistry().register(btc).register(native)
            .setRouting({ BTC: 'btcpay', LTC: 'btcpay', GRIN: 'btcpay', XMR: 'native-monero', WOW: 'native-monero' });
        expect(reg.getProvider('BTC').id).toBe('btcpay');
        expect(reg.getProvider('GRIN').id).toBe('btcpay');
        expect(reg.getProvider('WOW').id).toBe('native-monero');
    });

    test('a chain routed to a provider that cannot serve it falls back to one that can', () => {
        const reg = new PaymentProviderRegistry().register(btc).register(native).setRouting({ XMR: 'btcpay' });
        expect(reg.getProvider('XMR').id).toBe('native-monero'); // btcpay(chains) excludes XMR here
    });
});

describe('BTCPayProvider (Greenfield)', () => {
    test('creates an invoice priced in the chain and reads the address from payment-methods', async () => {
        const fetchImpl = recordingFetch([
            { method: 'POST', match: /\/stores\/store1\/invoices$/, body: { id: 'inv1', checkoutLink: 'https://pay/inv1', expirationTime: 1700 } },
            { method: 'GET', match: /\/invoices\/inv1\/payment-methods$/, body: [{ paymentMethod: 'BTC', destination: 'bc1qaddr', paymentLink: 'bitcoin:bc1qaddr' }] }
        ]);
        const p = new BTCPayProvider({ baseUrl: 'https://btcpay.lan/', storeId: 'store1', apiKey: 'KEY', fetchImpl });
        const inv = await p.createInvoice({ chain: 'BTC', amountAtomic: 100000000n, description: 'entry', orderId: 'o1' });

        expect(inv.invoiceId).toBe('inv1');
        expect(inv.address).toBe('bc1qaddr');
        const post = fetchImpl.calls.find(c => c.method === 'POST');
        expect(post.url).toBe('https://btcpay.lan/api/v1/stores/store1/invoices');
        expect(post.body.currency).toBe('BTC');
        expect(post.body.amount).toBe('1'); // 1e8 atomic / 1e8 = 1 BTC
    });

    test('maps invoice status to the contract', async () => {
        const mk = (status) => new BTCPayProvider({
            baseUrl: 'x', storeId: 's', apiKey: 'k',
            fetchImpl: recordingFetch([{ method: 'GET', match: /\/invoices\/inv1$/, body: { id: 'inv1', status } }])
        });
        expect((await mk('Settled').getInvoiceStatus('inv1')).complete).toBe(true);
        expect((await mk('New').getInvoiceStatus('inv1')).status).toBe('pending');
        expect((await mk('Expired').getInvoiceStatus('inv1')).status).toBe('expired');
    });

    test('errors clearly when unconfigured', async () => {
        const p = new BTCPayProvider({ fetchImpl: async () => ({}) });
        await expect(p.getInvoiceStatus('x')).rejects.toThrow(/not configured/);
    });

    describe('getWalletStatus (raw shape the confirmation callback consumes)', () => {
        const mk = (invStatus, methods, chains) => new BTCPayProvider({
            baseUrl: 'x', storeId: 's', apiKey: 'k', chains,
            fetchImpl: recordingFetch([
                { method: 'GET', match: /\/invoices\/inv1$/, body: { id: 'inv1', status: invStatus } },
                { method: 'GET', match: /\/invoices\/inv1\/payment-methods$/, body: methods }
            ])
        });

        test('Settled -> confirmed+complete with paid/required in atomic units (XMR, 12 decimals)', async () => {
            const st = await mk('Settled', [{ cryptoCode: 'XMR', destination: 'a', totalPaid: '1.5', amount: '1.5' }], ['XMR']).getWalletStatus('inv1');
            expect(st.confirmed).toBe(true);
            expect(st.complete).toBe(true);
            expect(st.in_mempool).toBe(false);
            expect(st.amount).toBe(1500000000000);   // 1.5 * 1e12
            expect(st.required).toBe(1500000000000);
        });

        test('WOW uses 11 decimals', async () => {
            const st = await mk('Settled', [{ cryptoCode: 'WOW', totalPaid: '1.5', amount: '1.5' }], ['WOW']).getWalletStatus('inv1');
            expect(st.amount).toBe(150000000000); // 1.5 * 1e11
        });

        test('Processing -> in_mempool, not confirmed', async () => {
            const st = await mk('Processing', [{ cryptoCode: 'XMR', totalPaid: '0.5', amount: '1.5' }], ['XMR']).getWalletStatus('inv1');
            expect(st.in_mempool).toBe(true);
            expect(st.confirmed).toBe(false);
            expect(st.complete).toBe(false);
            expect(st.amount).toBe(500000000000);
        });

        test('New -> pending, no amount', async () => {
            const st = await mk('New', [], ['XMR']).getWalletStatus('inv1');
            expect(st.confirmed).toBe(false);
            expect(st.in_mempool).toBe(false);
            expect(st.amount).toBe(0);
        });

        test('Expired -> terminal flag so the watcher stops', async () => {
            const st = await mk('Expired', [], ['XMR']).getWalletStatus('inv1');
            expect(st._terminal).toBe(true);
            expect(st.complete).toBe(false);
        });
    });
});

describe('NativeMoneroProvider wraps walletRPCService', () => {
    const wallet = {
        createPaymentRequest: jest.fn(async () => ({ address: 'Wo3xaddr' })),
        checkPaymentStatus: jest.fn(async () => ({ confirmed: true, complete: true, amount: 100000000000, confirmations: 3 })),
        processBatchPayout: jest.fn(async () => ({ tx_hash_list: ['tx1'] }))
    };

    test('supports only XMR/WOW; delegates invoice + status + payout', async () => {
        const np = new NativeMoneroProvider({ walletService: wallet });
        expect(np.supportsChain('WOW')).toBe(true);
        expect(np.supportsChain('BTC')).toBe(false);

        const inv = await np.createInvoice({ chain: 'WOW', amountAtomic: '100000000000', userId: 1 });
        expect(inv.address).toBe('Wo3xaddr');

        const st = await np.getInvoiceStatus('Wo3xaddr');
        expect(st.status).toBe('paid');
        expect(st.complete).toBe(true);

        const po = await np.sendPayout({ chain: 'WOW', address: 'Wo3ydest', amountAtomic: '50000000000' });
        expect(po.txids).toEqual(['tx1']);
        expect(wallet.processBatchPayout).toHaveBeenCalledWith([{ address: 'Wo3ydest', amount: '50000000000' }]);
    });

    test('startWatch passes the RAW wallet status through untouched (native path preserved)', () => {
        let captured;
        const w = { startPaymentMonitoring: jest.fn((addr, cb) => { captured = cb; }) };
        const np = new NativeMoneroProvider({ walletService: w });
        const seen = [];
        np.startWatch('Wo3xaddr', (s) => seen.push(s), 2000);
        expect(w.startPaymentMonitoring).toHaveBeenCalledWith('Wo3xaddr', expect.any(Function), 2000);
        const raw = { in_mempool: true, confirmed: false, complete: false, amount: 42, required: 100, confirmations: 0 };
        captured(raw);
        expect(seen[0]).toBe(raw); // same object, not normalized — callback sees exactly what the wallet emitted
    });
});
