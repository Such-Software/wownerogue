const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

function contactMarkup(disclosure) {
    const operator = disclosure.operator || {};
    const label = escapeHtml(operator.contactLabel || 'Operator contact is not configured');
    if (!operator.contactUrl) return `<strong>${label}</strong>`;
    return `<a href="${escapeHtml(operator.contactUrl)}" rel="noopener">${label}</a>`;
}

function modeSummary(disclosure) {
    const service = disclosure.service || {};
    const items = [];
    if (service.freePlayEnabled) {
        items.push('<li><strong>Free play:</strong> no entry payment and a separate free leaderboard; no free-play payout.</li>');
    }
    if (service.directPaidEntryEnabled) {
        items.push(`<li><strong>Paid single entry:</strong> one ${escapeHtml(service.currencyLabel)} payment purchases one qualifying entry.</li>`);
    }
    if (service.paidCreditsEnabled) {
        items.push('<li><strong>Paid credits:</strong> a cryptocurrency purchase grants the displayed credits or products. Credits are service records, not cryptocurrency balances.</li>');
    }
    if (service.paidPrestigeOnly) {
        items.push('<li><strong>Paid prestige mode:</strong> paid scores use the paid leaderboard, but this server does not currently offer a cryptocurrency prize.</li>');
    }
    if (service.soloPayoutsEnabled) {
        items.push('<li><strong>Reward-enabled solo play:</strong> a paid entry can be lost. Only the outcomes and payout amounts shown before entry are eligible.</li>');
    }
    if (service.cryptoMatchPayoutsEnabled) {
        items.push('<li><strong>Reward-enabled PvP:</strong> the configured race may award the collected pot after the displayed operator fee. Other PvP economies remain separate.</li>');
    }
    if (service.isTestNetwork) {
        const testNetworkNotice = disclosure.operatedProduct?.noRealValueNotice
            || `${service.currencyLabel} is test currency with no intended monetary value. Never send ${service.cryptoType} mainnet funds to a test-network address.`;
        items.push(`<li><strong>Test network:</strong> ${escapeHtml(testNetworkNotice)}</li>`);
    }
    return items.length ? `<ul>${items.join('')}</ul>` : '<p>This instance currently exposes no paid play.</p>';
}

function operatorAndSoftwareStatus(disclosure) {
    const operated = disclosure.operatedProduct;
    const software = disclosure.software || {};
    const relationship = operated
        ? `<p><strong>Operated-product scope:</strong> ${escapeHtml(operated.scopeNotice)}</p>${operated.noRealValueNotice
            ? `<p class="no-real-value"><strong>${escapeHtml(operated.noRealValueNotice)}</strong></p>`
            : ''}<p>${escapeHtml(software.operatedBoundaryNotice)}</p><p>${escapeHtml(software.thirdPartyNotice)}</p>`
        : `<p><strong>Independent deployment:</strong> ${escapeHtml(software.thirdPartyNotice)}</p><p>${escapeHtml(software.operatedBoundaryNotice)}</p>`;
    return `<section class="notice"><h2>Operator and open-source status</h2>${relationship}<p><strong>${escapeHtml(software.license || 'MIT')} licence:</strong> ${escapeHtml(software.rightsNotice)}</p><p>${escapeHtml(software.warrantyNotice)}</p><p>${escapeHtml(software.legalAdviceNotice)}</p></section>`;
}

