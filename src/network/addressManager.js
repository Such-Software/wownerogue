/**
 * AddressManager
 * Handles detection, pending confirmation, validation, and persistence of payout addresses.
 * Keeps socketHandlers slimmer by encapsulating this concern.
 */
const { AppError, normalizeError } = require('../utils/errors');

const ADDRESS_REGEX = /((?:4|8)[1-9A-HJ-NP-Za-km-z]{90,110}|(?:Wo|WO|ww|WW)[0-9A-Za-z]{88,112}|W[0-9A-Za-z]{90,112})/;

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
    const match = text.match(ADDRESS_REGEX);
    if (!match) return null;
    const candidate = match[1];
    return this.isValidAddress(candidate) ? candidate : null;
  }

  isValidAddress(address) {
    const value = typeof address === 'string' ? address.trim() : '';
    if (!value) return false;
    if (!ADDRESS_REGEX.test(value)) return false;
    // Basic length guard for sanity (allowing integrated addresses)
    return value.length >= 80 && value.length <= 120;
  }

  async handleDetection(socketId, address) {
    try {
      if (this.gameModeManager) {
        const userRow = await this.gameModeManager.getOrCreateUser(socketId);
        if (userRow && userRow.payout_address === address) {
          const shortAddr = address.slice(0, 10) + '…' + address.slice(-6);
          this.io.to(socketId).emit('address_confirmed', { address, message: `Payout address already set to ${shortAddr}. You can update it via the address manager.` });
          this.broadcastManager?.sendStatusUpdate(socketId, 'info', 'Address already on file. Use the address button/command to replace it.');
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

  async saveAddress(socketId, address, { autoConfirm = true } = {}) {
    const trimmed = typeof address === 'string' ? address.trim() : '';
    if (!trimmed) {
      throw new AppError('No payout address supplied', {
        safeMessage: 'Please enter a payout address.'
      });
    }

    if (!this.isValidAddress(trimmed)) {
      throw new AppError('Invalid payout address format', {
        safeMessage: 'That does not look like a valid XMR/WOW address.'
      });
    }

    this.pending.set(socketId, trimmed);

    if (autoConfirm) {
      await this.confirm(socketId, true);
    }

    return trimmed;
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
        const normalized = normalizeError?.(e, 'Failed to save address') || e;
        this.broadcastManager?.sendStatusUpdate(socketId, 'error', normalized.safeMessage || 'Failed to save address. Try again.');
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