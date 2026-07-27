-- Behavioral smoke test for migrations 032/035/037/038/039/040.
-- Run with psql -X -v ON_ERROR_STOP=1 after migrations. Everything rolls back.
BEGIN;

DO $economic_invariants$
DECLARE
    owner_id INTEGER;
    other_id INTEGER;
    product_payment_id INTEGER;
    solo_payment_id INTEGER;
    game_row_id INTEGER;
    payout_row_id INTEGER;
    match_row_id UUID;
    receipt_row_id BIGINT;
    receipt_tx CHAR(64) := md5(random()::text) || md5(clock_timestamp()::text);
    receipt_output CHAR(64) := md5(clock_timestamp()::text) || md5(random()::text);
    saved_address TEXT := 'test-wallet-' || txid_current()::text;
BEGIN
    INSERT INTO users (socket_id, username, payout_address)
    VALUES ('economic-owner-' || txid_current()::text, 'economic-owner', saved_address)
    RETURNING id INTO owner_id;

    INSERT INTO users (socket_id, username, payout_address)
    VALUES ('economic-other-' || txid_current()::text, 'economic-other', 'test-wallet-other')
    RETURNING id INTO other_id;

    INSERT INTO payments (
        user_id, socket_id, subaddress, address_index, expected_amount, payment_type,
        payment_mode, credit_package_id, product_id, product_grants, description,
        provider_id, provider_invoice_id, status, expires_at
    ) VALUES (
        owner_id, 'economic-product', 'test-product-subaddress', 771, 100,
        'credits_package', 'credits', 'small', 'small', '{"credits":10}'::jsonb,
        '10 credits', 'native-monero', 'test-product-invoice', 'pending', NOW() + INTERVAL '1 hour'
    ) RETURNING id INTO product_payment_id;

    -- Legacy pending rows retain one pre-receipt path to snapshot their product promise.
    UPDATE payments
    SET product_grants = '{"credits":10,"bonus":1}'::jsonb
    WHERE id = product_payment_id;

    INSERT INTO payment_receipts (
        payment_id, provider_id, evidence_type, evidence_id, tx_hash, output_id,
        address_index, amount, confirmed
    ) VALUES (
        product_payment_id, 'native-monero', 'chain_output',
        receipt_tx || ':' || receipt_output, receipt_tx, receipt_output, 771, 100, TRUE
    ) RETURNING id INTO receipt_row_id;

    BEGIN
        UPDATE payments SET expected_amount = 1 WHERE id = product_payment_id;
        RAISE EXCEPTION 'receipt-backed invoice price mutation was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        UPDATE payments SET product_grants = '{"credits":999}'::jsonb WHERE id = product_payment_id;
        RAISE EXCEPTION 'receipt-backed product promise mutation was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    -- Settlement and refund state remain operationally mutable.
    UPDATE payments
    SET status = 'confirmed', received_amount = 100, confirmed_at = NOW()
    WHERE id = product_payment_id;
    UPDATE payments SET status = 'refunded' WHERE id = product_payment_id;

    BEGIN
        UPDATE payments SET provider_invoice_id = 'rewritten' WHERE id = product_payment_id;
        RAISE EXCEPTION 'refunded invoice provider identity mutation was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    INSERT INTO payments (
        user_id, socket_id, subaddress, address_index, expected_amount, payment_type,
        product_id, product_grants, provider_id, provider_invoice_id, status
    ) VALUES (
        owner_id, 'economic-expired', 'test-expired-subaddress', 773, 50,
        'credits_package', 'expired-small', '{"credits":5}'::jsonb,
        'native-monero', 'test-expired-invoice', 'expired'
    ) RETURNING id INTO product_payment_id;

    BEGIN
        UPDATE payments SET subaddress = 'rewritten-expired-address' WHERE id = product_payment_id;
        RAISE EXCEPTION 'expired invoice destination mutation was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        UPDATE payment_receipts SET amount = 1 WHERE id = receipt_row_id;
        RAISE EXCEPTION 'payment receipt update was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        DELETE FROM payment_receipts WHERE id = receipt_row_id;
        RAISE EXCEPTION 'payment receipt deletion was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    INSERT INTO payments (
        user_id, socket_id, subaddress, address_index, expected_amount, payment_type,
        provider_id, provider_invoice_id, status, fairness_proof_version,
        fairness_offer_id, fairness_offer_issued_at, fairness_commitment,
        fairness_server_seed, fairness_client_seed, fairness_bound_at
    ) VALUES (
        owner_id, 'economic-solo', 'test-solo-subaddress', 772, 100, 'single_game',
        'native-monero', 'test-solo-invoice', 'pending', 2,
        'test-offer-' || txid_current()::text, NOW(), repeat('a', 64),
        repeat('b', 64), 'client-seed', NOW()
    ) RETURNING id INTO solo_payment_id;

    BEGIN
        UPDATE payments SET user_id = other_id WHERE id = solo_payment_id;
        RAISE EXCEPTION 'fairness-bound invoice owner mutation was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    INSERT INTO games (
        user_id, socket_id, game_mode, payment_id, status, dungeon_seed,
        payout_escape_amount, payout_treasure_amount, payout_escape_mult,
        payout_treasure_mult, payout_address, payout_eligible, payout_terms,
        payout_committed_at
    ) VALUES (
        owner_id, 'economic-game', 'PAID_SINGLE', solo_payment_id, 'active',
        'economic-seed-' || txid_current()::text, 200, 300, 2, 3,
        saved_address, TRUE, '{"escape":200,"treasure":300}'::jsonb, NOW()
    ) RETURNING id INTO game_row_id;

    BEGIN
        UPDATE games SET user_id = other_id WHERE id = game_row_id;
        RAISE EXCEPTION 'committed game owner mutation was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    UPDATE games SET moves_made = moves_made + 1 WHERE id = game_row_id;

    INSERT INTO payouts (
        user_id, game_id, payout_address, amount, multiplier, reason, status
    ) VALUES (
        owner_id, game_row_id, 'PENDING_NO_ADDRESS', 200, 2,
        'solo_winner_no_address', 'needs_review'
    ) RETURNING id INTO payout_row_id;

    -- The sole destination exception is the exact saved-address claim transition.
    UPDATE payouts
    SET payout_address = saved_address, status = 'pending'
    WHERE id = payout_row_id;
    UPDATE payouts SET retry_count = retry_count + 1 WHERE id = payout_row_id;

    BEGIN
        UPDATE payouts SET payout_address = 'test-wallet-rewritten' WHERE id = payout_row_id;
        RAISE EXCEPTION 'claimed payout destination mutation was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        UPDATE payouts SET amount = 1 WHERE id = payout_row_id;
        RAISE EXCEPTION 'payout amount mutation was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO payouts (
            user_id, payout_address, amount, multiplier, reason, status
        ) VALUES (
            owner_id, 'PENDING_NO_ADDRESS', 1, 1,
            'solo_winner_no_address', 'pending'
        );
        RAISE EXCEPTION 'invalid no-address payout shape was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    -- An unresolved paid winner remains recorded for manual review, but its missing owner means
    -- the saved-address exception must never make it dispatchable automatically.
    INSERT INTO payouts (
        user_id, payout_address, amount, multiplier, reason, status
    ) VALUES (
        NULL, 'PENDING_NO_ADDRESS', 1, 1,
        'solo_winner_identity_review', 'needs_review'
    ) RETURNING id INTO payout_row_id;

    BEGIN
        UPDATE payouts
        SET payout_address = saved_address, status = 'pending'
        WHERE id = payout_row_id;
        RAISE EXCEPTION 'unresolved solo winner address claim was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    INSERT INTO matches (
        economy, variant, ruleset_id, difficulty_preset, max_players,
        seed_hash, dungeon, start_block_height
    ) VALUES (
        'credits_prestige', 'pvp', 'last-alive', 'race', 2,
        repeat('c', 64),
        jsonb_build_object('match_fairness_freeze', jsonb_build_object(
            'version', 'future-block-freeze-v2',
            'freezeBlockHeight', 800,
            'targetBlockHeight', 802,
            'entropyDelayBlocks', 2,
            'economy', 'credits_prestige',
            'rulesetId', 'last-alive',
            'queueEntryIds', jsonb_build_array('81', '82'),
            'freezeCommitment', repeat('c', 64)
        )),
        802
    ) RETURNING id INTO match_row_id;

    BEGIN
        UPDATE matches SET entropy_precommit_tip_height = 800 WHERE id = match_row_id;
        RAISE EXCEPTION 'partial paid entropy precommit marker was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    UPDATE matches
    SET entropy_precommit_tip_height = 800,
        entropy_precommit_verified_at = NOW()
    WHERE id = match_row_id;

    BEGIN
        UPDATE matches SET entropy_precommit_tip_height = 799 WHERE id = match_row_id;
        RAISE EXCEPTION 'paid entropy precommit witness mutation was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        UPDATE matches SET seed_hash = repeat('d', 64) WHERE id = match_row_id;
        RAISE EXCEPTION 'verified pending paid freeze identity mutation was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    -- The single activation transition may replace the freeze envelope with the derived proof.
    UPDATE matches
    SET status = 'starting',
        seed_hash = repeat('e', 64),
        dungeon = jsonb_build_object('match_fairness', jsonb_build_object(
            'version', 'future-chain-block-v2',
            'freezeCommitment', repeat('c', 64)
        ))
    WHERE id = match_row_id;

    BEGIN
        UPDATE matches SET ruleset_id = 'race' WHERE id = match_row_id;
        RAISE EXCEPTION 'active paid match fairness identity mutation was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    UPDATE matches SET status = 'active', started_at = NOW() WHERE id = match_row_id;

    RAISE NOTICE 'economic invariants behavioral test passed';
END
$economic_invariants$;

ROLLBACK;
