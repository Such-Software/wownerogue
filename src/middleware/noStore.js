'use strict';

/** Prevent browsers and intermediary caches from retaining authenticated API responses. */
function noStore(_req, res, next) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
}

module.exports = noStore;
