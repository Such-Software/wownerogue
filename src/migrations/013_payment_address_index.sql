-- Add address_index column to payments table
-- Stores the wallet subaddress index so payment monitoring can be fully
-- restored from DB after server restart (needed for get_transfers RPC call)

ALTER TABLE payments ADD COLUMN IF NOT EXISTS address_index INTEGER;
