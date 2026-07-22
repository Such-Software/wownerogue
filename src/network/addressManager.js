/**
 * AddressManager
 * Handles detection, pending confirmation, validation, and persistence of payout addresses.
 * Keeps socketHandlers slimmer by encapsulating this concern.
 */
const { AppError, normalizeError } = require('../utils/errors');

// Candidate extraction accepts every Monero nettype; isValidAddress() then restricts XMR to the
// configured network (mainnet 4/8, stagenet 5/7, testnet 9/B). Wallet RPC performs the final
// checksum + nettype validation before persistence.
const ADDRESS_REGEX = /((?:4|8|5|7|9|B)[1-9A-HJ-NP-Za-km-z]{90,110}|(?:Wo|WO|ww|WW)[0-9A-Za-z]{88,112}|W[0-9A-Za-z]{90,112})/;
const XMR_ADDRESS_REGEX = /^(?:4|8|5|7|9|B)[1-9A-HJ-NP-Za-km-z]{90,110}$/;
const WOW_ADDRESS_REGEX = /^(?:(?:Wo|WO|ww|WW)[0-9A-Za-z]{88,112}|W[0-9A-Za-z]{90,112})$/;

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
    // Basic length guard for sanity (allowing integrated addresses)
    if (value.length < 80 || value.length > 120) return false;

    const currency = String(this.gameModeManager?.cryptoType || '').toUpperCase();
    if (currency === 'XMR') {
      if (!XMR_ADDRESS_REGEX.test(value)) return false;
      const network = String(this.gameModeManager?.network || 'mainnet').toLowerCase();
      const prefixes = network === 'stagenet' ? new Set(['5', '7'])
        : (network === 'testnet' ? new Set(['9', 'B']) : new Set(['4', '8']));
      return prefixes.has(value[0]);
    }
    if (currency === 'WOW') return WOW_ADDRESS_REGEX.test(value);
    return ADDRESS_REGEX.test(value);
  }

  async _validateWithWallet(address) {
    if (!this.gameModeManager || typeof this.gameModeManager.validatePayoutAddress !== 'function') {
      return true; // legacy/injected managers retain syntax-only behavior
    }
    let result;
    try {
      result = await this.gameModeManager.validatePayoutAddress(address);
    } catch (error) {
      throw new AppError('Payout address validation failed', {
        safeMessage: 'Could not verify that address with the configured wallet network. Try again.'
      });
    }
    if (!result || result.valid !== true) {
      throw new AppError('Payout address is invalid for the configured wallet network', {
        safeMessage: 'That address is not valid for this server\'s configured network.'
      });
    }
    return true;
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
      const saved = await this.confirm(socketId, true);
      if (!saved) return false;
    }

    return trimmed;
  }

  async confirm(socketId, accept) {
    const pending = this.pending.get(socketId);
    if (!pending) {
      this.broadcastManager?.sendStatusUpdate(socketId, 'warning', 'No address pending. Paste an address first.');
      return false;
    }
    if (!accept) {
      this.pending.delete(socketId);
      this.broadcastManager?.sendStatusUpdate(socketId, 'info', 'Address entry cancelled.');
      this.io.to(socketId).emit('address_confirmed', { cancelled: true, message: 'Address entry cancelled.' });
      if (this.onConfirmed) {
        try { this.onConfirmed(socketId, false, pending); } catch(_) {}
      }
      return true;
    }
    if (this.gameModeManager) {
      try {
        await this._validateWithWallet(pending);
        const saved = await this.gameModeManager.setUserPayoutAddress(socketId, pending);
        if (saved !== true) throw new Error('Payout address was not persisted');
        // this.broadcastManager?.sendStatusUpdate(socketId, 'success', 'Payout address saved.'); // Removed duplicate
        this.io.to(socketId).emit('address_confirmed', { address: pending, message: 'Payout address saved.' });
      } catch (e) {
        const normalized = normalizeError?.(e, 'Failed to save address') || e;
        this.broadcastManager?.sendStatusUpdate(socketId, 'error', normalized.safeMessage || 'Failed to save address. Try again.');
        this.io.to(socketId).emit('address_update_error', {
          message: normalized.safeMessage || 'Failed to save address. Try again.'
        });
        return false;
      } finally {
        this.pending.delete(socketId);
      }
    } else {
      this.pending.delete(socketId);
      // this.broadcastManager?.sendStatusUpdate(socketId, 'success', 'Payout address accepted (session only).'); // Removed duplicate
      this.io.to(socketId).emit('address_confirmed', { address: pending, message: 'Payout address accepted (session only).' });
    }
    if (this.onConfirmed) {
      try { this.onConfirmed(socketId, true, pending); } catch(_) {}
    }
    return true;
  }

  requiresPayoutAddress() {
    if (!this.gameModeManager) return false; // free mode => no requirement
    const mode = this.gameModeManager.gameMode;
    if (typeof this.gameModeManager.requiresPayoutAddressForMode === 'function') {
      return this.gameModeManager.requiresPayoutAddressForMode(mode);
    }
    return (mode === 'PAID_SINGLE') || (mode === 'PAID_CREDITS' && this.gameModeManager.creditsPayoutEnabled);
  }
}

module.exports = AddressManager;
