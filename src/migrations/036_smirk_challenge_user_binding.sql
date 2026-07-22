-- Bind Smirk authentication nonces to a stable authenticated user, not merely to the
-- public Socket.IO id that Tavern/match state broadcasts to other players.

ALTER TABLE smirk_challenges
    ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;

-- Challenges are five-minute ephemeral nonces. Invalidate any nonce issued by the old,
-- socket-only application before making the stable binding mandatory; clients simply retry.
DELETE FROM smirk_challenges WHERE user_id IS NULL;

ALTER TABLE smirk_challenges
    ALTER COLUMN user_id SET NOT NULL;

-- Socket ownership is an authentication relation throughout the paid-play code. Refuse to
-- continue an upgrade with ambiguous historical rows, then make that invariant structural.
DO $$
BEGIN
    IF EXISTS (
        SELECT socket_id
        FROM users
        WHERE socket_id IS NOT NULL
        GROUP BY socket_id
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'cannot enforce unique socket ownership: duplicate users.socket_id rows exist'
            USING ERRCODE = '23505';
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_socket_id_unique_nonnull
    ON users (socket_id)
    WHERE socket_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_smirk_challenges_user_active
    ON smirk_challenges (user_id, expires_at)
    WHERE used = FALSE;
