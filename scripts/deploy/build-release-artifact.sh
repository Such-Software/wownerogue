#!/usr/bin/env bash
set -Eeuo pipefail

# Build a deterministic, runtime-only Wowngeon release artifact from one clean Git commit.
# This script deliberately does not install dependencies, read environment files, contact a
# deployment host, or activate a release. See --help and docs/DEPLOY.md for the operator gates.

umask 077

die() {
    printf 'build-release-artifact: %s\n' "$*" >&2
    exit 1
}

usage() {
    cat <<'EOF'
Usage: scripts/deploy/build-release-artifact.sh [options]

Options:
  --ref REF             Git commit-ish to archive (default: HEAD)
  --release-id ID       Destination directory name inside the archive
                        (default: git-<12-character commit prefix>)
  --output-dir DIR      Existing or new non-symlink output directory
                        (default: <repository>/dist/releases)
  -h, --help            Show this help

The builder fails unless tracked files and non-ignored untracked files are clean. It archives only
the runtime allowlist (LICENSE, html/**, and the guarded runtime subset of src/**) from the selected
commit, rejects symlinks/gitlinks and non-example .env files anywhere in that commit, and refuses
to overwrite an artifact or checksum. Repeating the command for the same commit, release ID, and
toolchain produces byte-identical .tar.gz output.
EOF
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "required command is unavailable: $1"
}

for required_command in git tar gzip sha256sum mktemp install ln rm chmod cat dirname basename find sort xargs node; do
    require_command "$required_command"
done

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null) \
    || die 'script is not inside a Git worktree'
repo_root=$(CDPATH= cd -- "$repo_root" && pwd -P)

ref=HEAD
release_id=''
output_dir="$repo_root/dist/releases"

while (($# > 0)); do
    case "$1" in
        --ref)
            (($# >= 2)) || die '--ref requires a value'
            ref=$2
            shift 2
            ;;
        --release-id)
            (($# >= 2)) || die '--release-id requires a value'
            release_id=$2
            shift 2
            ;;
        --output-dir)
            (($# >= 2)) || die '--output-dir requires a value'
            output_dir=$2
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            die "unknown argument: $1"
            ;;
    esac
done

# A commit name cannot describe uncommitted candidate content. Refuse both tracked changes and
# non-ignored untracked additions instead of silently producing an artifact different from the
# reviewed tree. Ignored files such as local .env and node_modules are never read or archived.
if [[ -n "$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all)" ]]; then
    die 'worktree is dirty; commit or remove every tracked/untracked candidate change first'
fi

commit=$(git -C "$repo_root" rev-parse --verify "${ref}^{commit}" 2>/dev/null) \
    || die "ref does not resolve to a commit: $ref"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || die 'resolved commit is not a full SHA-1 object ID'

if [[ -z "$release_id" ]]; then
    release_id="git-${commit:0:12}"
fi
[[ "$release_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$ ]] \
    || die 'release ID must be 1-96 safe characters and start with an alphanumeric character'
[[ "$release_id" != '.' && "$release_id" != '..' ]] || die 'release ID cannot be dot or dot-dot'

if [[ -e "$output_dir" || -L "$output_dir" ]]; then
    [[ -d "$output_dir" && ! -L "$output_dir" ]] \
        || die 'output directory must be a real directory, not a symlink'
else
    install -d -m 0700 -- "$output_dir"
fi
output_dir=$(CDPATH= cd -- "$output_dir" && pwd -P)

artifact="$output_dir/${release_id}.tar.gz"
checksum="$artifact.sha256"
[[ ! -e "$artifact" && ! -L "$artifact" ]] || die "refusing to overwrite: $artifact"
[[ ! -e "$checksum" && ! -L "$checksum" ]] || die "refusing to overwrite: $checksum"

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/wowngeon-release.XXXXXXXX")
artifact_tmp=$(mktemp "$output_dir/.${release_id}.artifact.XXXXXXXX")
checksum_tmp=$(mktemp "$output_dir/.${release_id}.checksum.XXXXXXXX")
published=0
cleanup() {
    local status=$?
    if [[ "$published" != '1' ]]; then
        # Another same-ID builder may have won publication after both processes passed the
        # initial existence check. Remove a destination only while it is still our own hard link;
        # a losing builder must never unlink the winning builder's artifact or checksum.
        if [[ -e "$artifact" && "$artifact" -ef "$artifact_tmp" ]]; then
            rm -f -- "$artifact"
        fi
        if [[ -e "$checksum" && "$checksum" -ef "$checksum_tmp" ]]; then
            rm -f -- "$checksum"
        fi
    fi
    rm -f -- "$artifact_tmp" "$checksum_tmp"
    rm -rf -- "$work_dir"
    return "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

source_tar="$work_dir/runtime-source.tar"
stage_root="$work_dir/stage"
release_root="$stage_root/$release_id"
install -d -m 0700 -- "$release_root"

# Git trees can encode regular files, executables, symlinks, and gitlinks. Releases accept only
# the first two. This also validates path policy before tar is allowed to extract anything.
while IFS= read -r -d '' tree_entry; do
    metadata=${tree_entry%%$'\t'*}
    path=${tree_entry#*$'\t'}
    mode=${metadata%% *}

    [[ "$metadata" != "$path" ]] || die 'malformed Git tree entry'
    [[ "$mode" == '100644' || "$mode" == '100755' ]] \
        || die "tracked symlink, gitlink, or unsafe file mode is forbidden: $path"
    [[ "$path" != *$'\n'* && "$path" != *$'\r'* ]] \
        || die 'tracked filenames containing newline or carriage return are forbidden'
    [[ "$path" != /* && "$path" != ../* && "$path" != */../* && "$path" != */.. ]] \
        || die "unsafe tracked path: $path"
    [[ "/$path/" != *'/.git/'* && "/$path/" != *'/node_modules/'* ]] \
        || die "tracked VCS/dependency state is forbidden: $path"

    filename=$(basename -- "$path")
    case "$filename" in
        .env)
            die "tracked runtime environment file is forbidden: $path"
            ;;
        .env.*)
            [[ "$filename" == *.example ]] \
                || die "tracked non-example environment file is forbidden: $path"
            ;;
        .npmrc|.yarnrc|.netrc)
            die "tracked credential-capable configuration file is forbidden: $path"
            ;;
    esac
