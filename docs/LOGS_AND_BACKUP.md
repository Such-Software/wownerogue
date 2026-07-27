# Logs and Backup

Operational reference for application logs and PostgreSQL backups in a production deployment.

---

## Application Logs

The server has no logging library and writes no log files. All diagnostics go to stdout and stderr,
so under systemd they land in the journal of the unit that started the process. Log retention is
therefore a journald configuration question, not an application one.

The repository ships two application units in `scripts/deploy/`: `wownerogue.service` (Wownero
mainnet instance) and `monerogue.service` (Monero stagenet instance).

### Viewing Logs

```bash
# All logs for a unit
journalctl -u wownerogue

# Follow live
journalctl -u wownerogue -f

# Last 100 lines
journalctl -u wownerogue -n 100

# Since today
journalctl -u wownerogue --since today

# A specific time range
journalctl -u wownerogue --since "2026-01-01" --until "2026-01-15"

# Errors only
journalctl -u wownerogue -p err

# Export for offline analysis
journalctl -u wownerogue --since "2026-01-01" > wownerogue-jan.log
```

The same commands work for `monerogue`, the wallet-RPC units, and the backup unit.

### Journal Retention

Journald limits apply to the whole journal, not to an individual unit, so these settings bound
every service on the host. Create a drop-in such as `/etc/systemd/journald.conf.d/limits.conf`:

```ini
[Journal]
# Total disk budget for all journals
SystemMaxUse=500M
# Size cap per journal file
SystemMaxFileSize=50M
# Discard entries older than this
MaxRetentionSec=30day
Compress=yes
```

Apply it:

```bash
sudo mkdir -p /etc/systemd/journald.conf.d/
sudo install -m 0644 limits.conf /etc/systemd/journald.conf.d/limits.conf
sudo systemctl restart systemd-journald
```

Journald is a rolling operational log, not an audit archive. Records that must survive log
rotation belong in the database. Accounting events are exported through the durable outbox
described in [FINANCIAL_EVENT_EXPORT.md](./FINANCIAL_EVENT_EXPORT.md).

---

## PostgreSQL Backups

### The Validated Backup Job

`scripts/deploy/wowngeon-db-backup.sh`, with its `wowngeon-db-backup.service` and
`wowngeon-db-backup.timer` units, is the production backup path. Each run:

- Dumps every database named in the script's loop. The shipped list is `wownerogue` and
  `monerogue`; a single-instance operator edits that loop to match the databases actually present.
- Writes custom-format dumps (`pg_dump --format=custom --no-owner`) to a temporary file, verifies
  the catalog with `pg_restore --list`, sets mode `0600`, then renames into place, so a reader never
  observes a partial dump under its final name.
- Records a SHA-256 sidecar next to each dump, also mode `0600`.
- Deletes dumps and sidecars older than `BACKUP_RETENTION_DAYS`, and stale `.tmp` files older than
  one day.

Configuration comes from two environment variables:

| Variable | Default | Behaviour |
| --- | --- | --- |
| `BACKUP_ROOT` | `/var/backups/wowngeon/daily` | The script refuses to run against any other value. Changing the destination requires a reviewed change to the script itself. |
| `BACKUP_RETENTION_DAYS` | `14` | Must be a positive integer. The service unit sets it explicitly to `14`. |

The script also exits if `BACKUP_ROOT` does not exist or is a symlink, so a misconfigured or
tampered path fails loudly instead of writing dumps somewhere unexpected.

Retention is deliberately short because this directory sits on the same disk as the database and
exists for fast local recovery. Long-horizon history is the job of an independent, separately
encrypted off-host archive, which the operator configures according to their recovery policy.

The service unit runs as `postgres` with `UMask=0077` and a hardened sandbox: `ProtectSystem=strict`
with `ReadWritePaths=/var/backups/wowngeon/daily` as the only writable location, an empty capability
bounding set, and `RestrictAddressFamilies=AF_UNIX` so the job can reach the local PostgreSQL socket
and nothing on the network. Because it authenticates as the `postgres` OS user over that socket, it
needs no database password and reads no application `.env` file.

The timer fires daily at 03:20 local time with a randomized delay of up to 20 minutes, and
`Persistent=true` so a run missed while the host was off happens at the next boot.

### Installation

Install these artifacts through the operator's reviewed change process rather than from the runtime
release directory, matching the boundary described in [DEPLOY.md](./DEPLOY.md). The service unit
expects the script at `/usr/local/sbin/wowngeon-db-backup`.

```bash
# Backup destination, owned by the database user only
sudo install -d -o postgres -g postgres -m 0700 /var/backups/wowngeon/daily

# Script and units
sudo install -o root -g root -m 0755 \
    scripts/deploy/wowngeon-db-backup.sh /usr/local/sbin/wowngeon-db-backup
sudo install -o root -g root -m 0644 \
    scripts/deploy/wowngeon-db-backup.service /etc/systemd/system/
sudo install -o root -g root -m 0644 \
    scripts/deploy/wowngeon-db-backup.timer /etc/systemd/system/

sudo systemctl daemon-reload
sudo systemctl enable --now wowngeon-db-backup.timer

# Confirm the schedule
systemctl list-timers wowngeon-db-backup.timer
```

