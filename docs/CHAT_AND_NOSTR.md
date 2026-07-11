# Chat & Nostr (P5)

Chat has two layers: **local delivery** (Socket.IO + Postgres history) and an optional **nostr fan-out**
that carries the same conversation across servers and into the Smirk ecosystem. Both sit behind one
seam so callers never change.

## The seam

`src/network/chat/ChatProvider.js` — the abstraction every chat caller uses:

```
publish(msg)                 deliver + (optionally) persist a message
getHistory({scope, limit})   recent messages, oldest → newest
relaySignedEvent(req)        deliver a CLIENT-signed nostr event (per-player identity)
initialize() / shutdown()
```

Two implementations:

- **`SocketChatProvider`** — the default. Global scope → persist via `ChatHistoryManager` + broadcast
  (`chat_broadcast`); room scope (tavern) → deliver to that Socket.IO room only.
- **`NostrChatProvider`** — a **decorator** around a local provider. Everything still delivers in-game +
  persists; on top of that, global messages fan out to nostr relays, and messages arriving from a relay
  are delivered locally-only (never re-published → no echo loops).

`buildChatProvider({local, env})` (`src/network/chat/index.js`) picks: with `NOSTR_CHAT_ENABLED` unset it
returns the plain local provider (behavior-preserving); enabled + `scope=global` wraps it in a
`NostrChatProvider`.

## Unified global chat

The **tavern shares the lobby's global chat** — `TavernManager` takes the lobby's `chatProvider` and
publishes to the `global` scope, and sends the global backlog (`chat_history`) on join. So lobby and
tavern are one conversation with persistent history, and when nostr is on, tavern chat rides the relay
too. Topology is always **client → server → relay**: the server stays the moderation authority (bans,
rate-limit, history in Postgres); the relay is transport + fan-out.

## Signer models

`NostrChatProvider` takes an injectable **signer** (`{ pubkey, sign(template) }`). That one object is the
whole difference between the two identity models:

### Phase 1 — bridge (shipped, live)
The server signs every global message with one allowlisted bridge npub; the player's name rides in an
`['n', name]` tag. Works for anyone (even anon), but on nostr it reads as one account talking for
everyone. `createBridgeSigner(NOSTR_BRIDGE_SK)` builds it; the npub must be write-allowlisted on the relay
(see *Relay policy*).

### Phase 2 — per-player signing (built; one real-wallet click to confirm)
The **client** signs with the player's own Smirk npub and sends the finished event; the server verifies +
relays it. On nostr it's genuinely *them*.

```
client                         server (chatHandler)                  relay
  │ build kind-1 event           │                                     │
  │ window.smirk.signNostrEvent  │                                     │
  │ ── chat_signed {event} ────► │ rate-limit                          │
  │                              │ verifyChatEvent(event, npub)        │
  │                              │   sig ok? id ok? fresh? tag ok?     │
  │                              │   pubkey === session npub? ◄── the  │
  │                              │        impersonation guard           │
  │                              │ escape + relaySignedEvent ──────────►│ (published under the player's npub)
  │ ◄──────── chat_broadcast (in-game, all clients) ──────────────────│
```

- **`src/utils/verifyChatEvent.js`** — the security core. Same defenses as `verifyNip98Event` (rebuild a
  clean event, independently recompute the id, verify schnorr, freshness) **plus** `event.pubkey` must
  equal the session's authenticated npub (`users.smirk_public_key`, set at NIP-98 login). A valid signature
  by *some other* key is rejected (`pubkey-mismatch`).
- **`chatHandler.handleSignedChatMessage`** — rate-limit → resolve session npub → verify → escape → relay.
- **`NostrChatProvider.relaySignedEvent`** — local delivery + `transport.publish(signedEvent)` (no
  re-signing) + echo-dedupe on the event id.
- **`html/js/smirkChatSign.js`** — feature-detected client helper. Signs via `window.smirk.signNostrEvent`
  with the Nostr-scope-grant retry (sign first; on `NOT_AUTHORIZED`, `getNostrPublicKey()` once and
  retry — same pattern as `SmirkAuth`), so a returning user gets a single approval. Falls back to the
  unsigned send when Smirk isn't connected, so wiring it into a send site is always safe. Loaded on
  `tavern.html`; the tavern send tries it first. (A real Smirk wallet click is the only step left to
  confirm end to end.)

## The tier model (two relays)

Everyone signed-in **self-signs as themselves**; the tier is only which relay accepts them, and what perks
come with it (perks + cosmetics, never identity):

| Player | Signs | Lands on |
|--------|-------|----------|
| Anon | nobody | local only |
| Free "pleb" | own npub | `relay.smirk.cash` — open signup + PoW |
| Premium | own npub + ✦ badge | `relay.wowne.ro` — premium-post |

The game publishes each signed event to **all** `NOSTR_RELAYS` and lets each relay's policy accept or
reject — no per-player routing or allowlist in game code. Reading is the mirror (subscribe to all, dedupe
by event id). Premium membership also sets the player's **entitlement tier**, which unlocks cosmetics
(see [MONETIZATION.md](MONETIZATION.md)) — one subscription, two payoffs.

## Config (env)

| Var | Meaning |
|-----|---------|
| `NOSTR_CHAT_ENABLED` | master switch (unset ⇒ plain local chat) |
| `NOSTR_CHAT_SCOPE` | `global` (fan out) or `local` (plain provider) |
| `NOSTR_RELAYS` | CSV of relay URLs; transport publishes/subscribes to all |
| `NOSTR_CHAT_TAG` | shared channel topic (default `wowngeon-global`) |
| `NOSTR_BRIDGE_SK` | bridge secret key (nsec/hex); omit ⇒ receive-only |

## Relay policy (smirk-backend-core)

`relay.smirk.cash` is a nostr-rs-relay gated by the Smirk backend's admission oracle. Write policy
`premium-post` = only premium (or write-allowlisted) npubs may publish; `RELAY_WRITE_ALLOWLIST_NPUBS`
(comma-separated npub1…/hex) exempts specific keys — that's how the **bridge npub is registered**. PoW
(`RELAY_INBOUND_POW_BITS`) only gates non-registered authors, so allowlisted/premium npubs post freely.
Reading is open.

## Loader shim

`nostr-tools` pulls ESM-only deps. `src/utils/nostrLoader.js` `loadNostrTools()` require()s it in prod
Node 22 and falls back to the pre-bundled IIFE under CJS-only Jest. Chat + NIP-98 both use it.

## Files

```
src/network/chat/ChatProvider.js          seam (+ relaySignedEvent default)
src/network/chat/SocketChatProvider.js     local delivery + history
src/network/chat/NostrChatProvider.js      decorator: local + nostr fan-out + signed relay
src/network/chat/index.js                  buildChatProvider (env → provider)
src/network/chat/nostr/NostrTransport.js   SimplePool wrapper (multi-relay, degrades to noop)
src/network/chat/nostr/bridgeSigner.js     server bridge signer
src/utils/verifyChatEvent.js               verify a client-signed event (impersonation guard)
src/utils/nostrLoader.js                   nostr-tools loader shim
html/js/smirkChatSign.js                   client per-player signing helper
```
