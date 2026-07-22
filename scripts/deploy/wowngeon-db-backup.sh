#!/bin/sh
set -eu

# Atomic daily custom-format dumps for both production instances. Run as the postgres OS user;
# the service unit grants write access only to this dedicated directory.
backup_root=${BACKUP_ROOT:-/var/backups/wowngeon/daily}
retention_days=${BACKUP_RETENTION_DAYS:-14}
stamp=$(/usr/bin/date -u +%Y%m%dT%H%M%SZ)

[ "$backup_root" = /var/backups/wowngeon/daily ] || {
    echo "Refusing an unapproved backup root: $backup_root" >&2
    exit 64
}
case "$retention_days" in
    ''|*[!0-9]*) echo "BACKUP_RETENTION_DAYS must be a positive integer" >&2; exit 64 ;;
esac
[ "$retention_days" -gt 0 ] || { echo "BACKUP_RETENTION_DAYS must be positive" >&2; exit 64; }
[ -d "$backup_root" ] && [ ! -L "$backup_root" ] || {
    echo "Backup root is missing or is a symlink" >&2
    exit 66
}

for database_name in wownerogue monerogue; do
    final_path="${backup_root}/${database_name}-${stamp}.dump"
    temporary_path="${backup_root}/.${database_name}-${stamp}.dump.tmp"
    checksum_path="${final_path}.sha256"
    checksum_temporary="${checksum_path}.tmp"

    /usr/bin/pg_dump --format=custom --no-owner --file="$temporary_path" "$database_name"
    /usr/bin/pg_restore --list "$temporary_path" >/dev/null
    /usr/bin/chmod 0600 "$temporary_path"
    /usr/bin/mv "$temporary_path" "$final_path"

    (
        cd "$backup_root"
        /usr/bin/sha256sum "$(/usr/bin/basename "$final_path")"
    ) >"$checksum_temporary"
    /usr/bin/chmod 0600 "$checksum_temporary"
    /usr/bin/mv "$checksum_temporary" "$checksum_path"
done

# Local copies are an operational convenience, not the retention archive. The independently
# encrypted restic vault keeps GFS history; bound this same-disk directory so it cannot fill `/`.
/usr/bin/find "$backup_root" -maxdepth 1 -type f \
    \( -name 'monerogue-*.dump' -o -name 'monerogue-*.dump.sha256' \
       -o -name 'wownerogue-*.dump' -o -name 'wownerogue-*.dump.sha256' \) \
    -mtime "+$retention_days" -delete
/usr/bin/find "$backup_root" -maxdepth 1 -type f -name '.*.tmp' -mtime +1 -delete
