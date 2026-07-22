'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const rootPath = (...parts) => path.join(__dirname, '..', ...parts);
const helperPath = rootPath('scripts', 'deploy', 'wallet-keyfile-recovery-proof.py');
const fixturePath = rootPath('scripts', 'deploy', 'wallet-keyfile-recovery-fixture-test.py');
const runbookPath = rootPath('docs', 'WALLET_KEYFILE_RECOVERY_PROOF.md');

describe('fixed wallet keyfile/password recovery proof boundary', () => {
    const helper = fs.readFileSync(helperPath, 'utf8');
    const runbook = fs.readFileSync(runbookPath, 'utf8');

    test('accepts only the two audited legacy profiles and fixed recovery artifacts', () => {
        for (const expected of [
            'monero-wallet-rpc.service',
            '/usr/bin/monero-wallet-rpc',
            '/home/jw/Programs/monero-x86_64-linux-gnu-v0.18.4.4/test',
            'monero-stagenet-preprod-20260721T1140Z.wallet',
            'monero-stagenet-preprod-20260721T1140Z.keys',
            '/run/wowngeon-wallet-keyfile-proof-monero-stagenet',
            'wownero-wallet-rpc.service',
            '/usr/bin/wownero-wallet-rpc',
            '/home/jw/Programs/wow-11.3.0/game',
            'wownero-mainnet-preprod-20260721T1140Z.wallet',
            'wownero-mainnet-preprod-20260721T1140Z.keys',
            '/run/wowngeon-wallet-keyfile-proof-wownero-mainnet',
        ]) {
            expect(helper).toContain(expected);
        }
        expect(helper).toContain('live_rpc_port=38083');
        expect(helper).toContain('proof_port=39084');
        expect(helper).toContain('live_rpc_port=34570');
        expect(helper).toContain('proof_port=39570');
        expect(helper).toContain('if len(arguments) != 1 or arguments[0] not in PROFILES:');
        expect(helper).not.toContain('argparse');
    });

    test('validates live identity before extracting and wiping the exact inline password', () => {
        expect(helper).toContain('systemctl("is-active", "--quiet", profile.unit)');
        expect(helper).toContain('process_executable(pid) != profile.binary');
        expect(helper).toContain('process_executable_identity(pid) != expected_binary');
        expect(helper).toContain('process_has_unit_cgroup(pid, profile.unit)');
        expect(helper).toContain('require_exact_listener(');
        expect(helper).toContain('b"--wallet-file"');
        expect(helper).toContain('b"--password"');
        expect(helper).toContain('f"/proc/{pid}/cmdline"');
        expect(helper).toContain('os.readv(descriptor, [buffer])');
        expect(helper).toContain('wipe_buffer(buffer, buffer_is_protected)');
        expect(helper).toContain('PR_SET_DUMPABLE');
        expect(helper).toContain('PR_SET_NO_NEW_PRIVS');
        expect(helper).toContain('MADV_DONTDUMP');
        expect(helper).not.toMatch(/systemctl\([^\n]*(?:stop|start|restart|reload|enable|disable)/);
    });

    test('drops candidate privilege and uses only fixed read/proof RPC methods', () => {
        expect(helper).toContain('os.setgroups([])');
        expect(helper).toContain('os.setgid(expected_gid)');
        expect(helper).toContain('os.setuid(expected_uid)');
        expect(helper).toContain('os.getresuid() != (expected_uid, expected_uid, expected_uid)');
        expect(helper).toContain('os.getresgid() != (expected_gid, expected_gid, expected_gid)');
        expect(helper).toContain('if process_groups(process.pid):');
        expect(helper).toContain('process_status_integer(process.pid, "NoNewPrivs") != 1');
        expect(helper).toContain('("CapInh", "CapPrm", "CapEff", "CapAmb")');
        expect(helper).toContain('LIBC.prctl(PR_SET_KEEPCAPS, 0, 0, 0, 0)');
        expect(helper).toContain('publish_candidate_tree(profile, expected_uid, expected_gid)');
        expect(helper).toContain('"method": "get_address"');
        expect(helper).toContain('rpc_request("sign", {"data": SIGN_MESSAGE})');
        expect(helper).toContain('"verify",');
        expect(helper).toContain('signature_type not in (None, "spend")');
        expect(helper).toContain('"--offline"');
        expect(helper).toContain('"--log-file"');
        expect(helper).toContain('"/dev/null"');
        expect(helper).toContain('password-file=');
        expect(helper).toContain('rpc-bind-ip=127.0.0.1');
        expect(helper).toContain('rpc-login=');
        expect(helper).toContain('if status != 401:');
        expect(helper).toContain('if status != 200:');
        expect(helper).toContain('hmac.compare_digest(live_address, restored_address)');
        for (const forbiddenMethod of [
            'query_key',
            'get_seed',
            'get_spend_key',
            'get_view_key',
            'transfer_split',
            'sweep_all',
        ]) {
            expect(helper).not.toContain(`"method": "${forbiddenMethod}"`);
        }
    });

    test('fails closed around source links, races, port collisions, and exact cleanup', () => {
        expect(helper).toContain('details.st_nlink != 1');
        expect(helper).toContain('O_NOFOLLOW');
        expect(helper).toContain('file_identity(os.fstat(source_fd)) != expected_source');
        expect(helper).toContain('refuse("proof-port-collision")');
        expect(helper).toContain('secure_remove_proof_directory(');
        expect(helper).toContain('(details.st_dev, details.st_ino) != expected_identity');
        expect(helper).toContain('result=passed');
        expect(helper).toContain('result=refused');
        expect(helper).not.toMatch(/(?:import traceback|traceback\.)/);
        expect(helper).not.toMatch(/\bprint\(/);
    });

    test('runbook keeps seed custody and off-host restore explicitly unproven', () => {
        expect(runbook).toContain('has not been installed on or run against');
        expect(runbook).toContain('This is **not seed custody**');
        expect(runbook).toContain('it is **not an off-host disaster-recovery test**');
        expect(runbook).toMatch(/record seed custody and off-host recovery as\s+\*\*unproven\*\*/);
        expect(runbook).toContain('The proof candidate is offline');
        expect(runbook).toMatch(/Wallet-RPC never runs\s+as root/);
        expect(runbook).toContain('not from an independent custody source');
        expect(runbook).toContain('**not** an RPC-hardening or');
        expect(runbook).toContain('not evidence they have been run');
        expect(runbook).toContain('do not blindly remove it');
    });

    test('synthetic fixture passes without opening a real wallet', () => {
        const result = spawnSync('/usr/bin/python3', [fixturePath], {
            encoding: 'utf8',
            timeout: 15000,
        });
        expect({ status: result.status, signal: result.signal, stdout: result.stdout }).toEqual({
            status: 0,
            signal: null,
            stdout: '',
        });
        expect(result.stderr).toContain('OK');
    });

    test('invalid invocation renders only the refusal status', () => {
        const result = spawnSync('/usr/bin/python3', [helperPath, 'not-a-profile'], {
            encoding: 'utf8',
            timeout: 5000,
        });
        expect({
            status: result.status,
            signal: result.signal,
            stdout: result.stdout,
            stderr: result.stderr,
        }).toEqual({
            status: 1,
            signal: null,
            stdout: 'result=refused\n',
            stderr: '',
        });
    });
});
