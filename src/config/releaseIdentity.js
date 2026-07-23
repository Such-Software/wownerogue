const fs = require('fs');
const path = require('path');

const RELEASE_ID_PATTERN = /^git-([0-9a-f]{12})$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const MAX_FILE_BYTES = 128;

function readBoundedRegularFile(filePath) {
    const descriptor = fs.openSync(
        filePath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    try {
        const before = fs.fstatSync(descriptor);
        if (
            !before.isFile()
            || before.nlink !== 1
            || (before.mode & 0o222) !== 0
            || before.size < 1
            || before.size > MAX_FILE_BYTES
        ) {
            throw new Error('release identity file has unsafe shape');
        }
        const value = fs.readFileSync(descriptor, { encoding: 'utf8' }).trim();
        const after = fs.fstatSync(descriptor);
        if (
            before.dev !== after.dev
            || before.ino !== after.ino
            || before.size !== after.size
            || before.mtimeMs !== after.mtimeMs
        ) {
            throw new Error('release identity file changed while it was read');
        }
        return value;
    } finally {
        fs.closeSync(descriptor);
    }
}

function unverifiedIdentity() {
    return Object.freeze({ verified: false, id: null, commit: null });
}

function loadReleaseIdentity(options = {}) {
    const production = options.production === undefined
        ? process.env.NODE_ENV === 'production'
        : Boolean(options.production);
    const releaseRoot = options.releaseRoot || path.resolve(__dirname, '..', '..');

    try {
        const id = readBoundedRegularFile(path.join(releaseRoot, '.release-id'));
        const commit = readBoundedRegularFile(path.join(releaseRoot, '.release-commit'));
        const idMatch = id.match(RELEASE_ID_PATTERN);
        if (!idMatch || !COMMIT_PATTERN.test(commit) || idMatch[1] !== commit.slice(0, 12)) {
            throw new Error('release identity files disagree');
        }
        return Object.freeze({ verified: true, id, commit });
    } catch (error) {
        if (production) {
            throw new Error('production release identity is absent or invalid', { cause: error });
        }
        return unverifiedIdentity();
    }
}

module.exports = {
    COMMIT_PATTERN,
    RELEASE_ID_PATTERN,
    loadReleaseIdentity,
    readBoundedRegularFile
};
