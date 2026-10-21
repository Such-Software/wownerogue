const { connectionOptions, allowedConnection, install } = require('../src/scripts/showcase-network-guard');

const SOCKET = '/private/showcase/pgsock/.s.PGSQL.5432';
function fixture() {
    const connect = jest.fn(() => 'connected');
    const send = jest.fn();
    const resolve = jest.fn();
    const modules = {
        net: { Socket: { prototype: { connect } } },
        dns: { lookup: jest.fn(), resolve, reverse: resolve,
            Resolver: { prototype: { resolve } },
            promises: { lookup: jest.fn(), resolve, Resolver: { prototype: { resolve } } } },
        dgram: { Socket: { prototype: { send } } }
    };
    install(SOCKET, modules);
    return { modules, connect, send, resolve };
}

test.each([
    [5432], [5432, '127.0.0.1'], [5432, '::1'], [{ port: 5432, host: 'localhost' }],
    [[{ port: 5432, host: '127.0.0.1' }, () => {}]], [SOCKET], [{ path: SOCKET }]
])('admits documented local connect arguments: %j', (...args) => {
    expect(allowedConnection(connectionOptions(args), SOCKET)).toBe(true);
});

test.each([
    [5432, '192.0.2.1'], [{ port: 443, host: 'api.example.invalid' }],
    [[{ port: 443, host: '192.0.2.1' }, () => {}]],
    [{ port: 443, host: 'localhost', lookup: () => {} }],
    ['/private/other/.s.PGSQL.5432'], [{ path: '/private/other/.s.PGSQL.5432' }],
    [[[{ port: 443, host: '192.0.2.1' }]]], [null], [{}], [false]
])('refuses unsupported or foreign transports without opening a socket: %j', (...args) => {
    const { modules, connect } = fixture();
    expect(() => modules.net.Socket.prototype.connect(...args)).toThrow(expect.objectContaining({ code: 'SHOWCASE_EGRESS_DENIED' }));
    expect(connect).not.toHaveBeenCalled();
});

test('resolves localhost locally and refuses native DNS and UDP without calling originals', async () => {
    const { modules, resolve, send } = fixture();
    await expect(modules.dns.promises.lookup('localhost')).resolves.toEqual({ address: '127.0.0.1', family: 4 });
    await expect(modules.dns.promises.lookup('localhost', { all: true, family: 6 })).resolves.toEqual([{ address: '::1', family: 6 }]);
    await expect(modules.dns.promises.lookup('api.example.invalid')).rejects.toMatchObject({ code: 'SHOWCASE_EGRESS_DENIED' });
    await expect(modules.dns.promises.resolve('localhost')).rejects.toMatchObject({ code: 'SHOWCASE_EGRESS_DENIED' });
    await new Promise(done => modules.dns.resolve('localhost', error => {
        expect(error.code).toBe('SHOWCASE_EGRESS_DENIED'); done();
    }));
    expect(() => modules.dgram.Socket.prototype.send(Buffer.from('fixture'))).toThrow();
    expect(resolve).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
});
