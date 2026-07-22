'use strict';

const fs = require('fs');
const path = require('path');

const deploy = name => fs.readFileSync(path.join(__dirname, '..', 'scripts', 'deploy', name), 'utf8');

describe('deployment financial-audit contract', () => {
    const audit = deploy('financial-audit.sql');

    test('retained consumed match anchors are not treated as live escrow', () => {
        expect(audit).toMatch(/match_queue_entries\s+WHERE status IS NULL OR status NOT IN \('consumed', 'cancelled'\)/);
        expect(audit).not.toMatch(/status NOT IN \('cancelled'\)/);
    });

    test('nullable or unknown money/game states and a stale schema ledger fail closed', () => {
        expect(audit).toContain("payouts WHERE status IS DISTINCT FROM 'completed'");
        expect(audit).toMatch(/FROM payouts\s+WHERE status IS DISTINCT FROM 'completed'/);
        expect(audit).not.toMatch(
            /FROM payouts\s+WHERE status IS NULL OR status NOT IN \('recorded', 'completed'\)/
        );
        expect(audit).toContain("games WHERE status IS NULL OR status NOT IN ('won', 'lost', 'expired')");
        expect(audit).toContain("MAX(filename) = '042_immutable_financial_event_snapshots.sql'");
        expect(audit.match(/status IS NULL OR status NOT IN \('recorded', 'completed'\)/g))
            .toHaveLength(2);
        expect(audit).toContain('COUNT(*) = 42');
    });
});
