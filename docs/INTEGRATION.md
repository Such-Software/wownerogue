# Smirk Wallet Integration

How Wownerogue integrates with the [Smirk](https://smirk.cash) browser extension for wallet-based authentication.

---

## Overview

Smirk injects a `window.smirk` API (similar to MetaMask's `window.ethereum`) that websites can use to:

1. Request wallet connection (get public keys)
2. Request message signatures (for authentication)
3. Get wallet addresses (for payouts)
4. Request payments (send WOW directly from extension)

Wownerogue uses the WOW (Wownero) key for authentication via a challenge-response signature flow, and `requestPayment()` for in-extension payment prompts.

---

## Authentication Flow

```
Client                        Server                      Extension
  |                             |                             |
  |-- POST /challenge --------->|                             |
  |<-------- { challenge } -----|                             |
  |                             |                             |
  |-- smirk.connect() ---------------------------------->|
  |<-------------- { publicKeys } -----------------------|
  |                             |                             |
  |-- smirk.signMessage(challenge) --------------------->|
  |<-------------- { signatures[] } ---------------------|
  |                             |                             |
  |-- POST /verify ------------>|                             |
  |   { challenge, publicKey,   |                             |
  |     signature, socketId }   |                             |
  |<------ { linked: true } ----|                             |
  |                             |                             |
  |-- smirk.getAddresses() ------------------------------>|
  |<-------------- { wow: "Wo..." } ---------------------|
  |                             |                             |
  |-- socket: address:update -->|                             |
```

---

## API Endpoints

### POST `/api/auth/smirk/challenge`

Generate a challenge for signature verification.

**Request:**
```json
{ "socketId": "<socket.io id>" }
```

**Response:**
```json
{ "challenge": "<64-char hex string>", "expiresIn": 300 }
```

The challenge is a random 32-byte hex string stored in the database with a 5-minute TTL.

### POST `/api/auth/smirk/verify`

Verify a wallet signature and link it to the user session.

**Request:**
```json
{
  "socketId": "<socket.io id>",
  "challenge": "<the challenge string>",
  "publicKey": "<Ed25519 public key, hex>",
  "signature": "<Ed25519 signature, hex>"
}
```

**Response (success):**
```json
{ "success": true, "linked": true, "message": "Smirk wallet linked successfully" }
```

**Errors:**
- `400` - Missing fields, invalid/expired challenge, invalid signature, or wallet already linked to another account
- `404` - No active session for the given socketId

### GET `/api/auth/smirk/status`

Check if a session has a linked wallet.

**Query:** `?socketId=<socket.io id>`

**Response:**
```json
{ "linked": true, "hasPayoutAddress": true }
```

---

## Signature Verification

The Smirk extension signs messages using Ed25519 with a **SHA256 prehash**:

1. Extension receives the challenge string (e.g. `"a1b2c3..."`)
2. Extension computes `msgHash = SHA256(UTF8_encode(challenge))`
3. Extension signs `msgHash` with the Ed25519 private spend key
4. Extension returns the 64-byte signature as hex

The server must verify against the same prehash:

```javascript
const crypto = require('crypto');
const nacl = require('tweetnacl');

const challengeHash = crypto.createHash('sha256').update(challenge).digest();
const signatureBytes = Buffer.from(signature, 'hex');
const publicKeyBytes = Buffer.from(publicKey, 'hex');

const valid = nacl.sign.detached.verify(challengeHash, signatureBytes, publicKeyBytes);
```

**Important:** Do NOT verify against `Buffer.from(challenge, 'hex')` (the raw hex-decoded bytes). The extension always SHA256-hashes the message string before signing.

---

## `window.smirk` API Reference

The extension injects a frozen `window.smirk` object on all pages.

### Detection

```javascript
if (typeof window.smirk !== 'undefined') {
  // Extension is installed
}
```

### `smirk.connect()` -> `Promise<PublicKeys>`

Requests user approval to share public keys. Opens an approval popup on first use; subsequent calls from an approved origin return keys immediately.

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

Prompts the user to send a payment from their Smirk wallet. Opens an approval popup showing the recipient address, amount, and description. Resolves when the user confirms and the TX is broadcast; rejects if the user denies or the extension context is invalid.

```javascript
const result = await window.smirk.requestPayment({
  address: 'Wo3MWeLE...',   // Recipient address
  amount: '1',              // Human-readable amount (NOT atomic units)
  asset: 'wow',             // Asset ticker (lowercase)
  description: 'Single game entry'  // Shown in approval popup
});
// result.txid   - Transaction hash (hex)
// result.amount - Amount sent (string)
```

**Important:** The `amount` field must be the human-readable value (e.g. `"1"` for 1 WOW), not atomic units. The extension handles conversion internally.

**Error cases:**
- User clicks "Deny" → rejects with user cancellation error
- Extension context invalidated (browser reloaded extension) → rejects with `"Extension context invalidated"`. The page must be refreshed to re-establish the connection.

### `smirk.isConnected()` -> `Promise<boolean>`

Check if the current origin is connected (approved).

### `smirk.disconnect()` -> `Promise<void>`

Revoke site access.

### `smirk.getPublicKeys()` -> `Promise<PublicKeys | null>`

Get public keys without prompting (only works if already connected). Returns `null` if not connected.

---

## Client-Side Implementation

See `html/js/network/smirkAuth.js` for auth and `html/js/network/socketHandlers.js` (`_trySmirkPayment`) for payments. Key points:

- The `SmirkAuth` module is initialized after DOM ready and socket connection
- It checks `SocketHandlers._smirkEnabled` (set by server's `game_mode_info` event) to gate the feature
- On successful auth, it calls `smirk.getAddresses()` to auto-set the payout address via `socket.emit('address:update')`
- The button shows install link if extension is not detected, connect button if it is
- When a Smirk-connected user triggers a payment, `_trySmirkPayment()` calls `smirk.requestPayment()` with the human-readable amount. If the user confirms, the TX is broadcast and the server's existing mempool monitoring detects it. If the user denies or the extension context is stale, it falls back to the normal address/QR payment modal.

---

## Database

The `smirk_challenges` table stores pending challenges:

| Column | Type | Description |
|--------|------|-------------|
| id | serial | Primary key |
| challenge | text | 64-char hex challenge string |
| socket_id | text | Socket.io session ID |
| used | boolean | Whether challenge has been consumed |
| expires_at | timestamp | Auto-set to NOW() + 5 minutes |
| created_at | timestamp | Row creation time |

The `users` table has a `smirk_public_key` column that stores the linked Ed25519 public key (hex).

---

## Signature Schemes by Asset

| Asset | Curve | Hash | Format |
|-------|-------|------|--------|
| BTC | secp256k1 (ECDSA) | Double SHA256 with Bitcoin message prefix | Compact signature (64 bytes) |
| LTC | secp256k1 (ECDSA) | Double SHA256 with Bitcoin message prefix | Compact signature (64 bytes) |
| XMR | Ed25519 | SHA256 prehash | R \|\| s (64 bytes) |
| WOW | Ed25519 | SHA256 prehash | R \|\| s (64 bytes) |
| GRIN | Ed25519 | SHA256 prehash | R \|\| s (64 bytes) |

Wownerogue only uses the WOW signature for authentication.
