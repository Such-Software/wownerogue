/**
 * Shared HTML-escaping helper — the single source of truth for escaping untrusted
 * (server- or user-supplied) text before it is inserted into innerHTML / jQuery .html().
 * Escapes all five HTML-significant characters, including both quote types so the
 * result is safe in both element text and quoted attribute values.
 */
(function (global) {
    function escapeHtml(value) {
        if (value === null || value === undefined) return '';
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
    global.escapeHtml = escapeHtml;
})(typeof window !== 'undefined' ? window : this);
