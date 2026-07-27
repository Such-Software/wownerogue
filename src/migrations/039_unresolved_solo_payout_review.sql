-- Migration 039: Preserve unresolved solo-win payout obligations for manual review.
--
-- completeGame records a paid win even when its committed user identity cannot be resolved. That
-- row must remain a durable, non-dispatchable obligation rather than rolling back the terminal
-- game transaction. Migration 038's first constraint omitted this explicit review reason.
--
-- This forward replacement deliberately changes only the accepted row shape. The immutable
-- payout trigger continues to exclude solo_winner_identity_review from its saved-address claim
-- exception, so an operator cannot accidentally turn an ownerless obligation into a transfer.

ALTER TABLE payouts
    DROP CONSTRAINT IF EXISTS payouts_no_address_review_shape;

ALTER TABLE payouts
    ADD CONSTRAINT payouts_no_address_review_shape CHECK (
        payout_address <> 'PENDING_NO_ADDRESS'
        OR (
            status = 'needs_review'
            AND reason IN (
                'match_winner_no_address',
                'solo_winner_no_address',
                'solo_winner_identity_review'
            )
            AND tx_hash IS NULL
        )
    ) NOT VALID;
