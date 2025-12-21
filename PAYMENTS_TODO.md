# Payments System TODO

This document tracks remaining work for the payment system before production release.

## ✅ Completed

### Mixed Mode Logic Bug - FIXED
~~The backend uses a single `gameMode` value (`PAID_SINGLE` or `PAID_CREDITS`), but the config allows both modes to be enabled simultaneously.~~

**Implemented:**
- Added `getEffectiveModeForUser(socketId)` - determines mode per-user based on credits balance
- Refactored `canUserStartGame()` to check credits first, then confirmed payments
- Added `getPaymentOptionsForUser(socketId)` for dynamic UI rendering
- Created `_processGameStartWithCredits()` and `_processGameStartWithPayment()` methods
- Frontend PaymentUI now dynamically shows options based on user's credits and enabled modes

### Credits Package Amount Bug - FIXED
~~In `src/payments/moneroPayService.js#L150`, credits are hardcoded to +10~~

**Implemented:**
- Added `processCreditsPackageConfirmation(socketId, paymentId, packageInfo)` to `gameModeManager.js`
- Credits now parsed from package info (credits + bonus) passed from confirmation handler
- Falls back to parsing from payment description if package info missing
- Updated `paymentHandlers.js` to track `paymentType` and call confirmation method with package data

### Payment Tests - Added
- Created `test/gameModeManager.test.js` with 17 tests covering:
  - `getEffectiveModeForUser` - all mode combinations
  - `calculatePayout` - direct and credits modes
  - `getPaymentOptionsForUser` - credits, direct, buy options
  - `processCreditsPackageConfirmation` - from package info and fallback
  - `canUserStartGame` - mixed mode scenarios

---

## 🟡 Important (Should Fix Before Beta)

### Frontend UX Polish
- [x] Show user's current credit balance in mode selection modal
- [x] If user has credits, highlight "Use 1 Credit" as primary action
- [x] Add "Buy More Credits" secondary button
- [x] Show payout eligibility per mode (Direct = payouts, Credits = no payouts)

### Session Persistence Documentation
- [x] Add info tooltip near "Manage Payout Address" explaining session persistence
- [x] Update README with session/cookie requirements
- [x] Show warning if localStorage is unavailable (private browsing)

---

## 🟢 Nice to Have (Post-Beta)

### Smart Payment Flow
- [ ] If user has credits, skip payment modal and start game directly
- [ ] "Auto-buy credits" when balance is low (opt-in)
- [ ] Show estimated games remaining based on credits

### Payment History
- [ ] `/api/user/:socketId/payments` - List payment history
- [ ] `/api/user/:socketId/payouts` - List payout history
- [ ] Frontend "Transaction History" panel

### Refund Flow
- [ ] Admin endpoint to refund a payment
- [ ] Partial credit refunds

---

## Session Persistence - User-Facing Documentation

Add to README and/or in-game help:

> **How Sessions Work**
> 
> Your payout address and credit balance are tied to a session token stored in your browser.
> 
> - ✅ **Works:** Normal browsing, closing/reopening browser, refreshing page
> - ⚠️ **Lost if:** You clear cookies/localStorage, use private/incognito mode, switch browsers
> 
> **Tip:** After setting your payout address, note your session token (shown once) if you want to recover your session on a new device.

---

## Test Coverage Checklist

| Area | Unit Tests | Integration Tests |
|------|------------|-------------------|
| Payment creation | ✅ | ✅ |
| Payment confirmation | ✅ | ✅ |
| Credits purchase | ✅ | ❌ |
| Credits deduction | ✅ | ❌ |
| Payout creation | ⚠️ Mocked | ❌ |
| Payout processing | ❌ | ❌ |
| Mixed mode selection | ✅ | ❌ |
| Session resume | ❌ | ❌ |

---

## Environment Config Validation

When both modes are enabled, ensure:
- [ ] `CREDITS_PAYOUTS_ENABLED=false` when credits mode has no payouts (prevent config mistakes)
- [ ] Warn if `DIRECT_PAYOUTS_ENABLED=true` but no wallet RPC configured
- [ ] Validate `CREDITS_PACKAGES` JSON is well-formed at startup