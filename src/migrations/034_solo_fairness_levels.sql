-- Migration 034: versioned, all-depth solo fairness manifest
--
-- `layout_fingerprint` remains the legacy level-one alias. New games persist one
-- generator/fingerprint-versioned entry for every depth advertised at game creation.
ALTER TABLE games
    ADD COLUMN IF NOT EXISTS generator_version VARCHAR(64),
    ADD COLUMN IF NOT EXISTS layout_fingerprints JSONB;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'games_layout_fingerprints_array_check'
    ) THEN
        ALTER TABLE games
            ADD CONSTRAINT games_layout_fingerprints_array_check
            CHECK (layout_fingerprints IS NULL OR jsonb_typeof(layout_fingerprints) = 'array')
            NOT VALID;
    END IF;
END $$;
