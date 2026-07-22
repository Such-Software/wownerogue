'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const deployPath = name => path.join(__dirname, '..', 'scripts', 'deploy', name);
const deploy = name => fs.readFileSync(deployPath(name), 'utf8');

describe('parallel Monero stagenet wallet candidate boundary', () => {
    const preflight = deploy('monero-stagenet-parallel-preflight.py');
    const unit = deploy('monerogue-stagenet-wallet-candidate.service');
    const runbook = deploy('README-monero-stagenet-parallel-candidate.md');

    test('preflight is fixed, read-only, and does not inspect password-bearing sources', () => {
        expect(preflight).toContain('LEGACY_UNIT = "monero-wallet-rpc.service"');
        expect(preflight).toContain('LEGACY_RPC_PORT = 38083');
        expect(preflight).toContain('CANDIDATE_RPC_PORT = 38084');
        expect(preflight).toContain('VERIFY_RPC_PORT = 39084');
        expect(preflight).toContain('PR_SET_DUMPABLE');
        expect(preflight).toContain('O_NOFOLLOW');
        expect(preflight).toContain('details.st_nlink != 1');
        expect(preflight).not.toContain('/cmdline');
        expect(preflight).not.toContain('ExecStart');
        expect(preflight).not.toContain('wallet-password');
        expect(preflight).not.toMatch(/systemctl\([^\n]*(?:stop|start|restart|enable)/);
        expect(preflight).not.toMatch(/os\.(?:mkdir|unlink|remove|rename|chmod|chown|replace)\(/);
        expect(preflight).not.toContain('os.O_WRONLY');
        expect(preflight).not.toContain('mainnet');
    });

    test('candidate unit is a manual inert service with no live-app dependency', () => {
        expect(unit).toContain('User=monerogue-wallet-candidate');
        expect(unit).toContain('Group=monerogue-wallet-candidate');
        expect(unit).toContain('SupplementaryGroups=');
        expect(unit).toContain('ConditionPathExists=/var/lib/monerogue-stagenet-wallet-candidate/READY');
        expect(unit).toContain('--config-file /var/lib/monerogue-stagenet-wallet-candidate/config/wallet-rpc.conf');
        expect(unit).toContain('--log-file /dev/null');
        expect(unit).toContain('Restart=no');
        expect(unit).toContain('LimitCORE=0');
        expect(unit).toContain('ProtectSystem=strict');
        expect(unit).not.toContain('[Install]');
        expect(unit).not.toContain('WantedBy=');
        expect(unit).not.toContain('monerogue.service');
        expect(unit).not.toContain('38083');
        expect(unit).not.toContain('mainnet');
    });

    test('runbook keeps host mutation and production deployment at NO-GO', () => {
        expect(runbook).toContain('STATUS: DESIGN / NO-GO FOR HOST MUTATION OR PRODUCTION DEPLOYMENT');
        expect(runbook).toContain('never alters the legacy artifacts');
        expect(runbook).toContain('renameat2(RENAME_NOREPLACE)');
        expect(runbook).toContain('write `READY` **last**');
        expect(runbook).toContain('production-deployable answer is **no**');
        expect(runbook).toContain('mnemonic/off-host recovery custody is resolved separately');
    });

    test('disposable filesystem fixture passes independently', () => {
        const result = spawnSync(
            '/usr/bin/python3',
            [deployPath('monero-stagenet-parallel-fixture-test.py')],
            { encoding: 'utf8', timeout: 15000 }
        );
        expect({ status: result.status, signal: result.signal, stderr: result.stderr }).toEqual({
            status: 0,
            signal: null,
            stderr: expect.stringContaining('OK')
        });
    });
});
