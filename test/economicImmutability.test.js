const fs = require('fs');
const path = require('path');

describe('database economic identity immutability', () => {
  const readMigration = name => fs.readFileSync(
    path.join(__dirname, `../src/migrations/${name}`), 'utf8'
  );

  test('committed solo owner is frozen on and after commitment', () => {
    const initial = readMigration('032_solo_liability_invariants.sql');
    const forward = readMigration('038_economic_identity_immutability.sql');
    for (const sql of [initial, forward]) {
      expect(sql).toMatch(/NEW\.user_id IS DISTINCT FROM OLD\.user_id/i);
      expect(sql).toMatch(/OLD\.payout_committed_at IS NULL[\s\S]*NEW\.payout_committed_at IS NOT NULL[\s\S]*NEW\.user_id IS DISTINCT FROM OLD\.user_id/i);
    }
  });

  test('receipt-backed or final invoice economics, destination, product, and provider are frozen', () => {
    const forward = readMigration('038_economic_identity_immutability.sql');
    for (const field of [
      'user_id', 'payment_type', 'expected_amount', 'subaddress', 'address_index',
      'provider_id', 'provider_invoice_id', 'payment_mode', 'credit_package_id',
      'product_id', 'product_grants', 'description', 'expires_at'
    ]) {
      expect(forward).toMatch(new RegExp(`NEW\\.${field} IS DISTINCT FROM OLD\\.${field}`, 'i'));
    }
    expect(forward).toMatch(/OLD\.status IN \('confirmed', 'refunded', 'expired'\)/i);
    expect(forward).toMatch(/EXISTS \(SELECT 1 FROM payment_receipts r WHERE r\.payment_id = OLD\.id\)/i);
    expect(forward).toMatch(/OLD\.fairness_bound_at IS NULL AND NEW\.fairness_bound_at IS NOT NULL/i);
  });

  test('confirmed-payment refunds change operational status without rewriting immutable description', () => {
    const refundService = fs.readFileSync(
      path.join(__dirname, '../src/services/paymentRefundService.js'), 'utf8'
    );
    const update = refundService.match(/UPDATE payments[\s\S]*?WHERE id = \$1/gi) || [];
    expect(update).toHaveLength(1);
    expect(update[0]).toMatch(/SET status = 'refunded'/i);
    expect(update[0]).not.toMatch(/description/i);
  });

  test('payment receipt authorization evidence is append-only', () => {
    const forward = readMigration('038_economic_identity_immutability.sql');
    expect(forward).toMatch(/CREATE TRIGGER trg_payment_receipts_append_only/i);
    expect(forward).toMatch(/BEFORE UPDATE OR DELETE ON payment_receipts/i);
    expect(forward).toMatch(/payment receipt evidence is append-only/i);
  });

  test('payout economics are immutable with only the exact saved-address claim exception', () => {
    const sql = readMigration('038_economic_identity_immutability.sql');
    for (const field of ['user_id', 'game_id', 'match_id', 'amount', 'multiplier', 'reason']) {
      expect(sql).toMatch(new RegExp(`NEW\\.${field} IS DISTINCT FROM OLD\\.${field}`, 'i'));
    }
    expect(sql).toMatch(/OLD\.payout_address = 'PENDING_NO_ADDRESS'/i);
    expect(sql).toMatch(/OLD\.status = 'needs_review'/i);
    expect(sql).toMatch(/NEW\.status = 'pending'/i);
    expect(sql).toMatch(/OLD\.tx_hash IS NULL[\s\S]*NEW\.tx_hash IS NULL/i);
    expect(sql).toMatch(/u\.id = OLD\.user_id[\s\S]*u\.payout_address = NEW\.payout_address/i);
    expect(sql).toMatch(/CREATE TRIGGER trg_payouts_immutable_obligation/i);
  });

  test('unresolved solo-win obligations are recordable but excluded from automatic address claim', () => {
    const initial = readMigration('038_economic_identity_immutability.sql');
    const forward = readMigration('039_unresolved_solo_payout_review.sql');
    const runtime = fs.readFileSync(
      path.join(__dirname, '../src/game/gameModeManager.js'), 'utf8'
    );

    expect(runtime).toContain("'solo_winner_identity_review'");
    expect(forward).toContain("'solo_winner_identity_review'");
    expect(forward).toMatch(/status = 'needs_review'[\s\S]*tx_hash IS NULL/i);
    expect(initial).toMatch(
      /OLD\.reason IN \('match_winner_no_address', 'solo_winner_no_address'\)/i
    );
    expect(initial).not.toMatch(
      /OLD\.reason IN \([^)]*solo_winner_identity_review/i
    );
  });

  test('paid entropy precommit witness is shaped, immutable, and locks active fairness identity', () => {
    const sql = readMigration('040_paid_match_entropy_precommit.sql');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS entropy_precommit_tip_height BIGINT/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS entropy_precommit_verified_at TIMESTAMPTZ/i);
    expect(sql).toMatch(/entropy_precommit_tip_height < start_block_height/i);
    expect(sql).toMatch(/NEW\.entropy_precommit_tip_height IS DISTINCT FROM OLD\.entropy_precommit_tip_height/i);
    expect(sql).toMatch(/NEW\.entropy_precommit_verified_at IS DISTINCT FROM OLD\.entropy_precommit_verified_at/i);
    expect(sql).toMatch(/NOT \(OLD\.status = 'pending' AND NEW\.status = 'starting'\)/i);
    for (const field of [
      'economy', 'variant', 'ruleset_id', 'difficulty_preset', 'max_players',
      'seed_hash', 'dungeon', 'start_block_height'
    ]) {
      expect(sql).toMatch(new RegExp(`NEW\\.${field} IS DISTINCT FROM OLD\\.${field}`, 'i'));
    }
    expect(sql).toMatch(/CREATE TRIGGER trg_matches_immutable_entropy_precommit/i);
  });
});
