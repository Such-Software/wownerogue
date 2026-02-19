#!/usr/bin/env node
/**
 * splitOutputs.js — Split wallet outputs for concurrent payout capacity.
 *
 * Wownero/Monero lock change outputs for several blocks after spending.
 * Pre-splitting one large output into many smaller ones allows the wallet
 * to handle multiple concurrent payouts without "not enough unlocked balance".
 *
 * Usage:
 *   node scripts/splitOutputs.js [options]
 *
 * Options:
 *   --amount <WOW>   Target output size in WOW (default: 10)
 *   --count  <N>     Number of outputs to create (default: 20)
 *   --status         Show current output breakdown and exit
 *   --endpoint <url> Wallet RPC endpoint (overrides PRIMARY_WALLET_ENDPOINT)
 */

const path = require('path');
const fs = require('fs');
const http = require('http');

// Parse .env manually — no external dependencies needed
function loadEnv() {
    const envPath = path.resolve(__dirname, '..', 'src', '.env');
    try {
        const lines = fs.readFileSync(envPath, 'utf8').split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eq = trimmed.indexOf('=');
            if (eq === -1) continue;
            const key = trimmed.substring(0, eq).trim();
            const val = trimmed.substring(eq + 1).trim().replace(/^['"]|['"]$/g, '');
            if (!process.env[key]) process.env[key] = val;
        }
    } catch (e) {
        // .env not found — that's fine, user can pass --endpoint
    }
}
loadEnv();

const ATOMIC_DIVISOR = 1e11; // Wownero: 11 decimal places

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = {
        amount: 10,
        count: 20,
        status: false,
        endpoint: process.env.PRIMARY_WALLET_ENDPOINT || 'http://127.0.0.1:34570'
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--amount':
                opts.amount = parseFloat(args[++i]);
                if (!opts.amount || opts.amount <= 0) {
                    console.error('Error: --amount must be a positive number');
                    process.exit(1);
                }
                break;
            case '--count':
                opts.count = parseInt(args[++i], 10);
                if (!opts.count || opts.count <= 0) {
                    console.error('Error: --count must be a positive integer');
                    process.exit(1);
                }
                break;
            case '--status':
                opts.status = true;
                break;
            case '--endpoint':
                opts.endpoint = args[++i];
                break;
            case '--help':
            case '-h':
                console.log(`
splitOutputs.js — Split wallet outputs for concurrent payout capacity.

Usage: node scripts/splitOutputs.js [options]

Commands:
  --status         Show current output breakdown and exit
  (default)        Split outputs

Options:
  --amount <WOW>   Target output size in WOW (default: 10)
  --count  <N>     Number of outputs to create (default: 20)
  --endpoint <url> Wallet RPC endpoint (default: PRIMARY_WALLET_ENDPOINT env)
  --help           Show this help message

Examples:
  node scripts/splitOutputs.js --status
  Show all spendable outputs with locked/unlocked status.

  node scripts/splitOutputs.js --amount 10 --count 30
  Creates 30 outputs of 10 WOW each (requires 300+ WOW unlocked balance).
`);
                process.exit(0);
                break;
            default:
                console.error(`Unknown option: ${args[i]}`);
                process.exit(1);
        }
    }

    return opts;
}

function rpcCall(endpoint, method, params = {}) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '2.0', id: '0', method, params });
        const parsed = new URL(`${endpoint}/json_rpc`);
        const options = {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.error) {
                        reject(new Error(`RPC error (${method}): ${json.error.message}`));
                    } else {
                        resolve(json);
                    }
                } catch (e) {
                    reject(new Error(`Invalid JSON response from ${method}: ${data.substring(0, 200)}`));
                }
            });
        });
        req.on('error', (err) => reject(new Error(`RPC connection error (${method}): ${err.message}`)));
        req.write(body);
        req.end();
    });
}

function formatWow(atomic) {
    return (atomic / ATOMIC_DIVISOR).toFixed(4);
}

