const COLOR_AVATARS = ['default', 'green', 'amber', 'red'];
const PREMIUM_SKINS = ['monero-knight', 'wownero-rogue', 'cypher-operative'];
const MODEL3D_AVATARS = ['kenney-survivor-male', 'kenney-survivor-female'];
const CHAR_AVATARS = [
    'char-villager', 'char-elder', 'char-barbarian', 'char-monk', 'char-ranger',
    'char-bard', 'char-rogue', 'char-merchant', 'char-wizard', 'char-goblin'
];

const CHAR_TINTS = ['none', 'rose', 'teal', 'moss', 'gold', 'violet', 'ash'];
const CHAR_SKIN_TONES = ['natural', 'fair', 'warm', 'umber', 'olive', 'ash'];
const CHAR_HAIR_COLORS = ['copper', 'brown', 'black', 'blond', 'silver', 'violet'];
const CHAR_EQUIPMENT_SLOTS = ['body', 'head', 'shield', 'weapon'];
const CHAR_EQUIPMENT = {
    body: ['none', 'robe', 'jerkin', 'mail', 'sash'],
    head: ['none', 'hood', 'helm', 'horns', 'cap'],
    shield: ['none', 'round', 'kite', 'tower', 'buckler'],
    weapon: ['none', 'staff', 'sword', 'axe', 'bow']
};

const ALL_AVATARS = [...COLOR_AVATARS, ...PREMIUM_SKINS, ...CHAR_AVATARS, ...MODEL3D_AVATARS];
const AVATAR_PACKS = Object.freeze({
    ...PREMIUM_SKINS.reduce((out, id) => {
        out[id] = 'generated-skins';
        return out;
    }, {}),
    ...MODEL3D_AVATARS.reduce((out, id) => {
        out[id] = 'kenney-3d-characters';
        return out;
    }, {})
});
const DEFAULT_EQUIPMENT = CHAR_EQUIPMENT_SLOTS.reduce((out, slot) => {
    out[slot] = 'none';
    return out;
}, {});
const DEFAULT_COLORS = Object.freeze({
    base: 'none',
    skin: 'natural',
    hair: 'copper',
    body: 'none',
    head: 'none',
    shield: 'none',
    weapon: 'none'
});

function includes(list, id) {
    return list.indexOf(id) !== -1;
}

function isValidAvatar(id) {
    return includes(ALL_AVATARS, id);
}

function isCharAvatar(id) {
    return includes(CHAR_AVATARS, id);
}

function isPremiumAvatar(id) {
    return !!AVATAR_PACKS[id];
}

function avatarPack(id) {
    return AVATAR_PACKS[id] || null;
}

function normalizeEquipment(input = {}) {
    const out = {};
    for (const slot of CHAR_EQUIPMENT_SLOTS) {
        const id = input && typeof input[slot] === 'string' ? input[slot] : 'none';
        out[slot] = includes(CHAR_EQUIPMENT[slot], id) ? id : 'none';
    }
    return out;
}

function validTint(id, fallback = 'none') {
    return includes(CHAR_TINTS, id) ? id : fallback;
}

function normalizeColors(input = {}, legacyTint = 'none') {
    const colors = input && typeof input === 'object' ? input : {};
    const tintFor = slot => validTint(
        Object.prototype.hasOwnProperty.call(colors, slot) ? colors[slot] : legacyTint
    );
    return {
        base: tintFor('base'),
        skin: includes(CHAR_SKIN_TONES, colors.skin) ? colors.skin : DEFAULT_COLORS.skin,
        hair: includes(CHAR_HAIR_COLORS, colors.hair) ? colors.hair : DEFAULT_COLORS.hair,
        body: tintFor('body'),
        head: tintFor('head'),
        shield: tintFor('shield'),
        weapon: tintFor('weapon')
    };
}

function normalizeAppearance(input = {}) {
    if (input && input.appearance && !input.avatar) input = input.appearance;
    if (typeof input === 'string') input = { avatar: input };
    if (!input || typeof input !== 'object') input = {};

    let avatar = input.avatar || input.id || 'default';
    if (!isValidAvatar(avatar)) avatar = 'default';

    if (!isCharAvatar(avatar)) {
        return { avatar, tint: 'none', equipment: { ...DEFAULT_EQUIPMENT } };
    }

    const colors = normalizeColors(input.colors, input.tint);
    return {
        avatar,
        tint: colors.base,
        equipment: normalizeEquipment(input.equipment),
        colors
    };
}

module.exports = {
    COLOR_AVATARS,
    PREMIUM_SKINS,
    MODEL3D_AVATARS,
    CHAR_AVATARS,
    CHAR_TINTS,
    CHAR_SKIN_TONES,
    CHAR_HAIR_COLORS,
    CHAR_EQUIPMENT,
    CHAR_EQUIPMENT_SLOTS,
    DEFAULT_EQUIPMENT,
    DEFAULT_COLORS,
    avatarIds: () => ALL_AVATARS.slice(),
    premiumAvatarIds: () => Object.keys(AVATAR_PACKS),
    avatarPack,
    isValidAvatar,
    isCharAvatar,
    isPremiumAvatar,
    normalizeEquipment,
    normalizeColors,
    normalizeAppearance
};
