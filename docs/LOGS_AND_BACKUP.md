# Logs and Backup Configuration

This document covers log management and database backup strategies for production deployment.

---

## Log Management with systemd/journald

When running as a systemd service, logs automatically go to journald which handles rotation. Configure retention limits as needed.

### Configure Journal Limits

Create `/etc/systemd/journald.conf.d/wownerogue.conf`:

```ini
[Journal]
# Max disk usage for all journals
SystemMaxUse=500M
# Max size per journal file  
SystemMaxFileSize=50M
# Keep logs for 30 days max
MaxRetentionSec=30day
# Compress older entries
Compress=yes
```

Apply the configuration:

```bash
sudo mkdir -p /etc/systemd/journald.conf.d/
sudo nano /etc/systemd/journald.conf.d/wownerogue.conf
# paste the config above
sudo systemctl restart systemd-journald
```

### Viewing Logs

```bash
# All logs for the service
journalctl -u wownerogue

# Follow live (like tail -f)
journalctl -u wownerogue -f

# Last 100 lines
journalctl -u wownerogue -n 100

# Logs since today
journalctl -u wownerogue --since today

# Logs from a specific time range
journalctl -u wownerogue --since "2025-12-01" --until "2025-12-15"

# Export to file for analysis
journalctl -u wownerogue --since "2025-12-01" > wownerogue-dec.log

# Show only errors
journalctl -u wownerogue -p err
```

---

## PostgreSQL Automated Backups

### Backup Script

The backup script is located at `scripts/backup_db.sh`. It reads database credentials from environment variables (same as your `.env` file).

**Required environment variables:**
- `DB_NAME` - Database name (default: `wownerogue`)
- `DB_USER` - Database user
- `DB_HOST` - Database host (default: `localhost`)
- `BACKUP_DIR` - Where to store backups (default: `/var/backups/wownerogue`)
- `RETENTION_DAYS` - How long to keep backups (default: `30`)

### systemd Timer (Recommended)

Use systemd timers for scheduled backups. Copy the service files to `/etc/systemd/system/`:

1. **Service file** (`wownerogue-backup.service`):
   - Located at `scripts/wownerogue-backup.service`
   - Runs the backup script with environment from your `.env` file

2. **Timer file** (`wownerogue-backup.timer`):
   - Located at `scripts/wownerogue-backup.timer`
   - Runs daily at 3 AM with random delay up to 15 minutes

### Setup Commands

```bash
# Create backup directory
sudo mkdir -p /var/backups/wownerogue
sudo chown $(whoami):$(whoami) /var/backups/wownerogue

# Make backup script executable
chmod +x scripts/backup_db.sh

# Copy systemd files
sudo cp scripts/wownerogue-backup.service /etc/systemd/system/
sudo cp scripts/wownerogue-backup.timer /etc/systemd/system/

# Edit the service file to point to your installation path
sudo nano /etc/systemd/system/wownerogue-backup.service
# Update WorkingDirectory and EnvironmentFile paths

# Reload systemd and enable timer
sudo systemctl daemon-reload
sudo systemctl enable wownerogue-backup.timer
sudo systemctl start wownerogue-backup.timer

# Verify timer is scheduled
systemctl list-timers | grep wownerogue
```

### Manual Backup

```bash
# Run backup manually
cd /path/to/wownerogue/src
source .env
../scripts/backup_db.sh

# Or via systemd
sudo systemctl start wownerogue-backup.service
journalctl -u wownerogue-backup.service -n 20
```

### Restore from Backup

```bash
# List available backups
ls -lh /var/backups/wownerogue/

# Restore a specific backup (replace filename with actual backup)
gunzip -c /var/backups/wownerogue/wownerogue_20251222_030000.sql.gz | psql -h $DB_HOST -U $DB_USER -d $DB_NAME

# Or with explicit values
gunzip -c /var/backups/wownerogue/wownerogue_20251222_030000.sql.gz | psql -h localhost -U your_user -d wownerogue
```

---

## Alternative: Cron-based Backups

If you prefer cron over systemd timers:

```bash
# Edit crontab
crontab -e

# Add this line (runs daily at 3 AM)
0 3 * * * cd /path/to/wownerogue/src && source .env && ../scripts/backup_db.sh >> /var/log/wownerogue-backup.log 2>&1
```

---

## Backup Verification

Periodically verify your backups work:

```bash
# Create a test database
createdb -h localhost -U $DB_USER wownerogue_test

# Restore backup to test database
gunzip -c /var/backups/wownerogue/wownerogue_LATEST.sql.gz | psql -h localhost -U $DB_USER -d wownerogue_test

# Verify data
psql -h localhost -U $DB_USER -d wownerogue_test -c "SELECT COUNT(*) FROM users;"

# Drop test database
dropdb -h localhost -U $DB_USER wownerogue_test
```

---

## Monitoring Backup Health

Add to your monitoring checklist:

- [ ] Check backup timer is active: `systemctl status wownerogue-backup.timer`
- [ ] Verify recent backups exist: `ls -la /var/backups/wownerogue/ | tail -5`
- [ ] Check backup sizes are reasonable (not 0 bytes)
- [ ] Periodically test restore process
- [ ] Monitor disk space: `df -h /var/backups`
