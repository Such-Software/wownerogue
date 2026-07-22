const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const sourceBuilder = path.join(__dirname, '..', 'scripts', 'deploy', 'build-release-artifact.sh');

function run(command, args, options = {}) {
    return execFileSync(command, args, {
        cwd: options.cwd,
        encoding: 'utf8',
        env: { ...process.env, TZ: 'UTC' },
        stdio: options.stdio || ['ignore', 'pipe', 'pipe']
    });
}

function write(root, relative, contents, mode = 0o644) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, { mode });
}

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wowngeon-release-test-'));
    write(root, 'scripts/deploy/build-release-artifact.sh', fs.readFileSync(sourceBuilder), 0o755);
    write(root, 'src/index.js', "'use strict';\n");
    write(root, 'src/package.json', JSON.stringify({
        name: 'fixture',
        version: '1.0.0',
        scripts: {
            start: 'node index.js',
            preflight: 'node scripts/preflight.js',
            'db:migrate:clone': 'node scripts/migrate-disposable-clone.js',
            test: 'jest',
            'capture:pvp': 'node scripts/pvp-capture.js',
            'canary:stagenet': 'node scripts/stagenet-financial-canary.js',
            'db:create': 'node scripts/setup_db.js'
        }
    }) + '\n');
    write(root, 'src/package-lock.json', '{"name":"fixture","lockfileVersion":3}\n');
    write(root, 'src/scripts/preflight.js', "'use strict';\n");
    write(root, 'src/scripts/migrate-disposable-clone.js', "'use strict';\n");
    write(root, 'src/scripts/pvp-capture.js', "throw new Error('source-only ad harness');\n");
    write(root, 'src/scripts/stagenet-financial-canary.js', "throw new Error('source-only transfer canary');\n");
    write(root, 'src/scripts/setup_db.js', "throw new Error('source-only database helper');\n");
    write(root, 'src/scripts/smoke.js', "throw new Error('source-only smoke helper');\n");
    write(root, 'src/jest.config.js', "module.exports = {};\n");
    write(root, 'src/sim/simulate.js', "throw new Error('source-only simulator');\n");
    write(root, 'src/.env.example', 'DB_PASSWORD=CHANGE_ME\n');
    write(root, 'src/.env.production.example', 'ADMIN_API_KEY=CHANGE_ME\n');
    write(root, 'html/index.html', '<!doctype html>\n');
    write(root, 'LICENSE', 'fixture license\n');
    write(root, '.env.example', 'DB_PASSWORD=CHANGE_ME\n');
    write(root, 'README.md', 'source documentation only\n');
    write(root, 'docs/internal.md', 'operator documentation only\n');
    write(root, 'test/runtime-exclusion.test.js', "throw new Error('must not ship');\n");
    write(root, 'scripts/deploy/example.service', '[Service]\nExecStart=/bin/false\n');
    write(root, 'scripts/deploy/migrate-monero-stagenet-wallet.sh', '#!/bin/sh\nexit 1\n', 0o755);
    write(root, '.gitignore', 'out*/\n');
    run('git', ['init', '-q'], { cwd: root });
    run('git', ['config', 'user.name', 'Release Test'], { cwd: root });
    run('git', ['config', 'user.email', 'release-test@example.invalid'], { cwd: root });
    run('git', ['add', '.'], { cwd: root });
    run('git', ['commit', '-qm', 'fixture'], { cwd: root });
    return root;
}

function build(root, output, releaseId = 'candidate-1') {
    return run(path.join(root, 'scripts/deploy/build-release-artifact.sh'), [
        '--release-id', releaseId,
        '--output-dir', output
    ], { cwd: root });
}