async function showStatus(endpoint) {
    console.log('=== Wallet Output Status ===');
    console.log(`Endpoint: ${endpoint}`);
    console.log('');

    // Get balance summary
    const balResp = await rpcCall(endpoint, 'get_balance', { account_index: 0 });
    const bal = balResp.result;
    console.log(`Total balance:    ${formatWow(bal.balance)} WOW`);
    console.log(`Unlocked balance: ${formatWow(bal.unlocked_balance)} WOW`);
    const locked = bal.balance - bal.unlocked_balance;
    if (locked > 0) {
        console.log(`Locked balance:   ${formatWow(locked)} WOW`);
    }
    console.log('');

    // Get all transfers to build output picture
    const transfersResp = await rpcCall(endpoint, 'incoming_transfers', {
        transfer_type: 'available',
        account_index: 0
    });

    const outputs = transfersResp.result?.transfers || [];
    if (outputs.length === 0) {
        console.log('No spendable outputs found.');
        return;
    }

    // Separate unlocked vs locked
    const unlocked = outputs.filter(o => !o.frozen && o.unlocked !== false);
    const lockedOutputs = outputs.filter(o => o.frozen || o.unlocked === false);

    // Sort by amount descending
    unlocked.sort((a, b) => b.amount - a.amount);
    lockedOutputs.sort((a, b) => b.amount - a.amount);

    console.log(`Spendable outputs: ${unlocked.length}`);
    if (unlocked.length > 0) {
        for (const o of unlocked) {
            const age = o.block_height ? `block ${o.block_height}` : 'mempool';
            console.log(`  ${formatWow(o.amount).padStart(12)} WOW  (${age})`);
        }
    }

    if (lockedOutputs.length > 0) {
        console.log('');
        console.log(`Locked outputs: ${lockedOutputs.length}`);
        for (const o of lockedOutputs) {
            const age = o.block_height ? `block ${o.block_height}` : 'mempool';
            const reason = o.frozen ? 'frozen' : 'locked';
            console.log(`  ${formatWow(o.amount).padStart(12)} WOW  (${age}, ${reason})`);
        }
    }

    console.log('');
    const totalSpendable = unlocked.reduce((s, o) => s + o.amount, 0);
    console.log(`Total spendable:  ${unlocked.length} outputs, ${formatWow(totalSpendable)} WOW`);
    if (lockedOutputs.length > 0) {
        console.log(`Total locked:     ${lockedOutputs.length} outputs, ${formatWow(lockedOutputs.reduce((s, o) => s + o.amount, 0))} WOW`);
    }

    // If amount/count provided, simulate which outputs would likely be consumed
    if (opts.amount && opts.count) {
        const amountAtomic = Math.round(opts.amount * ATOMIC_DIVISOR);
        const totalNeeded = amountAtomic * opts.count;
        const estimatedFees = Math.round(0.01 * ATOMIC_DIVISOR * opts.count);
        const totalWithFees = totalNeeded + estimatedFees;

        console.log('');
        console.log(`--- Split Simulation: ${opts.count} x ${opts.amount} WOW ---`);
        console.log(`Need: ~${formatWow(totalWithFees)} WOW (${formatWow(totalNeeded)} + ~${formatWow(estimatedFees)} fees)`);

        if (totalWithFees > totalSpendable) {
            console.log(`INSUFFICIENT: only ${formatWow(totalSpendable)} WOW spendable`);
            return;
        }

        // Simulate output selection: wallet typically picks smallest sufficient
        // combination to minimize change. Sort ascending and accumulate.
        const candidates = [...unlocked].sort((a, b) => a.amount - b.amount);
        const selected = [];
        let accumulated = 0;
        for (const o of candidates) {
            selected.push(o);
            accumulated += o.amount;
            if (accumulated >= totalWithFees) break;
        }

        console.log(`Likely inputs (${selected.length} output${selected.length > 1 ? 's' : ''}):`);
        for (const o of selected) {
            const age = o.block_height ? `block ${o.block_height}` : 'mempool';
            console.log(`  ${formatWow(o.amount).padStart(12)} WOW  (${age})`);
        }

        const change = accumulated - totalWithFees;
        console.log(`Change output: ~${formatWow(change)} WOW`);

        // Show what remains untouched
        const remaining = unlocked.filter(o => !selected.includes(o));
        console.log(`Untouched outputs: ${remaining.length} (${formatWow(remaining.reduce((s, o) => s + o.amount, 0))} WOW, still spendable)`);
        console.log('');
        console.log(`After split: ${remaining.length} existing + ${opts.count} new + 1 change = ${remaining.length + opts.count + 1} total outputs`);
    }
}

