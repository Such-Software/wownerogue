(function (root) {
    'use strict';

    var policy = null;
    var policyPromise = null;
    var memoryAcceptance = null;
    var STORAGE_KEY = 'wowngeon_paid_ack';
    var ACCEPTANCE_KEYS = [
        'policyVersion',
        'ageEligible',
        'termsRead',
        'riskAccepted',
        'testnetUnderstood'
    ];

    function clearAcceptance() {
        memoryAcceptance = null;
        try { sessionStorage.removeItem(STORAGE_KEY); } catch (_) {}
    }

    function loadPolicy(options) {
        options = options || {};
        if (options.force === true) {
            policy = null;
            policyPromise = null;
        }
        if (policy) return Promise.resolve(policy);
        if (policyPromise) return policyPromise;
        var request = fetch('/api/disclosures', {
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { Accept: 'application/json' }
        }).then(function (response) {
            if (!response.ok) throw new Error('Disclosure endpoint returned ' + response.status);
            return response.json();
        }).then(function (value) {
            if (!value
                || typeof value.policyVersion !== 'string'
                || value.policyVersion.length < 1
                || value.policyVersion.length > 64
                || !value.service) throw new Error('Disclosure response is incomplete');
            // A forced refresh can supersede an older request. Only the latest in-flight request
            // may publish its result into the cache.
            if (policyPromise === request) policy = value;
            return value;
        }).catch(function (error) {
            if (policyPromise === request) policyPromise = null;
            throw error;
        });
        policyPromise = request;
        return request;
    }

    function canonicalAcceptance(value) {
        if (!value || !policy || typeof value !== 'object' || Array.isArray(value)) return null;
        var keys = Object.keys(value);
        if (keys.length !== ACCEPTANCE_KEYS.length
            || keys.some(function (key) { return ACCEPTANCE_KEYS.indexOf(key) === -1; })) return null;
        if (typeof value.policyVersion !== 'string'
            || value.policyVersion.length < 1
            || value.policyVersion.length > 64
            || value.policyVersion !== policy.policyVersion) return null;
        if (value.ageEligible !== true || value.termsRead !== true || value.riskAccepted !== true) return null;
        if (typeof value.testnetUnderstood !== 'boolean'
            || value.testnetUnderstood !== (policy.service.isTestNetwork === true)) return null;
        return {
            policyVersion: policy.policyVersion,
            ageEligible: true,
            termsRead: true,
            riskAccepted: true,
            testnetUnderstood: policy.service.isTestNetwork === true
        };
    }

    function readAcceptance() {
        var value = memoryAcceptance;
        try { value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null') || value; } catch (_) {}
        var canonical = canonicalAcceptance(value);
        if (!canonical) {
            clearAcceptance();
            return null;
        }
        memoryAcceptance = canonical;
        return canonical;
    }

    function acknowledgement() {
        var accepted = readAcceptance();
        return accepted ? Object.assign({}, accepted) : null;
    }

    function rememberAcceptance() {
        memoryAcceptance = {
            policyVersion: policy.policyVersion,
            ageEligible: true,
            termsRead: true,
            riskAccepted: true,
            testnetUnderstood: policy.service.isTestNetwork === true
        };
        try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(memoryAcceptance)); } catch (_) {}
        return acknowledgement();
    }

    function reject(details) {
        details = details || {};
        var reportedVersion = typeof details.policyVersion === 'string'
            && details.policyVersion.length > 0
            && details.policyVersion.length <= 64
            ? details.policyVersion
            : null;
        var changed = reportedVersion && (!policy || reportedVersion !== policy.policyVersion);
        clearAcceptance();
        if (changed || details.code === 'PAID_ACK_VERSION') {
            return loadPolicy({ force: true });
        }
        return policy ? Promise.resolve(policy) : loadPolicy();
    }

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function checkbox(id, labelText) {
        var label = el('label', 'commerce-check');
        var input = document.createElement('input');
        input.type = 'checkbox'; input.id = id;
        label.appendChild(input);
        label.appendChild(el('span', '', labelText));
        return { label: label, input: input };
    }

    function showModal(resolvedPolicy, onAccept) {
        var existing = document.getElementById('commerceConsentOverlay');
        if (existing) existing.remove();

        var overlay = el('div', 'commerce-consent-overlay');
        overlay.id = 'commerceConsentOverlay';
        overlay.setAttribute('role', 'presentation');
        var dialog = el('section', 'commerce-consent-dialog');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'commerceConsentTitle');

        var title = el('h2', '', 'Review paid-play disclosures');
        title.id = 'commerceConsentTitle';
        dialog.appendChild(title);

        var service = resolvedPolicy.service;
        var summary;
        if (resolvedPolicy.operatedProduct && resolvedPolicy.operatedProduct.commerceSummary) {
            summary = resolvedPolicy.operatedProduct.commerceSummary;
        } else if (service.isTestNetwork) {
            summary = service.currencyLabel + ' is valueless test-network currency. Never send mainnet ' + service.cryptoType + '.';
        } else if (service.paidPrestigeOnly) {
            summary = 'This paid mode purchases entry, credits, or products; this server currently offers no cryptocurrency prize.';
        } else if (service.anyPayoutsEnabled) {
            summary = 'This server has reward-enabled modes. A paid entry can lose its entire entry value; displayed rewards apply only to qualifying outcomes.';
        } else {
            summary = 'Blockchain payments may be irreversible. Verify the asset, network, amount, and address before sending.';
        }
        dialog.appendChild(el('p', 'commerce-summary' + (resolvedPolicy.operatedProduct && resolvedPolicy.operatedProduct.noRealValueNotice ? ' no-real-value' : ''), summary));

        var age = checkbox('commerceAge', 'I confirm I am at least ' + resolvedPolicy.minimumAge + ' and may lawfully use this paid mode where I am located.');
        var terms = checkbox('commerceTerms', 'I have read the Terms of Use and Privacy Notice, including the anonymous-session and blockchain risks.');
        var risk = checkbox('commerceRisk', service.paidPrestigeOnly
            ? 'I understand this purchase does not currently pay a cryptocurrency prize and a blockchain transfer may be irreversible.'
            : 'I understand paid play can lose the entire entry value, and previous outcomes do not predict future results.');
        var required = [age.input, terms.input, risk.input];
        dialog.appendChild(age.label);
        dialog.appendChild(terms.label);
        dialog.appendChild(risk.label);

        if (service.isTestNetwork) {
            var testnet = checkbox('commerceTestnet', 'I understand test coins have no intended monetary value and I will not send mainnet funds.');
            required.push(testnet.input);
            dialog.appendChild(testnet.label);
        }

        var links = el('p', 'commerce-links');
        [
            ['Terms', resolvedPolicy.links.terms],
            ['Privacy', resolvedPolicy.links.privacy],
            ['Responsible play', resolvedPolicy.links.responsiblePlay]
        ].forEach(function (entry, index) {
            if (index) links.appendChild(document.createTextNode(' · '));
            var link = el('a', '', entry[0]);
            link.href = entry[1]; link.target = '_blank'; link.rel = 'noopener';
            links.appendChild(link);
        });
        dialog.appendChild(links);

        var status = el('p', 'commerce-status', 'All boxes are required. This statement does not verify identity, age, or location.');
        status.setAttribute('aria-live', 'polite');
        dialog.appendChild(status);
        var actions = el('div', 'commerce-actions');
        var cancel = el('button', 'commerce-cancel', 'Cancel'); cancel.type = 'button';
        var accept = el('button', 'commerce-accept', 'Acknowledge and continue'); accept.type = 'button'; accept.disabled = true;
        actions.appendChild(cancel); actions.appendChild(accept); dialog.appendChild(actions);
        overlay.appendChild(dialog); document.body.appendChild(overlay);

        function update() { accept.disabled = !required.every(function (input) { return input.checked; }); }
        required.forEach(function (input) { input.addEventListener('change', update); });
        cancel.addEventListener('click', function () { clearAcceptance(); overlay.remove(); });
        accept.addEventListener('click', function () {
            if (accept.disabled) return;
            var ack = rememberAcceptance();
            overlay.remove();
            onAccept(ack);
        });
        age.input.focus();
    }

    function requireAcknowledgement(onAccept) {
        loadPolicy().then(function (resolvedPolicy) {
            var current = acknowledgement();
            if (current) {
                onAccept(current);
                return;
            }
            showModal(resolvedPolicy, onAccept);
        }).catch(function () {
            clearAcceptance();
            var existing = document.getElementById('commerceConsentOverlay');
            if (existing) existing.remove();
            var overlay = el('div', 'commerce-consent-overlay');
            overlay.id = 'commerceConsentOverlay';
            var dialog = el('section', 'commerce-consent-dialog');
            dialog.setAttribute('role', 'alertdialog');
            dialog.appendChild(el('h2', '', 'Paid play is unavailable'));
            dialog.appendChild(el('p', 'commerce-summary', 'The current disclosures could not be loaded. No payment or paid entry was requested. Try again after the connection recovers.'));
            var close = el('button', 'commerce-cancel', 'Close'); close.type = 'button';
            close.addEventListener('click', function () { overlay.remove(); });
            dialog.appendChild(close); overlay.appendChild(dialog); document.body.appendChild(overlay);
        });
    }

    function attach(payload) {
        var result = Object.assign({}, payload || {});
        var ack = acknowledgement();
        if (ack) result.legalAcknowledgement = ack;
        return result;
    }

    var api = {
        acknowledgement: acknowledgement,
        attach: attach,
        clear: clearAcceptance,
        loadPolicy: loadPolicy,
        reject: reject,
        require: requireAcknowledgement
    };
    root.CommerceConsent = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
