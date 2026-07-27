-- Chat History Migration
-- Persistent storage for chat messages

-- Create chat_messages table
CREATE TABLE IF NOT EXISTS chat_messages (
    id SERIAL PRIMARY KEY,
    socket_id VARCHAR(255),
    username VARCHAR(50),
    message TEXT NOT NULL,
    message_type VARCHAR(20) DEFAULT 'chat', -- 'chat', 'system', 'event'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for efficient retrieval of recent messages
CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at DESC);

-- Optional: Index for user-specific history lookups
CREATE INDEX IF NOT EXISTS idx_chat_messages_socket_id ON chat_messages(socket_id);

-- Comment on table
COMMENT ON TABLE chat_messages IS 'Stores chat message history for display to new users';
COMMENT ON COLUMN chat_messages.message_type IS 'Type of message: chat (user), system (server), event (game events)';
