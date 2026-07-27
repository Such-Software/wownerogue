'use strict';

const fs = require('fs');
const path = require('path');

const deployFile = name => fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'deploy', name),
    'utf8'
);

const directiveValues = (unit, directive) => unit
    .split(/\r?\n/)
    .filter(line => line.startsWith(`${directive}=`))
    .flatMap(line => line.slice(directive.length + 1).trim().split(/\s+/));

describe('deployment unit wallet boundaries', () => {
    test.each([
        ['monerogue', 'monerogue-wallet.service', 'monero-wallet-rpc.service'],
        ['wownerogue', 'wownerogue-wallet.service', 'wownero-wallet-rpc.service']
    ])('%s application starts only with its dedicated wallet unit', (instance, dedicated, legacy) => {
        const unit = deployFile(`${instance}.service`);

        expect(directiveValues(unit, 'After')).toContain(dedicated);
        expect(directiveValues(unit, 'Requires')).toContain(dedicated);
        expect(directiveValues(unit, 'Wants')).not.toContain(legacy);
        expect(directiveValues(unit, 'Requires')).not.toContain(legacy);
        expect(unit).toContain(`EnvironmentFile=/etc/${instance}/app.env`);
        expect(unit).toContain(`EnvironmentFile=/etc/${instance}/wallet-rpc.env`);
        for (const unsafeLoaderVariable of [
            'BASH_ENV',
            'PATH',
            'LD_PRELOAD',
            'LD_AUDIT',
            'NODE_OPTIONS',
            'OPENSSL_CONF',
            'DATABASE_URL',
            'PGPASSWORD',
            'NPM_CONFIG_NODE_OPTIONS',
            'npm_config_node_options'
        ]) {
            expect(directiveValues(unit, 'UnsetEnvironment')).toContain(unsafeLoaderVariable);
        }
    });

    test('firewall ordering covers dedicated wallets and retained rollback units', () => {
        const unit = deployFile('wowngeon-firewall.service');
        for (const service of [
            'monerogue-wallet.service',
            'wownerogue-wallet.service',
            'monero-wallet-rpc.service',
            'wownero-wallet-rpc.service'
        ]) {
            expect(unit).toContain(service);
        }
    });
});
