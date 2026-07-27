# Chat and Nostr

Chat has two layers: local delivery (Socket.IO plus Postgres history) and an optional nostr fan-out
that carries the same conversation across servers and into the Smirk ecosystem. Both sit behind one
seam, so callers are identical either way.

## The provider seam

`src/network/chat/ChatProvider.js` is the abstraction every chat caller uses:

```
publish(msg)                 deliver and (optionally) persist a message
getHistory({scope, limit})   recent messages, oldest to newest
relaySignedEvent(req)        deliver a client-signed nostr event (per-player identity)
initialize() / shutdown()
```

Application concerns (commands, moderation, rate limiting, HTML escaping) stay in the caller;
a provider only delivers and stores.

Two implementations:

- `SocketChatProvider` is the default. Scope `global` persists through `ChatHistoryManager` and
  broadcasts `chat_broadcast` to every client; a room scope such as `tavern:<id>` delivers only to
  that Socket.IO room and persists nothing. Broadcasts carry a short `publicId` (the user id, or the
  first 6 characters of the socket id) rather than the full socket id.
- `NostrChatProvider` decorates a local provider. Every message still delivers in-game and persists;
  in addition, global messages fan out to nostr relays, and messages arriving from a relay are
  delivered locally only, never re-published, so there are no echo loops.

`buildChatProvider({local, env})` in `src/network/chat/index.js` chooses between them. With
`NOSTR_CHAT_ENABLED` unset, or with `NOSTR_CHAT_SCOPE` set to anything other than `global`, it
returns the plain local provider unchanged; otherwise it wraps that provider in a
`NostrChatProvider`.

`ChatHandler` constructs the local provider (sharing its own `ChatHistoryManager` instance so ban
checks and stats keep working) and passes it through `buildChatProvider`.

## Unified global chat

`TavernManager` accepts the lobby's provider as `globalChatProvider` and publishes tavern messages to
the `global` scope, sending the global backlog as `chat_history` on join. Lobby and tavern are
therefore one conversation with persistent history, and when nostr is enabled tavern chat rides the
relay too. When no global provider is injected, the tavern falls back to its own room-scoped,
ephemeral provider.

Topology is always client to server to relay. The server remains the moderation authority (bans,
rate limits, history in Postgres); the relay is transport and fan-out.

## Identity models

`NostrChatProvider` takes an injectable signer with the contract `{ pubkey, sign(template) }`. That
one object is the whole difference between the two identity models.

### Server bridge signer

The server signs every outbound global message with a single key from `NOSTR_BRIDGE_SK`
(`createBridgeSigner`, accepting an `nsec` or 64-hex secret). The player's display name rides in an
`['n', name]` tag. This works for every player, including anonymous ones, but on nostr the whole
server reads as one account. The bridge pubkey must be accepted by the relay's write policy, either
by being a registered npub or by sitting in the relay write allowlist. With no key configured the
signer is `null` and global chat is receive-only.

### Client per-player signing

The client signs with the player's own Smirk npub and sends the finished event; the server verifies
it and relays it unmodified, so on nostr the author is genuinely the player.

```
client                          server (ChatHandler)                  relay
  build kind-1 event
  window.smirk.signNostrEvent
  emit chat_signed {event}  -->  rate limit
                                 look up session npub
                                 verifyChatEvent(event, npub)
                                   signature, id, freshness, channel tag,
                                   pubkey equals session npub
                                 relaySignedEvent            ---------->  published under
                                                                          the player's npub
       <-------------------  chat_broadcast (all in-game clients)
```

- `src/utils/verifyChatEvent.js` is the security core. It validates shape and types, rebuilds a clean
  event from primitives only, independently recomputes the event id, verifies the BIP-340 schnorr
  signature, enforces freshness (120 seconds by default), and requires the `t` tag to match the
  configured channel tag so the server cannot be used to relay arbitrary events. Critically,
  `event.pubkey` must equal the session's authenticated npub (`users.smirk_public_key`, set at NIP-98
  login); a valid signature by any other key is rejected with `pubkey-mismatch`. Content is capped at
  280 characters.
- `ChatHandler.handleSignedChatMessage` runs the sequence: rate limit, resolve the session's npub
  from the database, verify, escape, relay. A session with no linked npub is told to sign in with
  Smirk. The display name comes from `display_name` or `username`, falling back to the first 8
  characters of the npub.
- `NostrChatProvider.relaySignedEvent` performs local delivery and then `transport.publish(event)`
  with no re-signing, marking the event id as seen so the relay round-trip does not deliver it twice.
- `html/js/smirkChatSign.js` is the client helper. It signs through `window.smirk.signNostrEvent` and
  emits `chat_signed`. Signing is attempted first; on `NOT_AUTHORIZED` it calls `getNostrPublicKey()`
  once to obtain the nostr scope grant and retries, the same pattern as `SmirkAuth`, so a returning
  user sees a single approval. It resolves `false` whenever Smirk is unavailable or declines, and the
  caller then falls back to the ordinary unsigned send. The helper is loaded on `tavern.html`, whose
  send path tries it before `tavern_chat`.

The server registers the `chat_signed` socket event in `src/network/socketHandlers.js`.

