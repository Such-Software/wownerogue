// qrService.js - Generates QR codes for payment URIs
// Uses the 'qrcode' package if available; degrades gracefully if not.

let QR;
try {
  QR = require('qrcode');
} catch (e) {
  QR = null;
}

function formatAmount(atomic, decimals = 12) {
  if (!atomic || atomic <= 0) return '0';
  const divisor = Math.pow(10, decimals);
  return (Number(atomic) / divisor).toFixed(decimals)
    .replace(/0+$/, '')
    .replace(/\.$/, '');
}

async function generatePaymentQR(address, amountAtomic, cryptoType, description, decimals = 12) {
  if (!QR) return null; // Library not installed
  try {
    const amountStr = formatAmount(amountAtomic, decimals);
    const scheme = cryptoType && cryptoType.toUpperCase() === 'WOW' ? 'wownero' : 'monero';
    // Basic URI; wallets usually understand amount (tx_amount) & description
    const params = new URLSearchParams();
    if (amountAtomic) params.set('tx_amount', amountStr);
    if (description) params.set('tx_description', description.substring(0, 64));
    const uri = `${scheme}:${address}${params.toString() ? '?' + params.toString() : ''}`;
    return await QR.toDataURL(uri, { errorCorrectionLevel: 'M', scale: 6, margin: 1 });
  } catch (err) {
    console.error('QR generation failed:', err.message);
    return null;
  }
}

module.exports = { generatePaymentQR };