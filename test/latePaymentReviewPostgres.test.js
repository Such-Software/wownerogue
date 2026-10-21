'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');
const { spawnSync } = require('child_process');
const GameModeManager = require('../src/game/gameModeManager');

const { Client } = createRequire(path.join(__dirname, '../src/package.json'))('pg');

function commandAvailable(name) {
    return spawnSync(name, ['--version'], { stdio: 'ignore' }).status === 0;
}

const postgresAvailable = process.getuid?.() !== 0
    && commandAvailable('initdb') && commandAvailable('pg_ctl');

function run(name, args, environment) {
    const result = spawnSync(name, args, { encoding: 'utf8', env: environment, timeout: 15000 });
    if (result.status !== 0) {
        throw new Error(`${name} failed for disposable local PostgreSQL fixture`);
    }
}

const sql = `
    CREATE TABLE payments (
        id integer PRIMARY KEY, status text NOT NULL, expected_amount bigint NOT NULL,
        provider_id text NOT NULL, address_index integer NOT NULL,
        late_receipt_checked_at timestamptz, received_amount bigint
    );
    CREATE TABLE payment_receipts (
        payment_id integer NOT NULL, provider_id text NOT NULL,
        evidence_type text NOT NULL, evidence_id text NOT NULL,
        tx_hash text, output_id text, address_index integer, amount bigint NOT NULL,
        confirmed boolean NOT NULL, UNIQUE (provider_id, evidence_id)
    );
    CREATE TABLE payment_late_reviews (
        payment_id integer UNIQUE NOT NULL, provider_id text NOT NULL,
        status text NOT NULL DEFAULT 'needs_review'
            CHECK (status IN ('needs_review', 'resolved', 'ignored')),
        observed_amount bigint NOT NULL,
        expected_amount bigint NOT NULL, receipt_count integer NOT NULL,
        metadata jsonb NOT NULL, last_observed_at timestamptz DEFAULT now(),
        resolved_at timestamptz
    );
`;

(postgresAvailable ? test : test.skip)(
    'real PostgreSQL keeps decided late reviews closed while repeated evidence updates open reviews',
    async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wow-late-review-'));
        const data = path.join(root, 'data');
        const socket = path.join(root, 'socket');
        fs.mkdirSync(socket, { mode: 0o700 });
        const environment = { PATH: process.env.PATH, HOME: root, LANG: 'C', LC_ALL: 'C' };
        let startAttempted = false;
        let client;
        try {
            run('initdb', ['-D', data, '-A', 'trust', '-U', 'wow_fixture', '-N'], environment);
            startAttempted = true;
            run('pg_ctl', ['-D', data, '-l', path.join(root, 'postgres.log'),
                '-o', `-c listen_addresses= -c unix_socket_directories=${socket} -p 5432`,
                '-w', 'start'], environment);
            client = new Client({ host: socket, port: 5432, user: 'wow_fixture',
                database: 'postgres', connectionTimeoutMillis: 3000 });
            await client.connect();
            await client.query(sql);
            const manager = Object.create(GameModeManager.prototype);
            manager.db = { withTransaction: async callback => {
                await client.query('BEGIN');
                try {
                    const result = await callback(client);
                    await client.query('COMMIT');
                    return result;
                } catch (error) {
                    await client.query('ROLLBACK');
                    throw error;
                }
            } };

            for (const [id, status] of [[1, 'resolved'], [2, 'ignored'], [3, 'needs_review']]) {
                await client.query(`INSERT INTO payments
                    (id, status, expected_amount, provider_id, address_index)
                    VALUES ($1, 'expired', 100, 'native-monero', $1)`, [id]);
                await client.query(`INSERT INTO payment_late_reviews
                    (payment_id, provider_id, status, observed_amount, expected_amount,
                     receipt_count, metadata, resolved_at)
                    VALUES ($1, 'native-monero', $2, $3, 100, 1,
                            '{"operatorDecision":"retained"}'::jsonb,
                            CASE WHEN $2 = 'needs_review' THEN NULL ELSE now() END)`,
                    [id, status, status === 'needs_review' ? 50 : 100]);
                const txHash = String(id).repeat(64);
                const outputId = String(id + 3).repeat(64);
                const result = await manager.reconcileLatePaymentForReview(id, [{
                    evidenceType: 'chain_output', providerId: 'native-monero',
                    txHash, outputId, evidenceId: `${txHash}:${outputId}`,
                    addressIndex: id, amount: '100', confirmed: true
                }]);
                const observed = (await client.query(`SELECT r.status, r.metadata, r.resolved_at,
                    r.observed_amount, p.late_receipt_checked_at,
                    COUNT(pr.payment_id)::integer AS receipts
                    FROM payment_late_reviews r
                    JOIN payments p ON p.id = r.payment_id
                    LEFT JOIN payment_receipts pr ON pr.payment_id = p.id
                    WHERE p.id = $1
                    GROUP BY r.status, r.metadata, r.resolved_at, r.observed_amount,
                        p.late_receipt_checked_at`, [id])).rows[0];
                expect(result.checked).toBe(true);
                expect(result.needsReview).toBe(status === 'needs_review');
                expect(observed.status).toBe(status);
                expect(observed.receipts).toBeGreaterThan(0);
                expect(observed.observed_amount).toBe('100');
                expect(observed.late_receipt_checked_at).not.toBeNull();
                if (status !== 'needs_review') {
                    expect(observed.resolved_at).not.toBeNull();
                    expect(observed.metadata.operatorDecision).toBe('retained');
                }
            }
        } finally {
            if (client) await client.end().catch(() => {});
            if (startAttempted) {
                const stopped = spawnSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'],
                    { env: environment, stdio: 'ignore', timeout: 15000 });
                if (stopped.status !== 0) {
                    throw new Error(`Disposable PostgreSQL fixture stop failed; retained ${root} for inspection`);
                }
            }
            fs.rmSync(root, { recursive: true, force: true });
        }
    },
    30000
);