async function splitOutputs(endpoint, opts) {
    const amountAtomic = Math.round(opts.amount * ATOMIC_DIVISOR);
    const totalNeeded = amountAtomic * opts.count;

    console.log('=== Wownero Output Splitter ===');
    console.log(`Endpoint:    ${endpoint}`);
    console.log(`Output size: ${opts.amount} WOW (${amountAtomic} atomic)`);
    console.log(`Count:       ${opts.count} outputs`);
    console.log(`Total:       ${formatWow(totalNeeded)} WOW (+ fees)`);
    console.log('');

    // Get wallet address
    let ownAddress;
    try {
        const addrResp = await rpcCall(endpoint, 'get_address', {
            account_index: 0,
            address_index: [0]
        });
        ownAddress = addrResp.result.address;
        console.log(`Wallet:      ${ownAddress.substring(0, 12)}...${ownAddress.substring(ownAddress.length - 6)}`);
    } catch (err) {
        console.error(`Failed to get wallet address: ${err.message}`);
        console.error('Make sure wownero-wallet-rpc is running on', endpoint);
        process.exit(1);
    }

    // Check balance
    let balance;
    try {
        const balResp = await rpcCall(endpoint, 'get_balance', { account_index: 0 });
        balance = balResp.result;
        console.log(`Balance:     ${formatWow(balance.balance)} WOW`);
        console.log(`Unlocked:    ${formatWow(balance.unlocked_balance)} WOW`);
        console.log('');
    } catch (err) {
        console.error(`Failed to get balance: ${err.message}`);
        process.exit(1);
    }

    // Rough fee estimate: ~0.01 WOW per output
    const estimatedFees = Math.round(0.01 * ATOMIC_DIVISOR * opts.count);
    const totalWithFees = totalNeeded + estimatedFees;

    if (balance.unlocked_balance < totalWithFees) {
        console.error(`Insufficient unlocked balance!`);
        console.error(`  Need:  ~${formatWow(totalWithFees)} WOW (including estimated fees)`);
        console.error(`  Have:  ${formatWow(balance.unlocked_balance)} WOW unlocked`);
        process.exit(1);
    }

    // Build destinations (all to own address)
    const destinations = [];
    for (let i = 0; i < opts.count; i++) {
        destinations.push({ amount: amountAtomic, address: ownAddress });
    }

    console.log(`Splitting into ${opts.count} outputs of ${opts.amount} WOW each...`);

    // Send transfer_split to self
    try {
        const txResp = await rpcCall(endpoint, 'transfer_split', {
            destinations,
            account_index: 0,
            priority: 1,
            get_tx_key: true
        });

        const result = txResp.result;
        const totalFee = (result.fee_list || []).reduce((a, b) => a + b, 0);

        console.log('');
        console.log('=== Split Complete ===');
        console.log(`Transactions: ${result.tx_hash_list.length}`);
        for (const txHash of result.tx_hash_list) {
            console.log(`  tx: ${txHash}`);
        }
        console.log(`Total fee:    ${(totalFee / ATOMIC_DIVISOR).toFixed(6)} WOW`);
        console.log(`Outputs created: ${opts.count}`);
        console.log('');
        console.log('Outputs will be spendable after 4 block confirmations (~8 minutes).');
    } catch (err) {
        console.error(`Failed to split outputs: ${err.message}`);
        process.exit(1);
    }
}

async function main() {
    const opts = parseArgs();

    if (opts.status) {
        await showStatus(opts.endpoint);
    } else {
        await splitOutputs(opts.endpoint, opts);
    }
}

main().catch(err => {
    console.error('Unexpected error:', err.message);
    process.exit(1);
});
