#!/usr/bin/env node
/**
 * Non-destructive production smoke test for wownerogue.
 *
 * Exercises the surfaces changed by the review/NIP-98 work WITHOUT touching money:
 * no paid games, no payouts, no floods. Safe to run against the live mainnet instance.
 *
 * Usage:  node scripts/smoke.js [baseUrl]        (default https://play.wowne.ro)
 * Run from the src/ directory so socket.io-client / nostr-tools resolve.
 */
'use strict';

const BASE = (process.argv[2] || 'https://play.wowne.ro').replace(/\/+$/, '');
const io = require('socket.io-client');
const nt = require('nostr-tools');

let pass = 0, fail = 0, warn = 0;
const rid = () => 'smoke-' + Math.random().toString(16).slice(2, 12);

function ok(name, detail)   { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + name + (detail ? '  — ' + detail : '')); }
function bad(name, detail)  { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + name + (detail ? '  — ' + detail : '')); }
function meh(name, detail)  { warn++; console.log('  \x1b[33mWARN\x1b[0m ' + name + (detail ? '  — ' + detail : '')); }

async function req(method, path, { body, headers } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* non-JSON */ }
  return { status: res.status, json };
}

async function section(title) { console.log('\n\x1b[1m' + title + '\x1b[0m'); }

async function run() {
  console.log('Smoke test → ' + BASE + '\n' + '='.repeat(50));

  // ---- A. Public health / reachability -----------------------------------
  await section('A. Health & reachability');
  try {
    const h = await req('GET', '/health');
    h.status === 200 ? ok('GET /health', '200') : meh('GET /health', 'status ' + h.status);
    if (h.json) {
      const bh = h.json.blockHeight || h.json.block_height || (h.json.blockchain && h.json.blockchain.height);
      if (bh) ok('  block height present', String(bh));
    }
  } catch (e) { bad('GET /health', e.message); }

  try {
    const s = await req('GET', '/api/stats');
    s.status === 200 ? ok('GET /api/stats', 'online=' + (s.json && (s.json.online != null ? s.json.online : '?'))) : meh('GET /api/stats', 'status ' + s.status);
  } catch (e) { bad('GET /api/stats', e.message); }

  // ---- B. Security: token gating (BOLA fixes) ----------------------------
  await section('B. Auth gating (S1/S2 + /status BOLA)');
  try {
    const p = await req('GET', '/api/user/' + rid() + '/payments');
    p.status === 401 ? ok('GET /api/user/:id/payments without token', '401 (gated)')
      : bad('GET /api/user/:id/payments without token', 'expected 401, got ' + p.status + ' — endpoint NOT gated');
  } catch (e) { bad('/api/user/:id/payments', e.message); }

  try {
    const st = await req('GET', '/api/auth/smirk/status?socketId=' + rid());
    st.status === 401 ? ok('GET /api/auth/smirk/status without token', '401 (BOLA closed)')
      : bad('GET /api/auth/smirk/status without token', 'expected 401, got ' + st.status + ' — BOLA still open');
  } catch (e) { bad('/api/auth/smirk/status', e.message); }

  // ---- C. NIP-98 verify path (non-mutating: reject cases only) ------------
  await section('C. NIP-98 sign-in path (reject cases — no linking)');
  let challenge = null;
  try {
    const c = await req('POST', '/api/auth/smirk/challenge', { body: { socketId: rid() } });
    if (c.status === 200 && c.json && (c.json.challenge || c.json.nonce)) {
      challenge = c.json.challenge || c.json.nonce;
      ok('POST /challenge', 'issued a nonce');
    } else { meh('POST /challenge', 'status ' + c.status); }
  } catch (e) { bad('POST /challenge', e.message); }

  // malformed event -> must reject
  try {
    const bad1 = await req('POST', '/api/auth/smirk/verify', { body: { socketId: rid(), event: { kind: 27235 } } });
    (bad1.status >= 400 && bad1.status < 500) ? ok('POST /verify malformed event', 'rejected ' + bad1.status)
      : bad('POST /verify malformed event', 'expected 4xx, got ' + bad1.status);
  } catch (e) { bad('POST /verify malformed', e.message); }

  // validly-signed event but a challenge the server never issued -> must reject (challenge binding + crypto path reached)
  try {
    const sk = nt.generateSecretKey();
    const evt = nt.finalizeEvent({
      kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '',
      tags: [['u', BASE + '/api/auth/smirk/verify'], ['method', 'POST'], ['challenge', 'never-issued-' + rid()]],
    }, sk);
    const r = await req('POST', '/api/auth/smirk/verify', { body: { socketId: rid(), event: evt } });
    (r.status >= 400 && r.status < 500) ? ok('POST /verify valid sig + unissued challenge', 'rejected ' + r.status + ' (challenge binding enforced)')
      : bad('POST /verify valid sig + unissued challenge', 'expected 4xx, got ' + r.status + ' — challenge binding NOT enforced');
  } catch (e) { bad('POST /verify unissued challenge', e.message); }

  // ---- D. match_queue crash-DoS fix (server must survive) -----------------
  await section('D. match_queue crash-DoS fix (server survives)');
  await new Promise((resolve) => {
    const socket = io(BASE, { transports: ['websocket', 'polling'], timeout: 8000, reconnection: false });
    let done = false;
    const finish = async (connected) => {
      if (done) return; done = true;
      try { socket.close(); } catch (_) {}
      if (!connected) { meh('socket.io connect', 'could not connect (skipping crash test)'); return resolve(); }
      // give the server a moment, then confirm it is still up
      await new Promise((r) => setTimeout(r, 1200));
      try {
        const h = await req('GET', '/health');
        h.status === 200 ? ok('server alive after match_queue emit', 'GET /health 200 (no crash)')
          : bad('server alive after match_queue emit', '/health status ' + h.status + ' — possible crash!');
      } catch (e) { bad('server alive after match_queue emit', e.message + ' — possible crash!'); }
      resolve();
    };
    socket.on('connect', () => {
      ok('socket.io connect', socket.id);
      try { socket.emit('match_queue', { junk: true, action: 'join' }); } catch (_) {}
      try { socket.emit('match_queue', 'not-even-an-object'); } catch (_) {}
      finish(true);
    });
    socket.on('connect_error', () => finish(false));
    setTimeout(() => finish(false), 9000);
  });

  // ---- summary -----------------------------------------------------------
  console.log('\n' + '='.repeat(50));
  console.log('\x1b[1mSummary:\x1b[0m ' + pass + ' pass, ' + fail + ' fail, ' + warn + ' warn');
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error('smoke runner error:', e); process.exit(2); });
