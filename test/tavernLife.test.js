const fs = require('fs');
const vm = require('vm');
const sceneApi = require('../html/js/render/sceneModel');
const { TAVERN_LAYOUT } = require('../src/multiplayer/tavernMap');

function loadTavernLife() {
    function CanvasRenderingContext2D() {}
    const browser = {
        CanvasRenderingContext2D,
        requestAnimationFrame: () => 1,
        cancelAnimationFrame: () => {},
        document: { createElement: () => ({ getContext: () => null }) }
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../html/js/render/tavernLife.js'), 'utf8'), { window: browser });
    return browser.RK.TavernLife;
}

function makeScene(layout = TAVERN_LAYOUT) {
    return sceneApi.sceneFromTavern({
        cols: layout[0].length,
        rows: layout.length,
        layout,
        occupants: []
    });
}

function createLife(layout = TAVERN_LAYOUT, random = () => 0.5) {
    const scene = makeScene(layout);
    let now = 1;
    const host = { querySelector: () => null, style: {}, appendChild: () => {} };
    const TavernLife = loadTavernLife();
    const life = new TavernLife(host, () => scene, () => 24, { now: () => now, random });
    life.spawn();
    life.injectInto(scene);
    return {
        life,
        scene,
        advance(ms) {
            now += ms;
            life.update(scene, 24, 'tiles');
        }
    };
}

function smallDesignedRoom(blockStaffLane = false) {
    const rows = [
        '########',
        blockStaffLane ? '#.hhhh.#' : '#......#',
        '#.=====#',
        '#......#',
        '#..T...#',
        '#..c...#',
        '#......#',
        '########'
    ];
    return rows;
}

describe('tavern ambient life', () => {
    test('the authored bar lane is one connected walkable staff route', () => {
        const scene = makeScene();
        const barY = scene.grid.findIndex(row => row.includes('bar'));
        const laneY = barY - 1;
        const counterXs = scene.grid[barY].map((tile, x) => tile === 'bar' ? x : -1).filter(x => x >= 0);
        const firstCounter = Math.min(...counterXs);
        const lastCounter = Math.max(...counterXs);
        const lane = [];
        for (let x = 0; x < scene.cols; x++) {
            if (x > firstCounter && x < lastCounter && scene.grid[laneY][x] === 'floor') lane.push({ x, y: laneY });
        }
        expect(lane.length).toBeGreaterThan(1);
        const seen = new Set();
        const queue = [lane[0]];
        while (queue.length) {
            const point = queue.shift();
            const key = `${point.x},${point.y}`;
            if (seen.has(key)) continue;
            seen.add(key);
            for (const next of [
                { x: point.x - 1, y: point.y }, { x: point.x + 1, y: point.y },
                { x: point.x, y: point.y - 1 }, { x: point.x, y: point.y + 1 }
            ]) {
                if (next.x >= 0 && next.x < scene.cols && next.y >= 0 && next.y < scene.rows &&
                    !seen.has(`${next.x},${next.y}`) && scene.legend[scene.grid[next.y][next.x]]?.solid === false) {
                    queue.push(next);
                }
            }
        }
        expect(lane.every(point => seen.has(`${point.x},${point.y}`))).toBe(true);
        expect(scene.grid[barY].filter(tile => tile === 'bar').length).toBeGreaterThan(lane.length);
    });

    test('starts patrons on real chairs, keeps the barkeep in the staff lane, and routes the waitress between tables', () => {
        const { life, scene, advance } = createLife();
        const patrons = life.npcs.filter(npc => npc.role === 'patron');
        const bartender = life.npcs.find(npc => npc.role === 'bartender');
        const waitress = life.npcs.find(npc => npc.role === 'waitress');
        const tableCells = [];
        for (let y = 0; y < scene.rows; y++) {
            for (let x = 0; x < scene.cols; x++) {
                if (scene.grid[y][x] === 'table') tableCells.push({ x, y });
            }
        }
        expect(patrons).toHaveLength(4);
        expect(new Set(patrons.map(npc => `${npc.x},${npc.y}`)).size).toBe(patrons.length);
        for (const patron of patrons) {
            expect(scene.grid[patron.y][patron.x]).toBe('chair');
            expect(tableCells.some(table => table.x === patron.homeX && table.y + 1 === patron.homeY)).toBe(true);
            expect(patron.phase).toBe('seated');
        }
        expect(bartender).toBeDefined();
        expect(life._isRoleCell(bartender, scene, bartender.x, bartender.y)).toBe(true);
        expect(waitress).toBeDefined();

        const barY = scene.grid.findIndex(row => row.includes('bar'));
        const laneY = barY - 1;
        const lane = scene.grid[laneY].map((tile, x) => tile === 'floor' ? x : -1).filter(x => x >= 0);
        const bartenderVisited = new Set();
        const waitressVisited = new Set();
        const patronMoved = new Map(patrons.map(npc => [npc.id, false]));
        const patronSeatedTicks = new Map(patrons.map(npc => [npc.id, 0]));
        const outingStarts = [];
        const outingReturns = [];
        let activeExcursionTicks = 0;
        let previous = new Map(life.npcs.map(npc => [npc.id, { x: npc.x, y: npc.y }]));

        for (let i = 0; i < 360; i++) {
            advance(1000);
            const activePatrons = patrons.filter(npc => npc.phase !== 'seated');
            expect(activePatrons.length).toBeLessThanOrEqual(1);
            if (activePatrons.length) activeExcursionTicks++;
            for (const npc of life.npcs) {
                const old = previous.get(npc.id);
                const distance = Math.abs(npc.x - old.x) + Math.abs(npc.y - old.y);
                expect(distance).toBeLessThanOrEqual(1);
                if (distance) expect(distance).toBe(1);
                if (npc.role === 'bartender') {
                    expect(npc.y).toBe(laneY);
                    expect(lane).toContain(npc.x);
                    bartenderVisited.add(`${npc.x},${npc.y}`);
                } else if (npc.role === 'patron') {
                    expect(Math.abs(npc.x - npc.homeX) + Math.abs(npc.y - npc.homeY)).toBeLessThanOrEqual(3);
                    expect(['chair', 'floor']).toContain(scene.grid[npc.y][npc.x]);
                    if (distance) patronMoved.set(npc.id, true);
                    if (npc.phase === 'seated') {
                        expect(npc.x).toBe(npc.homeX);
                        expect(npc.y).toBe(npc.homeY);
                        patronSeatedTicks.set(npc.id, patronSeatedTicks.get(npc.id) + 1);
                    }
                    if (npc.phase === 'outbound' && !previous.get(`${npc.id}:outing`)) {
                        outingStarts.push((i + 1) * 1000);
                    }
                    const wasReturning = previous.get(`${npc.id}:returning`) === true;
                    if (wasReturning && npc.phase === 'seated') outingReturns.push((i + 1) * 1000);
                    previous.set(`${npc.id}:outing`, npc.phase === 'outbound' || npc.phase === 'pausing' || npc.phase === 'returning');
                    previous.set(`${npc.id}:returning`, npc.phase === 'returning');
                } else if (npc.role === 'waitress') {
                    expect(scene.grid[npc.y][npc.x]).toBe('floor');
                    expect(npc.y).toBeGreaterThanOrEqual(3);
                    waitressVisited.add(`${npc.x},${npc.y}`);
                }
                previous.set(npc.id, { x: npc.x, y: npc.y });
            }
        }

        expect(bartenderVisited.size).toBeGreaterThan(1);
        expect(waitressVisited.size).toBeGreaterThan(2);
        expect([...patronMoved.values()].some(Boolean)).toBe(true);
        expect(outingReturns.length).toBeGreaterThanOrEqual(1);
        expect(outingStarts.length).toBeGreaterThanOrEqual(outingReturns.length);
        for (let i = 1; i < outingStarts.length; i++) {
            const previousReturn = outingReturns.filter(time => time < outingStarts[i]).at(-1);
            expect(previousReturn).toBeDefined();
            expect(outingStarts[i] - previousReturn).toBeGreaterThanOrEqual(45000);
        }
        expect(activeExcursionTicks).toBeLessThan(360 * 0.2);
        for (const patron of patrons) {
            expect(patronSeatedTicks.get(patron.id)).toBeGreaterThan(360 * 0.75);
        }
        expect(patrons.some(npc => npc.phase === 'seated' && npc.x === npc.homeX && npc.y === npc.homeY)).toBe(true);
    });

    test('leaves designed rooms without semantic tables and chairs actor-free', () => {
        const layout = TAVERN_LAYOUT.map(row => row.replace(/T|c/g, '.'));
        const { life } = createLife(layout);
        expect(life.npcs).toEqual([]);
        expect(life._spawned).toBe(false);
    });

    test('uses semantic seats and bar space in a compact designed room', () => {
        const { life, scene } = createLife(smallDesignedRoom());
        expect(life.npcs.map(npc => npc.role)).toEqual(['bartender', 'patron', 'waitress', 'cat']);
        const bartender = life.npcs[0];
        const patron = life.npcs.find(npc => npc.role === 'patron');
        const waitress = life.npcs.find(npc => npc.role === 'waitress');
        expect(scene.grid[bartender.y][bartender.x]).toBe('floor');
        expect(bartender.roleArea.minX).toBeLessThanOrEqual(bartender.x);
        expect(bartender.roleArea.maxX).toBeGreaterThanOrEqual(bartender.x);
        expect(scene.grid[patron.y][patron.x]).toBe('chair');
        expect(scene.grid[waitress.y][waitress.x]).toBe('floor');
    });

    test('does not invent actors when a semantic bar has no walkable staff lane', () => {
        const { life } = createLife(smallDesignedRoom(true));
        expect(life.npcs).toEqual([]);
        expect(life._spawned).toBe(false);
    });

    test('does not spawn a barkeep on walkable non-floor staff tiles', () => {
        const layout = smallDesignedRoom().slice();
        layout[1] = '#.rrrr.#';
        const { life } = createLife(layout);
        expect(life.npcs).toEqual([]);
        expect(life._spawned).toBe(false);
    });

    test('preserves player-bubble identity and uses an optional viewport-relative 3D head projection', () => {
        const scene = makeScene();
        let now = 500;
        const TavernLife = loadTavernLife();
        const life = new TavernLife({}, () => scene, null, {
            now: () => now,
            projectEntityHead: entity => ({ x: entity.x + 7, y: entity.y + 11 })
        });
        life.showPlayerBubble('socket-1', 'hello');
        expect(life._realBubbles['socket-1']).toEqual({ text: 'hello', until: 4700 });
        expect(life._entityScreenPos({ x: 3, y: 4 }, scene, 24, '3d')).toEqual({ x: 10, y: 15 });
        now = 1000;
        life.showPlayerBubble('socket-1', 'again');
        expect(life._realBubbles['socket-1'].until).toBe(5200);
    });
});
