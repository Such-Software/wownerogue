#!/bin/bash
# PostgreSQL backup script for Wownerogue
# Reads configuration from environment variables (set in .env or systemd service)

set -e

# Configuration with defaults
DB_NAME="${DB_NAME:-wownerogue}"
DB_USER="${DB_USER:-postgres}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/wownerogue}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

# Timestamp for filename
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/${DB_NAME}_${TIMESTAMP}.sql.gz"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

log "Starting backup of database '$DB_NAME' on $DB_HOST:$DB_PORT..."

# Perform backup with gzip compression
if pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" | gzip > "$BACKUP_FILE"; then
    BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    log "Backup completed successfully: $BACKUP_FILE ($BACKUP_SIZE)"
else
    log "ERROR: Backup failed!"
    rm -f "$BACKUP_FILE"  # Remove partial backup
    exit 1
fi

# Create a symlink to latest backup for easy access
ln -sf "$BACKUP_FILE" "$BACKUP_DIR/${DB_NAME}_LATEST.sql.gz"

# Delete backups older than retention period
log "Cleaning up backups older than $RETENTION_DAYS days..."
DELETED_COUNT=$(find "$BACKUP_DIR" -name "${DB_NAME}_[0-9]*.sql.gz" -mtime +$RETENTION_DAYS -delete -print | wc -l)
log "Deleted $DELETED_COUNT old backup(s)"

# Show disk usage
TOTAL_SIZE=$(du -sh "$BACKUP_DIR" | cut -f1)
BACKUP_COUNT=$(find "$BACKUP_DIR" -name "${DB_NAME}_[0-9]*.sql.gz" | wc -l)
log "Backup directory: $BACKUP_DIR ($TOTAL_SIZE, $BACKUP_COUNT backups)"

log "Backup process complete."
