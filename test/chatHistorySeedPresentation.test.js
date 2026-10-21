const ChatHistoryManager = require('../src/network/chatHistoryManager');

const seededTip = 'Escape the dungeon to win. Collect treasure for bonus payout!';
const seededRow = Object.freeze({
    id: 1, socket_id: 'system', username: 'SERVER', player_id: 'SERVER',
    message_type: 'system', message: seededTip, created_at: new Date()
});
const userRow = Object.freeze({
    ...seededRow, id: 2, socket_id: 'real-player-socket', username: 'Player',
    player_id: 'Player', message_type: 'chat'
});

function manager({ payoutsAvailable, db }) {
    const gameModeManager = {
        paymentsEnabled: true,
        directModeEnabled: true,
        creditsModeEnabled: false,
        isPayoutEnabledForMode: () => payoutsAvailable
    };
    return new ChatHistoryManager({ db, gameModeManager });
}

describe('historical system chat tip presentation', () => {
    test('the read path corrects only the seeded system tip when paid solo payouts are unavailable', async () => {
        const rows = [seededRow, userRow];
        const db = { query: jest.fn().mockResolvedValue({ rows }) };
        const history = manager({ payoutsAvailable: false, db });

        const messages = await history.getRecentMessages();

        expect(messages[0].message).not.toMatch(/bonus payout/i);
        expect(messages[0].message).toMatch(/score/i);
        expect(messages[1].message).toBe(seededTip);
        expect(rows[0].message).toBe(seededTip);
        expect(db.query).toHaveBeenCalledTimes(1);
        expect(db.query.mock.calls[0][0]).toMatch(/SELECT/);
    });

    test('cache fallback makes the same correction without changing cached bytes', async () => {
        const db = { query: jest.fn()
            .mockResolvedValueOnce({ rows: [userRow, seededRow] })
            .mockRejectedValueOnce(new Error('disposable database unavailable')) };
        const history = manager({ payoutsAvailable: false, db });
        const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await history._refreshCache();
            history._cacheInitialized = true;
            const messages = await history.getRecentMessages();
            expect(messages[0].message).not.toMatch(/bonus payout/i);
            expect(messages[1].message).toBe(seededTip);
            expect(history._recentMessagesCache[0].message).toBe(seededTip);
        } finally {
            errorLog.mockRestore();
        }
    });

    test('the original system tip remains when a paid solo payout is actually available', async () => {
        const db = { query: jest.fn().mockResolvedValue({ rows: [seededRow] }) };
        const history = manager({ payoutsAvailable: true, db });
        expect((await history.getRecentMessages())[0].message).toBe(seededTip);
    });

    test('the official WOW pause suppresses the old promise even with stale manager flags', async () => {
        const previous = {
            OPERATED_PRODUCT_PROFILE: process.env.OPERATED_PRODUCT_PROFILE,
            PAYMENTS_ENABLED: process.env.PAYMENTS_ENABLED
        };
        try {
            process.env.OPERATED_PRODUCT_PROFILE = 'such-play-wow-prestige';
            process.env.PAYMENTS_ENABLED = 'false';
            const db = { query: jest.fn().mockResolvedValue({ rows: [seededRow] }) };
            const history = manager({ payoutsAvailable: true, db });
            expect((await history.getRecentMessages())[0].message).not.toMatch(/bonus payout/i);
        } finally {
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    });

    test('a system-looking row without the seed provenance is not rewritten', async () => {
        const row = { ...seededRow, username: 'Player' };
        const db = { query: jest.fn().mockResolvedValue({ rows: [row] }) };
        const history = manager({ payoutsAvailable: false, db });
        expect((await history.getRecentMessages())[0].message).toBe(seededTip);
    });
});
