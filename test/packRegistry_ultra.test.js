/**
 * Pack registry — the engine for multi-pack, interchangeable render environments (products).
 */
describe('pack registry', () => {
    let RK;
    beforeEach(() => { jest.resetModules(); RK = require('../html/js/render/packRegistry'); });

    function seed() {
        RK.registerPack({ id: 'topA', label: 'A', projection: 'topdown', assets: { a: 1 } });
        RK.registerPack({ id: 'isoFree', label: 'IsoFree', projection: 'iso', assets: { i: 1 } });
        RK.registerPack({ id: 'isoPrem', label: 'IsoPrem', projection: 'iso', assets: { i: 2 } });
    }

    test('registers packs and lists them by projection', () => {
        seed();
        expect(RK.packsForProjection('iso').map(p => p.id).sort()).toEqual(['isoFree', 'isoPrem']);
        expect(RK.getPackDef('topA').assets).toEqual({ a: 1 });
        expect(RK.registerPack({ id: 'x' })).toBeNull(); // no projection -> rejected
    });

    test('unlockedPacks filters by canUsePack', () => {
        seed();
        RK.canUsePack = (id) => id !== 'isoPrem';
        expect(RK.unlockedPacks('iso').map(p => p.id)).toEqual(['isoFree']);
    });

    test('active pack = saved-if-unlocked, else first unlocked; assets resolve', () => {
        seed();
        RK.canUsePack = () => true;
        expect(RK.activePackId('iso')).toBe('isoFree');       // default = first unlocked
        expect(RK.setActivePack('isoPrem')).toBe(true);
        expect(RK.activePackId('iso')).toBe('isoPrem');       // saved choice sticks
        expect(RK.activePackAssets('iso')).toEqual({ i: 2 });
    });

    test('a saved pack that later locks falls back; setActivePack refuses a locked pack', () => {
        seed();
        RK.canUsePack = () => true;
        RK.setActivePack('isoPrem');
        RK.canUsePack = (id) => id !== 'isoPrem';             // access lost
        expect(RK.activePackId('iso')).toBe('isoFree');       // graceful fallback
        expect(RK.setActivePack('isoPrem')).toBe(false);      // refused
    });

    test('a projection with no packs resolves to null', () => {
        seed();
        expect(RK.activePackId('3d')).toBeNull();
        expect(RK.activePackAssets('3d')).toBeNull();
    });
});
