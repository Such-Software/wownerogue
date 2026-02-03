-- Chat Moderation Migration
-- Adds moderation capabilities to chat system

-- Add moderation fields to chat_messages
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS player_id VARCHAR(10);
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deleted_by VARCHAR(255);
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS delete_reason VARCHAR(255);

-- Index for non-deleted messages
CREATE INDEX IF NOT EXISTS idx_chat_messages_active
ON chat_messages(created_at DESC)
WHERE deleted_at IS NULL;

-- Add chat ban fields to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS chat_banned BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS chat_banned_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS chat_banned_reason VARCHAR(255);

-- Seed initial messages (only insert if table is empty or no system messages exist)
-- These give context and make the chat feel alive on fresh deploy
INSERT INTO chat_messages (socket_id, username, player_id, message, message_type, created_at)
SELECT 'system', 'SERVER', 'SERVER', msg, 'system', ts
FROM (VALUES
    ('Welcome to Wownerogue! Use arrow keys or WASD to move.', NOW() - INTERVAL '1 hour'),
    ('Escape the dungeon to win. Collect treasure for bonus payout!', NOW() - INTERVAL '59 minutes'),
    ('Watch out for monsters - they''re fast!', NOW() - INTERVAL '58 minutes'),
    ('Type /help for commands.', NOW() - INTERVAL '57 minutes'),
    ('Good luck and have fun!', NOW() - INTERVAL '56 minutes')
) AS seed_data(msg, ts)
WHERE NOT EXISTS (
    SELECT 1 FROM chat_messages WHERE socket_id = 'system' LIMIT 1
);

-- Comment on new columns
COMMENT ON COLUMN chat_messages.user_id IS 'Reference to users table for registered users';
COMMENT ON COLUMN chat_messages.player_id IS 'Display ID like PiMjKP shown in chat';
COMMENT ON COLUMN chat_messages.deleted_at IS 'Soft delete timestamp for moderation';
COMMENT ON COLUMN chat_messages.deleted_by IS 'Admin who deleted the message';
COMMENT ON COLUMN chat_messages.delete_reason IS 'Reason for deletion';
COMMENT ON COLUMN users.chat_banned IS 'Whether user is banned from chat';
COMMENT ON COLUMN users.chat_banned_at IS 'When the chat ban was applied';
COMMENT ON COLUMN users.chat_banned_reason IS 'Reason for chat ban';
