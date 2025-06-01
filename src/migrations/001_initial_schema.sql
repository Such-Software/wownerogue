-- Wowgue Database Schema
-- PostgreSQL migration script

-- Drop existing tables if they exist (for clean setup)
DROP TABLE IF EXISTS payouts CASCADE;
DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS games CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- Create users table
-- Tracks user accounts, credits, and statistics
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    socket_id VARCHAR(255),
    ip_address INET,
    username VARCHAR(50),
    payout_address VARCHAR(95), -- Monero/Wownero address for payouts
    credits INTEGER DEFAULT 0, -- For PAID_CREDITS mode
    total_games_played INTEGER DEFAULT 0,
    total_games_won INTEGER DEFAULT 0,
    total_amount_paid BIGINT DEFAULT 0, -- In atomic units
    total_amount_won BIGINT DEFAULT 0, -- In atomic units
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create index on socket_id for quick lookups
CREATE INDEX idx_users_socket_id ON users(socket_id);
CREATE INDEX idx_users_ip_address ON users(ip_address);

-- Create games table
-- Tracks individual game sessions and outcomes
CREATE TABLE games (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    socket_id VARCHAR(255),
    game_mode VARCHAR(20) NOT NULL, -- PAID_SINGLE, PAID_CREDITS, FREE
    payment_id INTEGER, -- Reference to payment (for PAID_SINGLE)
    start_block_height INTEGER,
    end_block_height INTEGER,
    status VARCHAR(20) DEFAULT 'waiting', -- waiting, active, won, lost, expired
    outcome VARCHAR(20), -- escaped, caught_by_monster, expired, treasure_found
    treasure_found BOOLEAN DEFAULT FALSE,
    dungeon_seed VARCHAR(50),
    moves_made INTEGER DEFAULT 0,
    duration_seconds INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP
);

-- Create indexes for games
CREATE INDEX idx_games_user_id ON games(user_id);
CREATE INDEX idx_games_socket_id ON games(socket_id);
CREATE INDEX idx_games_status ON games(status);
CREATE INDEX idx_games_start_block ON games(start_block_height);

-- Create payments table
-- Tracks incoming payments from players
CREATE TABLE payments (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    socket_id VARCHAR(255),
    subaddress VARCHAR(95) NOT NULL, -- MoneroPay subaddress
    expected_amount BIGINT NOT NULL, -- In atomic units
    received_amount BIGINT DEFAULT 0, -- In atomic units
    payment_type VARCHAR(20) NOT NULL, -- single_game, credits_package
    status VARCHAR(20) DEFAULT 'pending', -- pending, confirmed, expired
    description TEXT,
    tx_hash VARCHAR(64),
    block_height INTEGER,
    confirmations INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    confirmed_at TIMESTAMP,
    expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '2 hours')
);

-- Create indexes for payments
CREATE INDEX idx_payments_subaddress ON payments(subaddress);
CREATE INDEX idx_payments_user_id ON payments(user_id);
CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_payments_tx_hash ON payments(tx_hash);

-- Create payouts table
-- Tracks outgoing payments to winners
CREATE TABLE payouts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    game_id INTEGER REFERENCES games(id),
    payout_address VARCHAR(95) NOT NULL,
    amount BIGINT NOT NULL, -- In atomic units
    status VARCHAR(20) DEFAULT 'pending', -- pending, batched, completed, failed
    batch_id VARCHAR(50), -- Groups payouts that are sent together
    tx_hash VARCHAR(64),
    fee BIGINT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP
);

-- Create indexes for payouts
CREATE INDEX idx_payouts_user_id ON payouts(user_id);
CREATE INDEX idx_payouts_game_id ON payouts(game_id);
CREATE INDEX idx_payouts_status ON payouts(status);
CREATE INDEX idx_payouts_batch_id ON payouts(batch_id);

-- Create triggers to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Create function to get user statistics
CREATE OR REPLACE FUNCTION get_user_stats(user_socket_id VARCHAR(255))
RETURNS TABLE (
    total_games INTEGER,
    games_won INTEGER,
    win_rate DECIMAL(5,2),
    total_paid BIGINT,
    total_won BIGINT,
    net_profit BIGINT,
    credits_remaining INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        u.total_games_played,
        u.total_games_won,
        CASE 
            WHEN u.total_games_played > 0 
            THEN ROUND((u.total_games_won::DECIMAL / u.total_games_played) * 100, 2)
            ELSE 0.00 
        END as win_rate,
        u.total_amount_paid,
        u.total_amount_won,
        (u.total_amount_won - u.total_amount_paid) as net_profit,
        u.credits
    FROM users u
    WHERE u.socket_id = user_socket_id;
END;
$$ LANGUAGE plpgsql;

-- Insert default admin user for testing
INSERT INTO users (socket_id, username, ip_address) 
VALUES ('admin', 'admin', '127.0.0.1');

-- Create view for active games
CREATE VIEW active_games AS
SELECT 
    g.id,
    g.socket_id,
    u.username,
    g.game_mode,
    g.status,
    g.start_block_height,
    g.treasure_found,
    g.moves_made,
    g.created_at
FROM games g
JOIN users u ON g.user_id = u.id
WHERE g.status IN ('waiting', 'active')
ORDER BY g.created_at DESC;

-- Create view for pending payouts
CREATE VIEW pending_payouts AS
SELECT 
    p.id,
    p.user_id,
    u.username,
    p.payout_address,
    p.amount,
    p.status,
    p.created_at,
    g.outcome as game_outcome
FROM payouts p
JOIN users u ON p.user_id = u.id
LEFT JOIN games g ON p.game_id = g.id
WHERE p.status = 'pending'
ORDER BY p.created_at ASC;