## Relays and tiers

The game publishes each event to every relay in `NOSTR_RELAYS` and lets each relay's policy accept or
reject it; there is no per-player routing or allowlist in game code. Reading is the mirror: subscribe
to all relays and dedupe by event id.

| Player | Signs as | Reaches |
|--------|----------|---------|
| Anonymous | not signed | in-game chat only |
| Signed in with Smirk | own npub | in-game chat plus every relay whose write policy accepts that npub |

A premium subscription also sets the player's entitlement tier, which unlocks cosmetics; see
[MONETIZATION.md](MONETIZATION.md). Entitlements are per-pack tier based
(`src/multiplayer/entitlements.js`): buying credits maps to tier 0 and unlocks packs by lifetime
credits purchased, while a subscription tier unlocks the packs at or below that tier.

## Relay policy (smirk-backend-core)

Relay admission is configured on the relay side, in the Smirk backend that fronts nostr-rs-relay:

- `RELAY_WRITE_POLICY` is one of `inbox-outbox` (the default), `author-allowlist`, `open`, or
  `premium-post`. `premium-post` lets registered users publish wallet kinds and reserves general
  posting for premium members; `PREMIUM_ENABLED` requires this policy.
- `RELAY_WRITE_ALLOWLIST_NPUBS` (comma-separated `npub1…` or hex) exempts specific keys from the
  policy. This is how a server bridge key is registered.
- `RELAY_INBOUND_POW_BITS` applies a NIP-13 proof-of-work gate to authors that are not registered or
  allowlisted, so registered and allowlisted npubs post without PoW.
- Reading is open under every policy.

## Moderation and limits

- Inbound chat is rate limited through the shared `RateLimiter` under the `chat:message` bucket
  (12 messages per 10 seconds), keyed by a stable session id plus client IP so reconnecting cannot
  reset it. Plain lobby broadcasts add a 2 second per-socket cooldown; tavern occupants have a
  900 ms per-occupant cooldown.
- Lobby messages are rejected above 200 characters and HTML-escaped before delivery. Signed messages
  are escaped and capped at 200 characters for in-game rendering; the event published to nostr is the
  client's original, unmodified.
- Chat bans are checked against `ChatHistoryManager.isUserChatBanned` before a message is published.
  The tavern applies the same rate limiter and ban check before anything reaches global chat.
- Remote (relay-sourced) messages are escaped with `escapeChatText`, capped at 200 characters,
  attributed from the `n` tag or the first 8 characters of the author pubkey, and rate limited to
  `maxRemotePerMin` (120 per minute by default) so a hostile relay cannot flood in-game clients.
- Event ids are deduped through a bounded FIFO of the last 1000 ids, covering both the server's own
  echoes and repeats across relays.
- The relay subscription filters on `since = now` at startup, so connecting does not flood clients
  with history; local Postgres history covers the past.
- `NostrTransport` degrades to a warning and a no-op if `nostr-tools` or `ws` cannot load, so
  enabling nostr chat cannot crash the server.

## Configuration

| Variable | Meaning |
|----------|---------|
| `NOSTR_CHAT_ENABLED` | Master switch. Unset means plain local chat. Accepts `1`, `true`, `yes`, `on`. |
| `NOSTR_CHAT_SCOPE` | `global` (fan out) or anything else (plain local provider). Default `global`. |
| `NOSTR_RELAYS` | Comma-separated relay URLs. Default `wss://relay.smirk.cash`. |
| `NOSTR_CHAT_TAG` | Shared channel topic. Default `wowngeon-global`. |
| `NOSTR_CHAT_KIND` | Event kind. Default `1`. |
| `NOSTR_BRIDGE_SK` | Bridge secret key (`nsec` or 64-hex). Omit for receive-only global chat. |
| `NOSTR_SERVER_ORIGIN` | Value for the `origin` tag on bridge-signed events. Falls back to `SERVER_ID`. |

The full server environment template is `src/.env.example`.

## Loader shim

`nostr-tools` pulls ESM-only dependencies. `loadNostrTools()` in `src/utils/nostrLoader.js`
`require()`s the package under Node 22, which natively requires those dependencies, and falls back to
the pre-bundled self-contained IIFE build under a CJS-only test runtime. Chat and NIP-98 auth both
load nostr through it.

## Files

```
src/network/chat/ChatProvider.js           seam, including the default relaySignedEvent
src/network/chat/SocketChatProvider.js     local delivery and history
src/network/chat/NostrChatProvider.js      decorator: local plus nostr fan-out plus signed relay
src/network/chat/index.js                  buildChatProvider (env to provider)
src/network/chat/nostr/NostrTransport.js   SimplePool wrapper, multi-relay, degrades to no-op
src/network/chat/nostr/bridgeSigner.js     server bridge signer
src/network/chatHandler.js                 commands, moderation, signed-event handling
src/network/tavernManager.js               tavern chat routed into global chat
src/utils/verifyChatEvent.js               verify a client-signed event (impersonation guard)
src/utils/escapeChat.js                    HTML escape and length cap
src/utils/nostrLoader.js                   nostr-tools loader shim
html/js/smirkChatSign.js                   client per-player signing helper
```
