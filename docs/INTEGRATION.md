# Smirk Wallet Integration

How Wowngeon integrates with the [Smirk](https://smirk.cash) browser extension for wallet-based
sign-in, payments, and signed chat.

Smirk injects a frozen `window.smirk` object on every page, in the style of `window.ethereum`. Sites
use it to request public keys, request signatures, read wallet addresses, and prompt an in-extension
payment. Wowngeon uses all four.

---

## Enablement

Smirk is opt-in and mainnet-only:

- `SMIRK_ENABLED=true` must be set (see `src/.env.example`).
- `src/auth/smirkPolicy.js` forces the feature off on any test network (stagenet/testnet),
  regardless of `SMIRK_ENABLED`.
- The auth routes in `src/routes/auth.js` are only mounted when the policy returns true
  (`src/index.js`).
- The server advertises the resolved state to clients as `smirkEnabled` on the `game_mode_info`
  socket event. The client fails closed: `SmirkAuth.init()` returns early unless
  `SocketHandlers._smirkEnabled === true`.

---

## Authentication

Two proof shapes are accepted. The client prefers NIP-98 and falls back to the legacy Ed25519 path
when the wallet does not advertise nostr signing, or when nostr signing fails for any reason other
than an explicit user cancellation.

Every auth call is session-gated. The caller must send the browser's session bearer token in the
`X-Session-Token` header (`users.anon_token`, stored client-side as `wownerogue_token`). The token
proves ownership of the socket, which by itself is public: Socket.IO ids are broadcast in Tavern and
match state, so a socket id alone can never authorize attaching a wallet key.

```
Client                          Server                       Extension
  |                               |                              |
  |-- POST /challenge ----------->|                              |
  |   X-Session-Token, socketId   |                              |
  |<------- { challenge } --------|                              |
  |                               |                              |
  |-- smirk.signNostrEvent(evt) ------------------------------->|
  |<---------------- signed kind:27235 event -------------------|
  |                               |                              |
  |-- POST /verify -------------->|                              |
  |   X-Session-Token,            |                              |
  |   { socketId, event }         |                              |
  |<---- { linked: true, ... } ---|                              |
  |                               |                              |
  |-- smirk.getAddresses() ------------------------------------>|
  |<---------------- { wow: "Wo..." } -------------------------|
  |                               |                              |
  |-- socket: address:update ---->|                              |
```

### POST `/api/auth/smirk/challenge`

Issue a single-use nonce.

**Headers:** `X-Session-Token: <session token>`

**Request:**
```json
{ "socketId": "<socket.io id>" }
```

**Response:**
```json
{ "challenge": "<64-char hex string>", "expiresIn": 300 }
```

The challenge is 32 random bytes, hex encoded, inserted into `smirk_challenges` bound to both the
socket id and the stable `users.id` resolved from the session token. It expires after five minutes.
Each call also prunes expired rows and consumed rows older than one hour.

Rate limit: 10 requests per minute per IP.

### POST `/api/auth/smirk/verify`

Verify a wallet proof and link the wallet to the account.

**Headers:** `X-Session-Token: <session token>`

**Request (NIP-98, preferred):**
```json
{
  "socketId": "<socket.io id>",
  "event": { "kind": 27235, "created_at": 0, "pubkey": "", "id": "", "sig": "", "content": "", "tags": [] }
}
```

**Request (legacy Ed25519):**
```json
{
  "socketId": "<socket.io id>",
  "challenge": "<the challenge string>",
  "publicKey": "<Ed25519 public key, hex>",
  "signature": "<Ed25519 signature, hex>"
}
```

The route selects the NIP-98 path when `event` is a non-array object, and the legacy path otherwise.

**Response (wallet linked to the current account):**
```json
{ "success": true, "linked": true, "message": "Smirk wallet linked successfully" }
```

**Response (wallet already owned an account, so the caller is signed in to it):**
```json
{
  "success": true,
  "linked": true,
  "adopted": true,
  "sessionToken": "<rotated bearer token for the wallet's account>",
  "address": "<that account's payout address or null>",
  "message": "Signed in to your wallet-linked account."
}
```

**Errors** are returned as `{ "error": "<CODE>", "message": "<safe text>" }`:

| Status | Code | Cause |
|--------|------|-------|
| 400 | `VALIDATION_ERROR` | Missing or oversized `socketId`, missing proof fields, invalid/expired/already-used challenge, unverifiable event or signature |
| 401 | `SESSION_TOKEN_REQUIRED` | No `X-Session-Token` header |
| 403 | `SESSION_OWNERSHIP_REQUIRED` | Token does not own the given `socketId` |
| 409 | `WALLET_ADOPTION_CONFLICT`, `SOCKET_OWNERSHIP_CONFLICT` | Concurrent sign-in raced the adoption transaction; retry |
| 429 | rate limited | More than 20 verify attempts per minute from one IP; `Retry-After` is set |

### GET `/api/auth/smirk/status`

Report whether the caller's own account has a linked wallet.

**Query:** `?socketId=<socket.io id>`
**Headers:** `X-Session-Token: <session token>`

**Response:**
```json
{ "linked": true, "hasPayoutAddress": true }
```

The caller is identified by the session token alone, because `socket_id` is volatile and changes on
every refresh or reconnect; matching on the unguessable token gives the same guarantee (a caller can
only read its own state) without breaking after a reload. `socketId` remains a required query
parameter for API shape. A missing token returns 401 and an unknown token returns 403; neither
discloses anything about another account.

---

## Account adoption

`smirk_public_key` carries a unique index over non-null values, so one wallet key maps to at most one
account. When the proven key already belongs to a different account, verification does not fail.
Instead a single transaction:

1. Re-locks and re-checks the presented session row.
2. Revokes the caller's temporary anonymous account (clears its `socket_id`, rotates its token).
3. Rotates the wallet owner's bearer token and assigns the caller's socket to that account.
4. Confirms exactly one account now owns the socket.

The response carries the rotated token as `sessionToken` with `adopted: true`. Live sockets for both
accounts are disconnected after the response is sent, so nothing keeps running under stale identity.
The client stores the new token in `localStorage` and reloads, which re-establishes credits, payout
address, and history as the wallet's account.

---

## Proof verification

### NIP-98 (`src/utils/nip98.js`)

The challenge nonce is consumed first, atomically. A single
`UPDATE ... WHERE used = FALSE ... RETURNING` flips the row for exactly one caller, so concurrent
requests cannot both pass and there is no select-then-update window. The event is then verified
against that exact nonce.

Verification requires all of:

- Well-formed kind `27235` event: numeric `kind` and `created_at`, 64-hex `pubkey` and `id`, 128-hex
  `sig`, string `content`, and `tags` as an array of string arrays.
- The event id independently recomputed with `getEventHash` and matching the claimed id. This
  catches content or tag tampering without relying on any verification memoization inside
  nostr-tools, which stamps its result onto the event object.
- A valid BIP-340 schnorr signature over secp256k1.
- `|now - created_at| <= 120` seconds.
- Exactly one `method` tag equal to `POST`.
- Exactly one `u` tag whose URL path ends with `/api/auth/smirk/verify` and whose host equals the
  expected host.
- Exactly one `challenge` tag equal to the consumed nonce.

The expected host comes from `HOSTED_BY` when configured, falling back to the request's own host for
development and self-hosted deployments. The host check is a hard requirement, not a nicety: path
matching alone would accept an event the same wallet signed for any other site whose path ends the
same way, and because verification adopts whichever account owns the key and returns its session
token, a borrowed event would be a full account takeover.

Verification is a pure function with no I/O, so it round-trips in unit tests against nostr-tools.
The proven `pubkey` is an x-only secp256k1 nostr key, a different key namespace from the legacy
Ed25519 spend key, so a NIP-98 sign-in registers the account under the nostr key.

### Legacy Ed25519

The nonce is consumed the same way, then the signature is verified over the raw UTF-8 bytes of the
challenge string per RFC 8032:

```javascript
const nacl = require('tweetnacl');

const challengeBytes = Buffer.from(challenge, 'utf8');
const signatureBytes = Buffer.from(signature, 'hex');
const publicKeyBytes = Buffer.from(publicKey, 'hex');

const valid = nacl.sign.detached.verify(challengeBytes, signatureBytes, publicKeyBytes);
```

There is no SHA256 pre-hash and no hex-decode of the challenge: the bytes signed are the bytes of
the challenge string itself.

---

## `window.smirk` API reference

### Detection

```javascript
if (typeof window.smirk !== 'undefined') {
  // Extension is installed
}
```

Capabilities are feature-detected individually. Nostr support is detected as
`typeof window.smirk.signNostrEvent === 'function' && typeof window.smirk.getNostrPublicKey === 'function'`.

### `smirk.connect()` -> `Promise<PublicKeys>`

Requests user approval to share public keys. Opens an approval popup on first use; later calls from
an approved origin return keys immediately.

```javascript
const keys = await window.smirk.connect();
// keys.wow  - Ed25519 public spend key (hex)
// keys.btc  - secp256k1 compressed public key (hex)
// keys.ltc  - secp256k1 compressed public key (hex)
// keys.xmr  - Ed25519 public spend key (hex)
// keys.grin - Ed25519 public key (hex)
```

### `smirk.signMessage(message)` -> `Promise<SignResult>`

Signs a message with all wallet keys. Always prompts for user approval.

```javascript
const result = await window.smirk.signMessage(challenge);
const wowSig = result.signatures.find(s => s.asset === 'wow');
// wowSig.signature - 64-byte Ed25519 signature (hex)
// wowSig.publicKey - public key that signed (hex)
```

Message limit: 10,000 characters.

### `smirk.getNostrPublicKey()` -> `Promise<string>`

Returns the wallet's x-only nostr public key and grants the origin the Nostr scope. The grant is
one-time per origin.

### `smirk.signNostrEvent(template)` -> `Promise<Event>`

Signs a nostr event template, filling in `pubkey`, `id`, and `sig`. Throws `NOT_AUTHORIZED` when the
origin does not yet hold the Nostr scope. Both call sites therefore sign first and only call
`getNostrPublicKey()` on that error, so a returning user sees one approval rather than two. The
wallet still asks per signature for kind 27235; that prompt cannot be suppressed.

### `smirk.getAddresses()` -> `Promise<Addresses>`

Returns wallet addresses for all assets. Requires prior `connect()`.

```javascript
const addrs = await window.smirk.getAddresses();
// addrs.wow  - "Wo..." (97-char CryptoNote standard address)
// addrs.btc  - "bc1q..." (bech32 P2WPKH)
// addrs.ltc  - "ltc1q..." (bech32 P2WPKH)
// addrs.xmr  - "4..." (95-char CryptoNote standard address)
// addrs.grin - "grin1..." (bech32 slatepack address)
```

### `smirk.requestPayment(options)` -> `Promise<PaymentResult>`

Prompts the user to send a payment. Opens an approval popup showing the recipient address, amount,
and description. Resolves once the user confirms and the transaction is broadcast; rejects if the
user denies or the extension context is invalid.

```javascript
const result = await window.smirk.requestPayment({
  address: 'Wo3MWeLE...',           // Recipient address
  amount: '1',                      // Human-readable amount, not atomic units
  asset: 'wow',                     // Asset ticker, lowercase
  description: 'Single game entry'  // Shown in the approval popup
});
// result.txid   - Transaction hash (hex)
// result.amount - Amount sent (string)
```

`amount` is the human-readable value, for example `"1"` for 1 WOW. The extension converts to atomic
units internally.

Rejection cases: the user denies the popup, or the extension context is invalidated (the browser
reloaded the extension), which rejects with `"Extension context invalidated"` and requires a page
refresh to re-establish the connection.

### `smirk.isConnected()` -> `Promise<boolean>`

Whether the current origin is approved.

### `smirk.disconnect()` -> `Promise<void>`

Revoke site access.

### `smirk.getPublicKeys()` -> `Promise<PublicKeys | null>`

Public keys without prompting. Returns `null` when the origin is not connected.

---

## Client implementation

**Sign-in:** `html/js/network/smirkAuth.js`.

- `SmirkAuth.init()` runs when `game_mode_info` arrives, with a 3-second fallback timer, and only
  when the server advertised `smirkEnabled === true`. Double initialization is guarded.
- With the extension present it renders a connect button and calls `checkStatus()` to show the
  already-linked state on load; without it, an install link to `https://smirk.cash` is shown.
- `login()` fetches a challenge, runs the NIP-98 or legacy proof, and on an `adopted` response stores
  the returned `sessionToken` and reloads the page.
- Otherwise it calls `getAddresses()` and emits `address:update` with `addresses.wow` to set the
  payout address. A failure here is non-fatal: the user is told to set the address manually.
- A `LOCKED` error is surfaced as an unlock prompt rather than a failure, because current wallet
  builds open the unlock popup from `connect()` and `signNostrEvent()` while older builds throw.

**Payments:** `_trySmirkPayment` in `html/js/network/socketHandlers.js`.

- On the `payment_created` event, the client uses `requestPayment()` when `SmirkAuth._isLinked` is
  true, the extension is present, and it exposes `requestPayment`.
- The amount sent is `data.humanAmount || data.amountFormatted || String(data.amount)`, and the asset
  is the active crypto type lowercased. The description varies by payment type: game entry, credits
  package, or cosmetic pack.
- On success the normal server-side mempool monitoring completes the flow; the UI moves to a
  waiting-for-confirmation state.
- On rejection the client falls back to the address and QR modal. A user denial keeps the linked
  state; any other error clears `SmirkAuth._isLinked` so later payments go straight to the manual
  flow.

**Chat signing:** `html/js/smirkChatSign.js`.

- `smirkChatSign(socket, text, tag)` signs a kind:1 event carrying a `t` tag (default
  `wowngeon-global`) and emits it as `chat_signed`.
- It resolves `false` whenever signing is unavailable or declined, so callers fall back to the normal
  unsigned send. Feature detection is end to end, which makes wiring it into a send site safe even
  when no wallet is connected.
- The server verifies the event in `src/utils/verifyChatEvent.js` and binds the author to the npub
  the session authenticated as, so a player can only post as themselves. A valid signature by some
  other key is rejected.

---

## Database

`smirk_challenges` holds pending nonces (migrations `009_smirk_integration.sql` and
`036_smirk_challenge_user_binding.sql`):

| Column | Type | Description |
|--------|------|-------------|
| id | serial | Primary key |
| challenge | varchar(64), unique | Hex challenge string |
| socket_id | varchar(255) | Socket.IO session id the nonce was issued to |
| user_id | integer, not null | Owning `users.id`, cascade delete |
| used | boolean | Whether the nonce has been consumed |
| expires_at | timestamp | Defaults to `NOW() + 5 minutes` |
| created_at | timestamp | Row creation time |

`users.smirk_public_key` (`varchar(128)`) stores the linked key, with a unique index over non-null
values. Migration 036 also adds a unique index on non-null `users.socket_id`, making single socket
ownership structural; the migration aborts if duplicate rows exist.

---

## Signature schemes by asset

| Asset | Curve | Hash | Format |
|-------|-------|------|--------|
| BTC | secp256k1 (ECDSA) | Double SHA256 with Bitcoin message prefix | Compact signature (64 bytes) |
| LTC | secp256k1 (ECDSA) | Double SHA256 with Bitcoin message prefix | Compact signature (64 bytes) |
| XMR | Ed25519 | Raw message bytes (RFC 8032) | R \|\| s (64 bytes) |
| WOW | Ed25519 | Raw message bytes (RFC 8032) | R \|\| s (64 bytes) |
| GRIN | Ed25519 | Raw message bytes (RFC 8032) | R \|\| s (64 bytes) |

Nostr signing (`signNostrEvent`) is separate from all of these: BIP-340 schnorr over secp256k1 with
an x-only public key.

Wowngeon's legacy sign-in path uses only the WOW signature. The NIP-98 path uses only the nostr key.