function shell({ title, disclosure, body }) {
    const operator = escapeHtml(disclosure.operator?.name || 'Site operator');
    const gameName = escapeHtml(disclosure.service?.gameName || 'Wowngeon');
    const effective = disclosure.termsEffectiveDate
        ? `Effective ${escapeHtml(disclosure.termsEffectiveDate)}`
        : 'Effective date is not configured';
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — ${gameName}</title>
  <link rel="stylesheet" href="/styles/legal.css">
</head>
<body>
  <main>
    <nav aria-label="Legal and service navigation"><a href="/">Game</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/responsible-play">Responsible play</a></nav>
    <header><p class="eyebrow">${operator}</p><h1>${escapeHtml(title)}</h1><p>${effective} · policy ${escapeHtml(disclosure.policyVersion)}</p></header>
    ${operatorAndSoftwareStatus(disclosure)}
    ${body}
    <section class="notice"><h2>Important status</h2><p>${escapeHtml(disclosure.notices?.legalReview)}</p><p>${escapeHtml(disclosure.notices?.identityControl)}</p></section>
    <footer><p>Operator contact: ${contactMarkup(disclosure)}</p></footer>
  </main>
</body>
</html>`;
}

function renderTerms(disclosure) {
    const jurisdiction = disclosure.notices?.jurisdiction
        ? `<p><strong>Operator location notice:</strong> ${escapeHtml(disclosure.notices.jurisdiction)}</p>`
        : '<p>No location-specific restriction list is published here. You are responsible for confirming that your use is permitted where you are located.</p>';
    return shell({
        title: 'Terms of Use',
        disclosure,
        body: `
<section><h2>Who may use the service</h2><p>You may use the service only if you are at least ${escapeHtml(disclosure.minimumAge)}, can lawfully enter the transactions shown, and are acting for yourself. Do not use it where paid play, cryptocurrency transactions, prizes, or gambling-like games are prohibited.</p>${jurisdiction}</section>
<section><h2>Current service modes</h2><p>The server configuration, confirmation screen, and invoice shown for an action control that action. Solo scores map by entry: FREE runs use the Pleb board, while PAID_SINGLE and PAID_CREDITS runs use the Hall of Champions. PvP maps separately by economy: free matches use the Pleb board, credits_prestige matches use the Prestige board, and crypto_race matches use the Hall of Champions.</p>${modeSummary(disclosure)}</section>
<section><h2>Payments, credits, and outcomes</h2><p>Blockchain transfers may be irreversible. Check the network, asset, address, and exact amount before sending. A pending invoice is not an entitlement until the server records the required confirmation. Do not send funds after an invoice expires; contact the operator for manual review.</p><p>Credits, tickets, cosmetics, and leaderboard status are service entitlements tied to an anonymous browser session. They are not deposits, do not earn interest, and are not redeemable for cryptocurrency unless a specific reward-enabled game says so before entry. Clearing browser storage or losing the session token can make an account inaccessible.</p><p>Random timing, dungeon generation, player decisions, other players, network conditions, and game rules affect results. A paid entry can lose its entire entry value. Previous results do not predict future results.</p></section>
<section><h2>Fair play and acceptable use</h2><p>Do not exploit defects, automate the public service without permission, interfere with other players, evade limits, launder funds, submit unlawful content, or attempt to access another session. The operator may pause entry, quarantine ambiguous payments, reverse unconsumed service credits, or suspend access to protect players and the service. Blockchain transfers already broadcast cannot be reversed by the application.</p></section>
<section><h2>Availability and changes</h2><p>The service is experimental software and may be paused, changed, or withdrawn. Rules and prices may change only for future entries; the server records the economic terms accepted for an admitted game. Verification pages and transaction records should be retained when resolving a dispute.</p></section>
<section><h2>Problems and disputes</h2><p>Stop sending funds if the asset, network, amount, reward, or status is unclear. Preserve the invoice ID, transaction hash, game ID, time, and browser session. Contact the operator before retrying. These terms do not waive rights that cannot lawfully be waived.</p></section>`
    });
}

function renderPrivacy(disclosure) {
    return shell({
        title: 'Privacy Notice',
        disclosure,
        body: `
<section><h2>Data the service handles</h2><ul><li>A random browser session token stored in local storage and the matching account record.</li><li>Network and security data such as IP address, connection identifiers, rate-limit events, user agent information available to the web stack, and application logs.</li><li>Chosen display name, avatar/loadout, scores, game proofs, gameplay, leaderboard records, credit and ticket ledgers, and support evidence.</li><li>Payment addresses, payout addresses, invoice/subaddress records, transaction hashes, amounts, confirmations, and payout status. Public blockchain activity remains public independently of this service.</li><li>Chat messages and, when enabled, public keys or signed events. Global chat may be relayed to public Nostr infrastructure and should be treated as public.</li></ul></section>
<section><h2>Why it is used</h2><p>The application uses this data to resume anonymous sessions, run games, separate leaderboards, verify payments and payouts, prevent duplicate claims and abuse, investigate failures, reconcile financial records, support players, and secure the service.</p></section>
<section><h2>Where it goes</h2><p>Data is processed by the operator's hosting, reverse-proxy, database, blockchain node or wallet infrastructure, backups, and monitoring. Optional integrations shown in the product may send the necessary data to their operators—for example, public chat relays or a wallet extension. Operator-alert email receives operational alerts, not a player mailing list.</p></section>
<section><h2>Storage and retention</h2><p>Session and preference data is stored in your browser. Server records and backups are retained for operations, security, dispute handling, financial reconciliation, and applicable recordkeeping. This version does not promise a fixed deletion schedule. Blockchain and public-relay records may be impossible for the operator to delete.</p></section>
<section><h2>Your choices</h2><p>You may play free without creating a paid invoice when free play is offered. Do not put private information in a display name or chat. You may clear local storage, but doing so can permanently lose access to the anonymous account, credits, payout address, and history associated with its token. Contact the operator to ask about access, correction, or deletion where applicable; provide only enough evidence to locate the record.</p></section>
<section><h2>Security limits</h2><p>The application uses technical safeguards, but no online or cryptocurrency system is risk-free. Never share the browser session token, wallet seed, wallet password, or private key with the site or support.</p></section>`
    });
}

function renderResponsiblePlay(disclosure) {
    const network = disclosure.service?.isTestNetwork
        ? `<p class="no-real-value"><strong>Test-network reminder:</strong> ${escapeHtml(disclosure.operatedProduct?.noRealValueNotice || `${disclosure.service.currencyLabel} is for testing and has no intended monetary value. Never substitute mainnet funds.`)}</p>`
        : '';
    return shell({
        title: 'Responsible Play',
        disclosure,
        body: `
<section><h2>Know which mode you chose</h2>${modeSummary(disclosure)}${network}<p>Paid prestige and purchases can still cause financial loss through spending even when no prize is offered. Reward-enabled modes add outcome risk: you may lose the full entry and should never treat a displayed multiplier as guaranteed income.</p></section>
<section><h2>Set limits before playing</h2><ul><li>Choose a time limit and a cryptocurrency spending limit before opening an invoice.</li><li>Use only funds you can afford to lose completely. Never borrow, use essential funds, or try to recover previous losses.</li><li>Stop after the planned limit, after a loss, when frustrated, or when tired or impaired.</li><li>Keep a wallet-level spending record and review transaction history rather than relying on memory.</li><li>Do not play paid modes if you are under ${escapeHtml(disclosure.minimumAge)} or if play is unlawful where you are.</li></ul></section>
<section><h2>Take a break or stop</h2><p>Close the site, disconnect the wallet, and move play funds out of the active wallet if you need distance. This release does not provide verified identity, geolocation, deposit limits, or an automated self-exclusion system. Contact the operator to request an access block, understanding that anonymous-session and blockchain limits may constrain what can be enforced.</p><p>If play is causing distress or harm, stop paid play and seek confidential help from a qualified local health or gambling-support service. If there is immediate danger, contact local emergency services.</p></section>
<section><h2>Operational safeguards are not personal limits</h2><p>Rate limits, payout caps, reserve checks, and wallet kill switches protect service integrity; they are not a personal budget or a guarantee against loss. You remain responsible for setting stricter personal limits.</p></section>`
    });
}

module.exports = { escapeHtml, renderPrivacy, renderResponsiblePlay, renderTerms };
