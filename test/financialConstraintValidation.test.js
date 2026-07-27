'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATIONS = path.join(__dirname, '../src/migrations');
const AUDIT = path.join(__dirname, '../scripts/deploy/financial-constraint-audit.sql');
const VALIDATE = path.join(__dirname, '../scripts/deploy/financial-constraint-validate-restore.sql');

const CONSTRAINTS = Object.freeze([
    ['payments', 'payments_status_check'],
    ['payments', 'payments_payment_type_check'],
    ['payouts', 'payouts_status_check'],
    ['games', 'games_payout_commitment_complete'],
    ['games', 'games_layout_fingerprints_array_check'],
    ['race_entry_lots', 'race_entry_lots_remaining_within_original'],
    ['match_queue_entries', 'match_queue_entries_status_check'],
    ['match_queue_entries', 'match_queue_entries_escrow_nonnegative'],
    ['match_queue_entries', 'match_queue_committed_escrow_complete'],
    ['matches', 'matches_payout_liability_amount_nonnegative'],
    ['matches', 'matches_payout_liability_cap_positive'],
    ['matches', 'matches_payout_liability_complete'],
    ['matches', 'matches_payout_liability_economics_consistent'],
    ['race_entry_lots', 'race_entry_lots_refund_shape'],
    ['payment_refunds', 'payment_refunds_progress_nonnegative'],
    ['games', 'games_entry_consumption_shape'],
    ['payments', 'payments_fairness_binding_complete'],
    ['payouts', 'payouts_no_address_review_shape']
]);

function migrationNotValidConstraintNames() {
    const names = new Set();
    for (const fileName of fs.readdirSync(MIGRATIONS).filter(name => name.endsWith('.sql'))) {
        const sql = fs.readFileSync(path.join(MIGRATIONS, fileName), 'utf8');
        for (const marker of sql.matchAll(/NOT\s+VALID\s*;/gi)) {
            const prefix = sql.slice(0, marker.index);
            const declarations = [...prefix.matchAll(/ADD\s+CONSTRAINT\s+([a-z0-9_]+)/gi)];
            if (declarations.length) names.add(declarations.at(-1)[1].toLowerCase());
        }
    }
    return [...names].sort();
}

describe('historical financial constraint release gates', () => {
    const expectedNames = CONSTRAINTS.map(([, name]) => name).sort();

    test('inventory stays synchronized with every migration NOT VALID constraint', () => {
        expect(migrationNotValidConstraintNames()).toEqual(expectedNames);
        expect(CONSTRAINTS).toHaveLength(18);
    });

    test('read-only audit names every constraint and checks historical predicates', () => {
        const sql = fs.readFileSync(AUDIT, 'utf8');
        expect(sql).toMatch(/BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;/i);
        expect(sql).toContain("current_database() = :'expected_database'");
        expect(sql).toContain('historical_constraints_clean');
        expect(sql).toContain('IS FALSE');
        expect(sql).not.toMatch(/\bALTER\s+TABLE\b/i);
        expect(sql).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\b/i);
        for (const [, name] of CONSTRAINTS) {
            expect(sql).toContain(`'${name}'`);
        }
    });

    test('disposable-restore gate explicitly validates every constraint then rolls back', () => {
        const sql = fs.readFileSync(VALIDATE, 'utf8');
        expect(sql).toContain("current_database() ~* '(restore|scratch)'");
        expect(sql).toContain('I_CONFIRM_THIS_DATABASE_IS_A_DISPOSABLE_RESTORE');
        expect(sql).toContain('\\ir financial-constraint-audit.sql');
        expect(sql).toContain('SET LOCAL lock_timeout');
        expect(sql).toMatch(/ROLLBACK;[\s\S]*PASS: PostgreSQL validated all 18 constraints/i);
        for (const [table, name] of CONSTRAINTS) {
            expect(sql).toContain(
                `ALTER TABLE public.${table} VALIDATE CONSTRAINT ${name};`
            );
        }
        expect((sql.match(/\bVALIDATE CONSTRAINT\s+[a-z0-9_]+;/gi) || []))
            .toHaveLength(CONSTRAINTS.length);
    });
});
