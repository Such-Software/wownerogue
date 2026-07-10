/**
 * HTML-entity escape + length cap for chat text. Mirrors the inline escaping ChatHandler applies
 * to local messages, so untrusted remote (nostr) messages are sanitized identically before they
 * are delivered to browsers. Escaping is the caller's job per the ChatProvider contract — remote
 * events have no trusted caller, so the NostrChatProvider applies this.
 */
const DEFAULT_MAX = 200;

function escapeChatText(input, maxLen = DEFAULT_MAX) {
    return String(input == null ? '' : input)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .slice(0, maxLen);
}

module.exports = { escapeChatText, DEFAULT_MAX };
