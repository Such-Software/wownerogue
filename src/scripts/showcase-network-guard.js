'use strict';

// Source-only application transport guard for the isolated lifecycle rehearsal. This is not an
// operating-system network sandbox. Browser traffic has its own allowlist in the runner.
const net = require('node:net');
const dns = require('node:dns');
const dgram = require('node:dgram');

function refusal() {
    return Object.assign(new Error('Showcase transport refused an unsupported or nonlocal connection.'), {
        code: 'SHOWCASE_EGRESS_DENIED'
    });
}

function connectionOptions(args) {
    let first = args[0];
    // Node createConnection/TLS can pass the already-normalized [options, callback] tuple.
    if (Array.isArray(first)) {
        if (first.length > 2 || !first[0] || typeof first[0] !== 'object' || Array.isArray(first[0])) return null;
        first = first[0];
    }
    if (first && typeof first === 'object') return first;
    if (typeof first === 'string' && first.startsWith('/')) return { path: first };
    if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
        if (args[1] !== undefined && typeof args[1] !== 'function' && typeof args[1] !== 'string') return null;
        return { port: first, host: typeof args[1] === 'string' ? args[1] : undefined };
    }
    return null;
}

function loopback(host) {
    return host === undefined || host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function allowedConnection(options, allowedSocketPath) {
    if (!options || typeof options !== 'object') return false;
    if (options.path !== undefined) return options.path === allowedSocketPath;
    return (typeof options.port === 'number' || typeof options.port === 'string') &&
        /^\d+$/.test(String(options.port)) && Number(options.port) > 0 && Number(options.port) <= 65535 &&
        loopback(options.host) && options.lookup === undefined;
}

function localLookup(host, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (typeof callback !== 'function') throw refusal();
    if (!loopback(host)) return process.nextTick(callback, refusal());
    const family = typeof options === 'number' ? options : options?.family;
    const ipv6 = host === '::1' || family === 6 || family === 'IPv6';
    const result = { address: ipv6 ? '::1' : '127.0.0.1', family: ipv6 ? 6 : 4 };
    if (options?.all) return process.nextTick(callback, null, [result]);
    return process.nextTick(callback, null, result.address, result.family);
}

function install(allowedSocketPath, dependencies = { net, dns, dgram }) {
    if (typeof allowedSocketPath !== 'string' || !allowedSocketPath.startsWith('/') ||
        !/\/\.s\.PGSQL\.\d+$/.test(allowedSocketPath)) throw refusal();
    const modules = dependencies;
    const originalConnect = modules.net.Socket.prototype.connect;
    modules.net.Socket.prototype.connect = function(...args) {
        if (!allowedConnection(connectionOptions(args), allowedSocketPath)) throw refusal();
        return originalConnect.apply(this, args);
    };
    modules.dns.lookup = localLookup;
    if (modules.dns.promises) {
        modules.dns.promises.lookup = (host, options) => new Promise((resolve, reject) => {
            localLookup(host, options, (error, address, family) => {
                if (error) reject(error);
                else resolve(options?.all ? address : { address, family });
            });
        });
    }
    // resolve/reverse use native c-ares sockets and must never reach a real DNS server.
    const names = ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx',
        'resolveNs', 'resolveTxt', 'resolveSrv', 'resolveNaptr', 'resolvePtr', 'resolveSoa',
        'resolveCaa', 'reverse', 'lookupService'];
    for (const target of [modules.dns, modules.dns.Resolver?.prototype]) {
        if (!target) continue;
        for (const name of names) {
            if (typeof target[name] !== 'function') continue;
            target[name] = (...args) => {
                const callback = args.find(value => typeof value === 'function');
                if (!callback) throw refusal();
                process.nextTick(callback, refusal());
            };
        }
    }
    for (const target of [modules.dns.promises, modules.dns.promises?.Resolver?.prototype]) {
        if (!target) continue;
        for (const name of names) {
            if (typeof target[name] === 'function') target[name] = async () => { throw refusal(); };
        }
    }
    modules.dgram.Socket.prototype.send = () => { throw refusal(); };
}

if (process.env.WOWNGEON_SHOWCASE_GUARD === '1') {
    if (process.env.NODE_ENV === 'production') throw refusal();
    install(process.env.WOWNGEON_SHOWCASE_PG_SOCKET);
}

module.exports = { connectionOptions, allowedConnection, install };
