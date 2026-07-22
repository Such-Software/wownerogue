-- Durable, versioned snapshots for nonterminal solo games during a graceful process restart.
--
-- The existing suspended-game manager is intentionally an in-memory reconnect cache. A systemd
-- restart destroys that cache, so a controlled shutdown must first anchor the exact runtime state
-- to the durable game/user identity. Snapshots never authorize a payout or alter accepted economic
-- terms; they only allow the same active run to be reconstructed before public admission resumes.

CREATE TABLE IF NOT EXISTS solo_restart_snapshots (
    game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    dungeon_seed VARCHAR(50) NOT NULL,
    snapshot_version SMALLINT NOT NULL,
    original_socket_id VARCHAR(255) NOT NULL,
    payment_monitoring_active BOOLEAN NOT NULL DEFAULT FALSE,
    state JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT solo_restart_snapshot_version_check CHECK (snapshot_version = 1),
    CONSTRAINT solo_restart_snapshot_state_object_check CHECK (jsonb_typeof(state) = 'object'),
    CONSTRAINT solo_restart_snapshot_user_once UNIQUE (user_id),
    CONSTRAINT solo_restart_snapshot_game_seed_once UNIQUE (dungeon_seed)
);

CREATE INDEX IF NOT EXISTS idx_solo_restart_snapshots_created
    ON solo_restart_snapshots (created_at);

-- A terminal game can never retain a resumable state. Keeping this invariant in PostgreSQL makes
-- every completion path (including future/manual paths) clean up the snapshot automatically.
CREATE OR REPLACE FUNCTION delete_terminal_solo_restart_snapshot()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM 'active' THEN
        DELETE FROM solo_restart_snapshots WHERE game_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_games_delete_terminal_restart_snapshot ON games;
CREATE TRIGGER trg_games_delete_terminal_restart_snapshot
    AFTER UPDATE OF status ON games
    FOR EACH ROW
    WHEN (NEW.status IS DISTINCT FROM 'active')
    EXECUTE FUNCTION delete_terminal_solo_restart_snapshot();
