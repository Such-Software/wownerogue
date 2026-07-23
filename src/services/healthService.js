/** Build the public, non-sensitive health payload used by probes and the status UI. */
function buildPublicHealth(input = {}) {
    const releaseCandidate = input.releaseIdentity;
    const releaseValid = releaseCandidate?.verified === true
        && /^git-[0-9a-f]{12}$/.test(releaseCandidate.id || '')
        && /^[0-9a-f]{40}$/.test(releaseCandidate.commit || '')
        && releaseCandidate.id.slice(4) === releaseCandidate.commit.slice(0, 12);
    const release = releaseValid ? {
        verified: true,
        id: releaseCandidate.id,
        commit: releaseCandidate.commit
    } : {
        verified: false,
        id: null,
        commit: null
    };
    const sanitizeIdentity = (identity, required) => {
        const pair = (value) => value && typeof value === 'object' ? {
            cryptoType: typeof value.cryptoType === 'string' ? value.cryptoType : null,
            network: typeof value.network === 'string' ? value.network : null
        } : null;
        return {
            required: Boolean(required),
            verified: identity?.verified === true,
            expected: pair(identity?.expected),
            actual: pair(identity?.actual)
        };
    };
    const databaseReady = Boolean(input.databaseReady);
    const hasBlock = Number(input.blockHeight) > 0;
    const paymentsEnabled = Boolean(input.paymentsEnabled);
    const payoutsEnabled = Boolean(input.payoutsEnabled);
    const walletRequired = input.walletRequired === undefined
        ? (paymentsEnabled || payoutsEnabled)
        : Boolean(input.walletRequired);
    const identityRequired = Boolean(input.identityRequired);
    const daemonIdentity = input.daemonIdentity || input.chainIdentity || null;
    const daemonIdentityRequired = identityRequired && !Boolean(input.simulatedBlocks);
    const walletIdentityRequired = identityRequired && walletRequired;
    const chainIdentityReady = !daemonIdentityRequired || daemonIdentity?.verified === true;
    const walletIdentityReady = !walletIdentityRequired || input.walletIdentity?.verified === true;
    const chainReady = Boolean(input.simulatedBlocks)
        || (hasBlock && input.chainHealthy !== false && chainIdentityReady);
    const walletReady = !walletRequired
        || (Boolean(input.walletHealthy) && walletIdentityReady);
    // The composition root supplies false until every startup financial reconciliation pass
    // has committed or proved there was nothing to do. Default true keeps this helper usable by
    // callers that do not own durable financial state.
    const financialRecoveryReady = input.financialRecoveryReady !== false;
    const ready = databaseReady && chainReady && walletReady && financialRecoveryReady;

    const blockHeight = Number(input.blockHeight || 0);
    const network = daemonIdentity?.verified === true && daemonIdentity?.actual?.network
        ? daemonIdentity.actual.network
        : (input.network || 'mainnet');
    const gameMode = input.gameMode || 'FREE';

    return {
        status: ready ? 'ok' : 'degraded',
        ready,
        timestamp: new Date(input.now || Date.now()).toISOString(),
        uptime: Number(input.uptime || 0),
        checks: {
            database: databaseReady ? 'up' : 'down',
            chain: chainReady ? 'up' : 'down',
            wallet: walletRequired ? (walletReady ? 'up' : 'down') : 'not_required',
            financialRecovery: financialRecoveryReady ? 'reconciled' : 'pending',
            daemonIdentity: daemonIdentityRequired
                ? (chainIdentityReady ? 'verified' : 'unverified')
                : 'not_required',
            walletIdentity: walletIdentityRequired
                ? (walletIdentityReady ? 'verified' : 'unverified')
                : 'not_required'
        },
        chain: {
            height: blockHeight,
            network,
            source: input.blockSource || 'daemon'
        },
        games: {
            active: Number(input.activeGames || 0),
            queued: Number(input.queuedGames || 0),
            connected: Number(input.connectedPlayers || 0),
            mode: gameMode
        },
        money: {
            paymentsEnabled,
            payoutsEnabled
        },
        release,
        identities: {
            daemon: sanitizeIdentity(daemonIdentity, daemonIdentityRequired),
            wallet: sanitizeIdentity(input.walletIdentity, walletIdentityRequired)
        },
        // Compatibility aliases used by existing smoke probes and lightweight status clients.
        blockHeight,
        network,
        gameMode,
        paymentsEnabled,
        walletHealthy: walletRequired ? walletReady : Boolean(input.walletHealthy)
    };
}

module.exports = { buildPublicHealth };