### Running a Backup on Demand

```bash
sudo systemctl start wowngeon-db-backup.service
journalctl -u wowngeon-db-backup.service -n 50
ls -lh /var/backups/wowngeon/daily/
```

Dumps are named `<database>-<UTC timestamp>.dump`, for example
`wownerogue-20260726T032013Z.dump`.

### Verifying a Backup

Check integrity before trusting a dump:

```bash
cd /var/backups/wowngeon/daily
sudo -u postgres sha256sum -c wownerogue-20260726T032013Z.dump.sha256
sudo -u postgres pg_restore --list wownerogue-20260726T032013Z.dump | head
```

### Restoring

Custom-format dumps restore with `pg_restore`, not `psql`. Restore into a scratch database first
and promote only after inspection.

```bash
# Restore into a fresh database
sudo -u postgres createdb -O wownerogue wownerogue_restore
sudo -u postgres pg_restore --no-owner --exit-on-error \
    --dbname=wownerogue_restore /var/backups/wowngeon/daily/wownerogue-20260726T032013Z.dump

# Sanity-check the restored copy
sudo -u postgres psql -d wownerogue_restore -c "SELECT COUNT(*) FROM users;"
sudo -u postgres psql -d wownerogue_restore -c \
    "SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1;"

# Discard the scratch copy when finished
sudo -u postgres dropdb wownerogue_restore
```

Restoring over a live database requires stopping the application unit first, because the server
runs migrations at startup and holds pooled connections:

```bash
sudo systemctl stop wownerogue
sudo -u postgres pg_restore --no-owner --clean --if-exists --exit-on-error \
    --dbname=wownerogue /var/backups/wowngeon/daily/wownerogue-20260726T032013Z.dump
sudo systemctl start wownerogue
```

Rehearse this path on a restored copy periodically. A backup that has never been restored is an
untested assumption. The disposable clone migration gate in
[CLONE_MIGRATIONS.md](./CLONE_MIGRATIONS.md) exercises restore plus the full migration set and is
the natural place to combine the two rehearsals.

---

## Simple Single-Database Alternative

`scripts/backup_db.sh` is a smaller portable script for operators who do not want the hardened
job: one database, gzipped plain SQL, credentials from the environment. Its companion units are
`scripts/wownerogue-backup.service` and `scripts/wownerogue-backup.timer` (daily at 03:00 with up
to 15 minutes of jitter).

| Variable | Default |
| --- | --- |
| `DB_NAME` | `wownerogue` |
| `DB_USER` | `postgres` |
| `DB_HOST` | `localhost` |
| `DB_PORT` | `5432` |
| `BACKUP_DIR` | `/var/backups/wownerogue` |
| `RETENTION_DAYS` | `30` |

The first five match the application's own database settings in `src/.env.example`, so the service
unit loads that file directly with `EnvironmentFile=`. Each run writes
`<DB_NAME>_<YYYYmmdd_HHMMSS>.sql.gz`, refreshes a `<DB_NAME>_LATEST.sql.gz` symlink, deletes a
partial file if `pg_dump` fails, and prunes dumps older than `RETENTION_DAYS`.

Because it connects over TCP as a database role, it needs working credentials, typically a
`~/.pgpass` entry or `PGPASSWORD` in the unit environment. Plain-SQL dumps restore with `psql`:

```bash
gunzip -c /var/backups/wownerogue/wownerogue_LATEST.sql.gz \
    | psql -h "$DB_HOST" -U "$DB_USER" -d wownerogue_restore
```

A cron equivalent, for hosts without systemd timers:

```cron
0 3 * * * cd /var/www/wownerogue/src && set -a && . ./.env && set +a && /var/www/wownerogue/scripts/backup_db.sh >> /var/log/wownerogue-backup.log 2>&1
```

---

## What Database Backups Do Not Cover

A database dump alone does not restore a working instance. Back up these separately, with access
controls at least as strict as the dumps:

- **Wallet keyfiles and their passwords.** The wallet-RPC units keep wallet state under
  `/var/lib/<instance>-wallet` (see `scripts/deploy/wownero-wallet-rpc.conf.example`). Losing these
  loses the funds; the database records balances, never keys.
- **Instance secrets.** `/etc/wownerogue/app.env`, `/etc/wownerogue/wallet-rpc.env`, and the
  equivalents for other instances. `src/.env.example` is the full annotated template for what these
  contain.
- **Reverse proxy and TLS configuration**, which lives outside the application tree.

Keep at least one copy of everything above off the host that runs the database. Same-disk backups
protect against operator error, not against losing the machine.

---

## Monitoring Checklist

- Timer is active and scheduled: `systemctl list-timers wowngeon-db-backup.timer`
- Last run succeeded: `systemctl status wowngeon-db-backup.service`
- Recent dumps exist and are non-empty: `ls -lh /var/backups/wowngeon/daily/ | tail`
- Checksums verify: `sha256sum -c` on the newest sidecar
- Dump sizes track database growth rather than dropping sharply
- Backup volume has headroom: `df -h /var/backups`
- Off-host copies are current
- A restore rehearsal has happened recently enough to be meaningful