done < <(git -C "$repo_root" ls-tree -rz --full-tree "$commit")

# Production releases intentionally exclude source documentation, tests, root-level operator
# tooling/service units, and environment examples. Operational artifacts remain in the reviewed
# source/fleet repositories and must have their own pinned provenance; they are never made part of
# the application runtime merely because they share a Git commit.
runtime_pathspecs=(
    'LICENSE'
    'html'
    'src'
    ':(exclude)src/.env*'
    ':(glob,exclude)src/**/.env*'
    ':(exclude)src/scripts/pvp-capture.js'
    ':(exclude)src/scripts/stagenet-financial-canary.js'
    ':(exclude)src/scripts/setup_db.js'
    ':(exclude)src/scripts/smoke.js'
    ':(exclude)src/jest.config.js'
    ':(exclude)src/sim'
)
git -C "$repo_root" archive --format=tar "$commit" -- "${runtime_pathspecs[@]}" >"$source_tar"
source_hash=$(sha256sum "$source_tar")
source_hash=${source_hash%% *}
[[ "$source_hash" =~ ^[0-9a-f]{64}$ ]] || die 'could not calculate source archive SHA-256'

tar --extract --file="$source_tar" --directory="$release_root" --no-same-owner --no-same-permissions

runtime_roots=$(find "$release_root" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)
[[ "$runtime_roots" == $'LICENSE\nhtml\nsrc' ]] \
    || die 'runtime archive contains an unexpected or missing top-level path'
[[ -z "$(find "$release_root/src" -type f -name '.env*' -print -quit)" ]] \
    || die 'runtime archive contains a forbidden environment file or example'

for required_file in LICENSE src/index.js src/package.json src/package-lock.json \
        src/scripts/preflight.js src/scripts/migrate-disposable-clone.js html/index.html; do
    [[ -f "$release_root/$required_file" && ! -L "$release_root/$required_file" ]] \
        || die "required release file is absent or unsafe: $required_file"
done

# Keep the source package manifest useful to developers while exposing only runnable commands in
# the runtime artifact. This deterministic metadata-only rewrite does not change dependencies or
# lockfile resolution; the final runtime bytes are covered by .release-files.sha256 below.
node - "$release_root/src/package.json" <<'NODE'
'use strict';
const fs = require('fs');
const manifestPath = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const sourceScripts = manifest.scripts && typeof manifest.scripts === 'object'
    ? manifest.scripts
    : {};
const runtimeScripts = {};
for (const name of ['start', 'preflight', 'db:migrate:clone']) {
    if (typeof sourceScripts[name] !== 'string' || sourceScripts[name].trim().length === 0) {
        throw new Error(`required runtime package script is absent or empty: ${name}`);
    }
    runtimeScripts[name] = sourceScripts[name];
}
manifest.scripts = runtimeScripts;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
NODE

lock_hash=$(sha256sum "$release_root/src/package-lock.json")
lock_hash=${lock_hash%% *}
commit_epoch=$(git -C "$repo_root" show -s --format=%ct "$commit")
[[ "$commit_epoch" =~ ^[0-9]+$ ]] || die 'commit timestamp is invalid'

printf '%s\n' "$source_hash" >"$release_root/.release-source-sha256"
printf '%s\n' "$commit" >"$release_root/.release-commit"
printf '%s\n' "$release_id" >"$release_root/.release-id"
printf '%s\n' "$lock_hash" >"$release_root/.release-package-lock-sha256"
(
    cd "$release_root"
    find . -type f ! -path './.release-files.sha256' -print0 \
        | LC_ALL=C sort -z \
        | xargs -0 -r sha256sum --
) >"$release_root/.release-files.sha256"

# Normalize ownership, modes, ordering, timestamps, and gzip headers. Metadata files deliberately
# identify the prefix-free, runtime-allowlisted `git archive` hash; the sidecar identifies the
# final blob.
tar \
    --sort=name \
    --format=posix \
    --pax-option=delete=atime,delete=ctime \
    --mtime="@$commit_epoch" \
    --owner=0 --group=0 --numeric-owner \
    --mode='u+rwX,go+rX,go-w' \
    --directory="$stage_root" \
    --create --file=- "$release_id" \
    | gzip -n >"$artifact_tmp"

artifact_hash=$(sha256sum "$artifact_tmp")
artifact_hash=${artifact_hash%% *}
printf '%s  %s\n' "$artifact_hash" "$(basename -- "$artifact")" >"$checksum_tmp"

# Hard-link publication is atomic and refuses an existing destination even under a concurrent run.
ln -- "$artifact_tmp" "$artifact" || die "could not publish artifact without overwrite: $artifact"
if ! ln -- "$checksum_tmp" "$checksum"; then
    rm -f -- "$artifact"
    die "could not publish checksum without overwrite: $checksum"
fi
chmod 0600 -- "$artifact" "$checksum"
published=1

printf 'release_id=%s\ncommit=%s\nsource_sha256=%s\nartifact_sha256=%s\nartifact=%s\nchecksum=%s\n' \
    "$release_id" "$commit" "$source_hash" "$artifact_hash" "$artifact" "$checksum"
