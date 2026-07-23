const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    loadReleaseIdentity,
    readBoundedRegularFile
} = require('../src/config/releaseIdentity');

describe('immutable release identity', () => {
    let root;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'wowngeon-release-identity-'));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    function writeIdentity(commit = 'a'.repeat(40), id = `git-${commit.slice(0, 12)}`) {
        fs.writeFileSync(path.join(root, '.release-id'), `${id}\n`, { mode: 0o444 });
        fs.writeFileSync(path.join(root, '.release-commit'), `${commit}\n`, { mode: 0o444 });
    }

    test('returns the matching artifact release ID and commit', () => {
        writeIdentity();
        expect(loadReleaseIdentity({ releaseRoot: root, production: true })).toEqual({
            verified: true,
            id: `git-${'a'.repeat(12)}`,
            commit: 'a'.repeat(40)
        });
    });

    test('fails production closed when identity files disagree', () => {
        writeIdentity('b'.repeat(40), `git-${'c'.repeat(12)}`);
        expect(() => loadReleaseIdentity({ releaseRoot: root, production: true }))
            .toThrow('production release identity is absent or invalid');
    });

    test('fails production closed when either identity file is absent', () => {
        expect(() => loadReleaseIdentity({ releaseRoot: root, production: true }))
            .toThrow('production release identity is absent or invalid');
    });

    test('returns an explicit unverified identity outside production', () => {
        expect(loadReleaseIdentity({ releaseRoot: root, production: false })).toEqual({
            verified: false,
            id: null,
            commit: null
        });
    });

    test('refuses symlinks and oversized identity files', () => {
        const target = path.join(root, 'target');
        fs.writeFileSync(target, 'a'.repeat(40));
        const linked = path.join(root, 'linked');
        fs.symlinkSync(target, linked);
        expect(() => readBoundedRegularFile(linked)).toThrow();

        const oversized = path.join(root, 'oversized');
        fs.writeFileSync(oversized, 'x'.repeat(129));
        expect(() => readBoundedRegularFile(oversized)).toThrow('unsafe shape');
    });
});
