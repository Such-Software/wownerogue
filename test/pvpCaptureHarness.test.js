'use strict';

const vm = require('vm');

const {
    CAPTURE_RULESET_IDS,
    DEFAULT_SEED,
    assertCaptureSafety,
    assertCaptureStateEnvironment,
    capturePageHtml,
    capturePresentation,
    captureResultSummary,
    captureStateHash,
    captureTraceHeader,
    createCaptureRoom,
    parseArgs,
    planBotMove,
    validateOptions
} = require('../src/scripts/pvp-capture');

describe('deterministic PvP capture harness', () => {
    function options(extra = {}) {
        return validateOptions(parseArgs([
            '--confirm-local-free-only',
            '--no-video',
            ...extra.args || []
        ]));
    }

    test('requires an explicit acknowledgement and can never run in production', () => {
        const safe = options();
        expect(() => assertCaptureSafety({ NODE_ENV: 'development' }, { ...safe, confirmed: false }))
            .toThrow('--confirm-local-free-only');
        expect(() => assertCaptureSafety({ NODE_ENV: 'production' }, safe))
            .toThrow('NODE_ENV=development or NODE_ENV=test');
        expect(() => assertCaptureSafety({ NODE_ENV: 'development', PAYOUTS_ENABLED: 'true' }, safe))
            .toThrow('money-enabled environments');
        expect(() => assertCaptureSafety({ NODE_ENV: 'test', MATCH_CRYPTO_RACE_ENABLED: '1' }, safe))
            .toThrow('MATCH_CRYPTO_RACE_ENABLED');
        expect(() => assertCaptureSafety({ NODE_ENV: 'test', PAYMENTS_ENABLED: 'true' }, safe))
            .toThrow('PAYMENTS_ENABLED');
        expect(() => assertCaptureSafety({ NODE_ENV: 'test', CREDITS_PAYOUT_ENABLED: 'true' }, safe))
            .toThrow('CREDITS_PAYOUT_ENABLED');
        expect(() => assertCaptureSafety({ NODE_ENV: 'test', WALLET_RPC_URL: 'http://127.0.0.1:18083' }, safe))
            .toThrow('wallet-configured environments');
        expect(assertCaptureSafety({ NODE_ENV: 'test' }, safe)).toBe(true);
    });

    test('refuses inherited gameplay tuning so a seed has one authoritative replay', () => {
        expect(() => assertCaptureStateEnvironment({ DIFFICULTY_PRESET: 'casino' }))
            .toThrow('inherited gameplay tuning: DIFFICULTY_PRESET');
        expect(() => assertCaptureSafety({ NODE_ENV: 'test', DUNGEON_WIDTH: '70' }, options()))
            .toThrow('inherited gameplay tuning: DUNGEON_WIDTH');
        expect(() => assertCaptureSafety({ NODE_ENV: 'development', MONSTER_SPEED: '2' }, options()))
            .toThrow('inherited gameplay tuning: MONSTER_SPEED');
        expect(assertCaptureStateEnvironment({})).toBe(true);
    });

    test('accepts only local renderer/capture options and a fixed-width seed', () => {
        expect(parseArgs(['--help']).help).toBe(true);
        expect(() => validateOptions(parseArgs([
            '--confirm-local-free-only', '--mode', '3d'
        ]))).toThrow('network-loaded renderers are forbidden');
        expect(() => validateOptions(parseArgs([
            '--confirm-local-free-only', '--seed', '1234'
        ]))).toThrow('64 hexadecimal');
        expect(() => validateOptions(parseArgs([
            '--confirm-local-free-only', '--ruleset', 'crypto-race'
        ]))).toThrow('--ruleset must be one of');
        expect(() => validateOptions(parseArgs([
            '--confirm-local-free-only', '--camera', 'wallet'
        ]))).toThrow('--camera must be action or focus');
        expect(() => parseArgs(['--url', 'https://example.com'])).toThrow('Unknown option');
    });

    test('creates every built-in multiplayer ruleset deterministically with no money state', () => {
        const config = options();
        const first = createCaptureRoom(config);
        const second = createCaptureRoom(config);

        expect(config.seed).toBe(DEFAULT_SEED);
        expect(first.economy).toBe('free');
        expect(first.ruleset.id).toBe('race');
        expect(first.ruleset.economy.model).toBe('free');
        expect(first.entryFeeAtomic).toBe(0);
        expect(first.potAtomic).toBe(0);
        expect(first.houseFeeAtomic).toBe(0);
        expect(Array.from(first.occupants.keys())).toEqual(['bot-1', 'bot-2', 'bot-3', 'bot-4']);
        expect(first.seedHash).toBe(second.seedHash);
        expect(first.dungeon.map).toEqual(second.dungeon.map);
        expect(first.dungeon.exit).toEqual(second.dungeon.exit);
        expect(first.dungeon.treasure).toEqual(second.dungeon.treasure);

        for (const rulesetId of CAPTURE_RULESET_IDS) {
            const room = createCaptureRoom(options({ args: ['--ruleset', rulesetId] }));
            expect(room.ruleset.id).toBe(rulesetId);
            expect(room.economy).toBe('free');
            expect(room.ruleset.economy.model).toBe('free');
            expect(room.entryFeeAtomic).toBe(0);
            expect(room.potAtomic).toBe(0);
            expect(room.houseFeeAtomic).toBe(0);
        }
    });

    test.each(CAPTURE_RULESET_IDS)('%s uses deterministic bot inputs and authoritative state', rulesetId => {
        const config = options({ args: ['--ruleset', rulesetId, '--ticks', '30'] });
        const rooms = [createCaptureRoom(config), createCaptureRoom(config)];
        rooms.forEach(room => room.start());

        for (let tick = 0; tick < 30; tick++) {
            for (const room of rooms) {
                const state = room.toGameState();
                for (const botId of room.occupants.keys()) {
                    const move = planBotMove(botId, state);
                    if (Math.abs(move.dx) + Math.abs(move.dy) === 1) {
                        room.queueMove(botId, move.dx, move.dy);
                    }
                }
                room.resolveTick();
            }
            expect(captureStateHash(rooms[0].toGameState()))
                .toBe(captureStateHash(rooms[1].toGameState()));
        }
    });

    test('last-alive bots pursue a rival instead of following the race exit', () => {
        const move = planBotMove('bot-1', {
            tick: 1,
            ruleset: { id: 'last-alive' },
            visibleTiles: [["'1", "'1", "'1"]],
            exit: [0, 0],
            players: [
                { id: 'bot-1', x: 0, y: 0, alive: true, finished: false },
                { id: 'bot-2', x: 2, y: 0, alive: true, finished: false }
            ]
        });
        expect(move).toEqual({ dx: 1, dy: 0 });
    });

    test('presentation and final copy are ruleset-correct, including cooperative results', () => {
        expect(capturePresentation('last-alive')).toEqual(expect.objectContaining({
            title: 'LAST ALIVE', activeNoun: 'STANDING'
        }));
        expect(captureResultSummary({
            ruleset: { id: 'score-attack' }, winnerId: 'bot-2', tickCount: 55
        }, [{ id: 'bot-2', name: 'Nyx', score: 912 }])).toEqual(expect.objectContaining({
            headline: 'NYX TOPS THE BOARD',
            detail: expect.stringMatching(/912 POINTS.*FREE EXHIBITION.*NO CASH PRIZES/)
        }));
        expect(captureResultSummary({
            ruleset: { id: 'coop-escape' }, winnerId: 'bot-1', tickCount: 40
        }, [
            { id: 'bot-1', escaped: true },
            { id: 'bot-2', escaped: true }
        ])).toEqual(expect.objectContaining({
            headline: 'TEAM ESCAPED TOGETHER', cooperative: true
        }));
        expect(captureResultSummary({
            ruleset: { id: 'last-alive' }, winnerId: 'bot-2', tickCount: 80
        }, [
            { id: 'bot-1', name: 'Rook', alive: true, finished: false },
            { id: 'bot-2', name: 'Nyx', alive: true, finished: false }
        ])).toEqual(expect.objectContaining({ headline: 'NYX LEADS AT THE BELL', winnerStatus: 'LEADER' }));
        expect(captureResultSummary({
            ruleset: { id: 'race' }, winnerId: 'bot-1', tickCount: 10, endReason: 'capture_limit'
        }, [{ id: 'bot-1', name: 'Rook' }])).toEqual(expect.objectContaining({
            headline: 'ROOK LEADS AT THE BELL', winnerStatus: 'LEADER'
        }));
        expect(captureResultSummary({
            ruleset: { id: 'last-alive' }, winnerId: 'bot-1', tickCount: 10, endReason: 'all_dead'
        }, [{ id: 'bot-1', name: 'Rook', alive: false }])).toEqual(expect.objectContaining({
            headline: 'ROOK SURVIVED LONGEST', winnerStatus: 'LAST OUT'
        }));
    });

    test('capture page uses local assets, a spectator focus camera, and no payment UI', () => {
        const html = capturePageHtml();
        expect(html).toContain('focusPlayerId:cameraFocus');
        expect(html).toContain("cameraMode=query.get('camera')||'action'");
        expect(html).toContain('id="roster"');
        expect(html).toContain('actionFocusUntil');
        expect(html).toContain('function composeCamera');
        expect(html).toContain("if(finalWinnerId&&player.id===finalWinnerId)classes.push('winner')");
        expect(html).toContain("finalWinnerId=outcome.cooperative?null:(payload.winnerId||null)");
        expect(html).toContain("if(finalWinnerId)document.body.classList.add('finale');else document.body.classList.remove('finale')");
        expect(html).toContain("if(renderer.name==='iso')return Math.max(cover");
        expect(html).toContain('baseFocus.x-previousFocus.x');
        expect(html).not.toContain('chosen.x-previousFocus.x');
        expect(html).toContain('DETERMINISTIC REPLAY ID');
        expect(html).not.toContain('VERIFIED REPLAY');
        expect(html).toContain('FREE EXHIBITION • NO CASH PRIZES');
        expect(html).toContain('id="roster" role="list"');
        expect(html).toContain('id="result" role="status" aria-live="polite" aria-atomic="true"');
        expect(html).toContain("slice(0,portrait?3:4)");
        expect(html).toContain("cover=Math.max(stage.clientWidth/(canvas.width||stage.clientWidth)");
        expect(html).toContain('#result{position:absolute;z-index:30;left:20px;right:20px;bottom:18px');
        expect(html).toContain("if(entity.kind==='player')entity.label=null");
        expect(html).toContain('controls:false');
        expect(html).toContain('/socket.io/socket.io.js');
        expect(html).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
        expect(html).not.toContain('crypto_race');
        expect(html).not.toContain('payment');

        const inlineScripts = Array.from(
            html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi),
            match => match[1]
        );
        expect(inlineScripts.length).toBeGreaterThanOrEqual(2);
        for (const source of inlineScripts) {
            expect(() => new vm.Script(source)).not.toThrow();
        }
    });

    test('parses the camera viewport as replay provenance', () => {
        const config = options({ args: ['--viewport', '1080x1920', '--camera', 'focus'] });
        const room = createCaptureRoom(config);
        const trace = captureTraceHeader(room, capturePresentation(room.ruleset), config);
        expect(config.viewport).toEqual({ width: 1080, height: 1920 });
        expect(config.camera).toBe('focus');
        expect(trace.camera).toEqual({
            mode: 'focus',
            focus: 'bot-1',
            renderer: 'tiles',
            viewport: { width: 1080, height: 1920 }
        });
    });
});