function buildAsync(root, output, releaseId = 'candidate-1') {
    return new Promise(resolve => {
        const child = require('child_process').spawn(
            path.join(root, 'scripts/deploy/build-release-artifact.sh'),
            ['--release-id', releaseId, '--output-dir', output],
            {
                cwd: root,
                env: { ...process.env, TZ: 'UTC' },
                stdio: ['ignore', 'pipe', 'pipe']
            }
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('close', status => resolve({ status, stdout, stderr }));
    });
}

describe('release artifact builder', () => {
    const roots = [];

    afterEach(() => {
        for (const root of roots.splice(0)) {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('builds byte-identical, runtime-only artifacts with provenance markers', () => {
        const root = fixture();
        roots.push(root);
        const first = path.join(root, 'out-a');
        const second = path.join(root, 'out-b');

        const output = build(root, first);
        build(root, second);

        const artifactA = path.join(first, 'candidate-1.tar.gz');
        const artifactB = path.join(second, 'candidate-1.tar.gz');
        expect(fs.readFileSync(artifactA).equals(fs.readFileSync(artifactB))).toBe(true);
        expect(output).toMatch(/^release_id=candidate-1$/m);
        expect(output).toMatch(/^commit=[0-9a-f]{40}$/m);
        expect(output).toMatch(/^source_sha256=[0-9a-f]{64}$/m);
        expect(output).toMatch(/^artifact_sha256=[0-9a-f]{64}$/m);

        const members = run('tar', ['-tzf', artifactA]).trim().split('\n');
        expect(members).toContain('candidate-1/.release-source-sha256');
        expect(members).toContain('candidate-1/.release-commit');
        expect(members).toContain('candidate-1/.release-package-lock-sha256');
        expect(members).toContain('candidate-1/.release-files.sha256');
        expect(members).toContain('candidate-1/LICENSE');
        expect(members).toContain('candidate-1/src/index.js');
        expect(members).toContain('candidate-1/src/scripts/preflight.js');
        expect(members).toContain('candidate-1/src/scripts/migrate-disposable-clone.js');
        expect(members.some(member => member.includes('/.git/'))).toBe(false);
        expect(members.some(member => member.includes('/node_modules/'))).toBe(false);
        expect(members.some(member => /\/(?:\.env)$/.test(member))).toBe(false);
        expect(members.some(member => member.startsWith('candidate-1/docs/'))).toBe(false);
        expect(members.some(member => member.startsWith('candidate-1/test/'))).toBe(false);
        expect(members.some(member => member.startsWith('candidate-1/scripts/'))).toBe(false);
        expect(members.some(member => member.endsWith('.service'))).toBe(false);
        expect(members).not.toContain('candidate-1/scripts/deploy/migrate-monero-stagenet-wallet.sh');
        expect(members.some(member => /^candidate-1\/src\/\.env(?:\.|$)/.test(member))).toBe(false);
        expect(members.some(member => /\/\.env(?:\..*)?\.example$/.test(member))).toBe(false);
        expect(members).not.toContain('candidate-1/src/scripts/pvp-capture.js');
        expect(members).not.toContain('candidate-1/src/scripts/stagenet-financial-canary.js');
        expect(members).not.toContain('candidate-1/src/scripts/setup_db.js');
        expect(members).not.toContain('candidate-1/src/scripts/smoke.js');
        expect(members).not.toContain('candidate-1/src/jest.config.js');
        expect(members.some(member => member.startsWith('candidate-1/src/sim/'))).toBe(false);

        const allowedTopLevel = new Set([
            '.release-commit',
            '.release-files.sha256',
            '.release-id',
            '.release-package-lock-sha256',
            '.release-source-sha256',
            'LICENSE',
            'html',
            'src'
        ]);
        const actualTopLevel = new Set(
            members
                .filter(member => member.startsWith('candidate-1/'))
                .map(member => member.slice('candidate-1/'.length).split('/')[0])
                .filter(Boolean)
        );
        expect(actualTopLevel).toEqual(allowedTopLevel);

        run('sha256sum', ['--check', path.join(first, 'candidate-1.tar.gz.sha256')], { cwd: first });
        const extracted = path.join(root, 'extracted');
        fs.mkdirSync(extracted);
        run('tar', ['-xzf', artifactA, '-C', extracted]);
        run('sha256sum', ['--check', '.release-files.sha256'], {
            cwd: path.join(extracted, 'candidate-1')
        });
        const runtimePackage = JSON.parse(fs.readFileSync(
            path.join(extracted, 'candidate-1/src/package.json'), 'utf8'
        ));
        expect(runtimePackage.scripts).toEqual({
            start: 'node index.js',
            preflight: 'node scripts/preflight.js',
            'db:migrate:clone': 'node scripts/migrate-disposable-clone.js'
        });
    });

    test.each([
        ['tracked modification', root => write(root, 'src/index.js', '// dirty\n')],
        ['untracked file', root => write(root, 'untracked.txt', 'not reviewed\n')]
    ])('refuses a dirty worktree: %s', (_label, dirty) => {
        const root = fixture();
        roots.push(root);
        dirty(root);
        const result = spawnSync(path.join(root, 'scripts/deploy/build-release-artifact.sh'), [], {
            cwd: root,
            encoding: 'utf8'
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('worktree is dirty');
    });

    test('refuses tracked symlinks', () => {
        const root = fixture();
        roots.push(root);
        fs.symlinkSync('index.js', path.join(root, 'src', 'linked.js'));
        run('git', ['add', '.'], { cwd: root });
        run('git', ['commit', '-qm', 'add symlink'], { cwd: root });
        const result = spawnSync(path.join(root, 'scripts/deploy/build-release-artifact.sh'), [], {
            cwd: root,
            encoding: 'utf8'
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('tracked symlink, gitlink, or unsafe file mode');
    });

    test('refuses tracked runtime environment files', () => {
        const root = fixture();
        roots.push(root);
        write(root, '.env.production', 'SECRET=value\n');
        run('git', ['add', '-f', '.env.production'], { cwd: root });
        run('git', ['commit', '-qm', 'add forbidden env'], { cwd: root });
        const result = spawnSync(path.join(root, 'scripts/deploy/build-release-artifact.sh'), [], {
            cwd: root,
            encoding: 'utf8'
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('tracked non-example environment file is forbidden');
    });

    test('refuses unsafe release IDs and existing output', () => {
        const root = fixture();
        roots.push(root);
        const output = path.join(root, 'out');
        let result = spawnSync(path.join(root, 'scripts/deploy/build-release-artifact.sh'), [
            '--release-id', '../escape', '--output-dir', output
        ], { cwd: root, encoding: 'utf8' });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('release ID must be');

        build(root, output, 'candidate-1');
        result = spawnSync(path.join(root, 'scripts/deploy/build-release-artifact.sh'), [
            '--release-id', 'candidate-1', '--output-dir', output
        ], { cwd: root, encoding: 'utf8' });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('refusing to overwrite');
    });

    test.each([
        ['missing', scripts => { delete scripts.preflight; }],
        ['empty', scripts => { scripts.preflight = '   '; }],
        ['non-string', scripts => { scripts.preflight = { command: 'node scripts/preflight.js' }; }]
    ])('refuses a %s required runtime package script', (_label, mutate) => {
        const root = fixture();
        roots.push(root);
        const manifestPath = path.join(root, 'src/package.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        mutate(manifest.scripts);
        fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
        run('git', ['add', 'src/package.json'], { cwd: root });
        run('git', ['commit', '-qm', 'break required runtime script'], { cwd: root });

        const result = spawnSync(path.join(root, 'scripts/deploy/build-release-artifact.sh'), [], {
            cwd: root,
            encoding: 'utf8'
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('required runtime package script is absent or empty: preflight');
    });

    test('a losing concurrent build cannot remove the winning same-ID publication', async () => {
        const root = fixture();
        roots.push(root);
        const output = path.join(root, 'out');

        const results = await Promise.all([
            buildAsync(root, output),
            buildAsync(root, output),
            buildAsync(root, output),
            buildAsync(root, output)
        ]);

        expect(results.filter(result => result.status === 0)).toHaveLength(1);
        expect(results.filter(result => result.status !== 0)).toHaveLength(3);
        const artifact = path.join(output, 'candidate-1.tar.gz');
        const checksum = `${artifact}.sha256`;
        expect(fs.existsSync(artifact)).toBe(true);
        expect(fs.existsSync(checksum)).toBe(true);
        run('sha256sum', ['--check', checksum], { cwd: output });
    });
});
