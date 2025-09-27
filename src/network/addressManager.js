/**
 * AddressManager
 * Handles detection, pending confirmation, validation, and persistence of payout addresses.
 * Keeps socketHandlers slimmer by encapsulating this concern.
 */
class AddressManager {
  constructor({ gameModeManager, broadcastManager, io, debugManager, onConfirmed = null }) {
    this.gameModeManager = gameModeManager;
    this.broadcastManager = broadcastManager;
    this.io = io;
    this.debugManager = debugManager;
    this.pending = new Map(); // socketId -> address awaiting confirmation
    this.onConfirmed = onConfirmed; // optional callback(socketId, accepted, address)
  }

  detectInText(text) {
    if (!text || typeof text !== 'string') return null;
    const re = /((?:4|8)[0-9A-Za-z]{90,110}|Wo[0-9A-Za-z]{88,110})/; // Monero / Wownero style
    const m = text.match(re);
    if (!m) return null;
    if (m[1].length < 80) return null;
    return m[1];
  }

  async handleDetection(socketId, address) {
    try {
      if (this.gameModeManager) {
        const userRow = await this.gameModeManager.getOrCreateUser(socketId);
        if (userRow && userRow.payout_address === address) {
          this.io.to(socketId).emit('address_confirmed', { address, message: 'Payout address already set.' });
          return;
        }
      }
    } catch (e) {
      if (this.debugManager?.CONSOLE_LOGGING) console.warn('Address detection user lookup failed:', e.message);
    }
    this.pending.set(socketId, address);
    const shortAddr = address.slice(0, 10) + '…' + address.slice(-6);
    this.io.to(socketId).emit('address_detected', { address: shortAddr, fullAddress: address, message: `Detected payout address: ${shortAddr}\nType 'confirm' to save or 'cancel' to discard.` });
    this.broadcastManager?.sendStatusUpdate(socketId, 'info', 'Address detected. Type confirm or cancel.');
  }

  async confirm(socketId, accept) {
    const pending = this.pending.get(socketId);
    if (!pending) {
      this.broadcastManager?.sendStatusUpdate(socketId, 'warning', 'No address pending. Paste an address first.');
      return;
    }
    if (!accept) {
      this.pending.delete(socketId);
      this.broadcastManager?.sendStatusUpdate(socketId, 'info', 'Address entry cancelled.');
      this.io.to(socketId).emit('address_confirmed', { cancelled: true, message: 'Address entry cancelled.' });
      if (this.onConfirmed) {
        try { this.onConfirmed(socketId, false, pending); } catch(_) {}
      }
      return;
    }
    if (this.gameModeManager) {
      try {
        await this.gameModeManager.setUserPayoutAddress(socketId, pending);
        this.broadcastManager?.sendStatusUpdate(socketId, 'success', 'Payout address saved.');
        this.io.to(socketId).emit('address_confirmed', { address: pending, message: 'Payout address saved.' });
      } catch (e) {
        this.broadcastManager?.sendStatusUpdate(socketId, 'error', 'Failed to save address. Try again.');
        return;
      } finally {
        this.pending.delete(socketId);
      }
    } else {
      this.pending.delete(socketId);
      this.broadcastManager?.sendStatusUpdate(socketId, 'success', 'Payout address accepted (session only).');
      this.io.to(socketId).emit('address_confirmed', { address: pending, message: 'Payout address accepted (session only).' });
    }
    if (this.onConfirmed) {
      try { this.onConfirmed(socketId, true, pending); } catch(_) {}
    }
  }

  requiresPayoutAddress() {
    if (!this.gameModeManager) return false; // free mode => no requirement
    const mode = this.gameModeManager.gameMode;
    return (mode === 'PAID_SINGLE') || (mode === 'PAID_CREDITS' && this.gameModeManager.creditsPayoutEnabled);
  }
}

module.exports = AddressManager;