#!/bin/sh
set -eu

# Idempotent application/RPC isolation. Install mode 0755 at
# /usr/local/sbin/wowngeon-firewall and provide NPM_SOURCE_IPV4 through the unit's EnvironmentFile.
: "${NPM_SOURCE_IPV4:?Set NPM_SOURCE_IPV4 to the reverse proxy address}"

ensure_rule() {
    command_name=$1
    shift
    if ! "$command_name" -C INPUT "$@" 2>/dev/null; then
        "$command_name" -I INPUT 1 "$@"
    fi
}

# Only the reverse proxy (and local probes) may reach either Node listener.
ensure_rule /usr/sbin/iptables ! -i lo ! -s "$NPM_SOURCE_IPV4" \
    -p tcp -m multiport --dports 3000,3001 -j REJECT
ensure_rule /usr/sbin/ip6tables ! -i lo \
    -p tcp -m multiport --dports 3000,3001 -j REJECT

# Wallet and daemon JSON-RPC are local control planes. P2P ports are intentionally untouched.
ensure_rule /usr/sbin/iptables ! -i lo \
    -p tcp -m multiport --dports 34568,34570,38081,38083 -j REJECT
ensure_rule /usr/sbin/ip6tables ! -i lo \
    -p tcp -m multiport --dports 34568,34570,38081,38083 -j REJECT
