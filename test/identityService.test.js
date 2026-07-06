const IdentityService = require('../src/network/identityService');

function makeSocket(id = 'sockA') {
  return { id, emit: jest.fn() };
}

function makeDb({ user, grants = [] } = {}) {
  const state = {
    user: {
      id: 1,
      socket_id: 'sockA',
      credits: 0,
      total_credits_purchased: 0,
      premium_level: 'free',
      appearance: {
        avatar: 'char-ranger',
        tint: 'teal',
        equipment: { body: 'mail', head: 'hood', shield: 'round', weapon: 'bow' }
      },
      ...user
    },
    grants
  };
  const db = {
    state,
    query: jest.fn(async (text, params = []) => {
      if (/SELECT pack_id/i.test(text)) return { rows: state.grants };
      if (/UPDATE users[\s\S]*SET appearance/i.test(text)) {
        state.user = { ...state.user, appearance: JSON.parse(params[0]) };
        return { rows: [state.user] };
      }
      return { rows: [] };
    })
  };
  return db;
}

describe('IdentityService', () => {
  test('loads stored appearance and entitlements for a socket user', async () => {
    const db = makeDb({ user: { total_credits_purchased: 5, credits: 2 } });
    const sessionManager = { sessions: new Map([['sockA', db.state.user]]) };
    const gameModeManager = { getOrCreateUser: jest.fn(async () => db.state.user), db };
    const svc = new IdentityService({ db, gameModeManager, sessionManager });

    const snapshot = await svc.identityForSocket(makeSocket());

    expect(snapshot.appearance).toEqual(db.state.user.appearance);
    expect(snapshot.entitlements.premium).toBe(true);
    expect(snapshot.entitlements.packs['iso-dungeon']).toBe(true);
  });

  test('saves normalized appearance and refreshes the session cache', async () => {
    const db = makeDb({ user: { total_credits_purchased: 0 } });
    const sessionManager = { sessions: new Map([['sockA', db.state.user]]) };
    const gameModeManager = { getOrCreateUser: jest.fn(async () => db.state.user), db };
    const svc = new IdentityService({ db, gameModeManager, sessionManager });

    const snapshot = await svc.saveAppearanceForSocket(makeSocket(), {
      avatar: 'char-ranger',
      tint: 'bad',
      equipment: { body: 'mail', head: 'bad', shield: 'round', weapon: 'laser' }
    });

    expect(snapshot.appearance).toEqual({
      avatar: 'char-ranger',
      tint: 'none',
      equipment: { body: 'mail', head: 'none', shield: 'round', weapon: 'none' }
    });
    expect(db.state.user.appearance).toEqual(snapshot.appearance);
    expect(sessionManager.sessions.get('sockA').appearance).toEqual(snapshot.appearance);
  });

  test('falls back unauthorized premium appearance before saving', async () => {
    const db = makeDb({ user: { total_credits_purchased: 0 } });
    const gameModeManager = { getOrCreateUser: jest.fn(async () => db.state.user), db };
    const svc = new IdentityService({ db, gameModeManager });

    const snapshot = await svc.saveAppearanceForSocket(makeSocket(), { avatar: 'monero-knight' });

    expect(snapshot.appearance.avatar).toBe('default');
    expect(db.state.user.appearance.avatar).toBe('default');
  });

  test('allows an explicitly granted pack appearance', async () => {
    const db = makeDb({
      user: { total_credits_purchased: 0 },
      grants: [{ pack_id: 'generated-skins' }]
    });
    const gameModeManager = { getOrCreateUser: jest.fn(async () => db.state.user), db };
    const svc = new IdentityService({ db, gameModeManager });

    const snapshot = await svc.saveAppearanceForSocket(makeSocket(), { avatar: 'monero-knight' });

    expect(snapshot.appearance.avatar).toBe('monero-knight');
    expect(snapshot.entitlements.packs['generated-skins']).toBe(true);
    expect(snapshot.entitlements.packs['kenney-3d-characters']).toBe(false);
  });
});
