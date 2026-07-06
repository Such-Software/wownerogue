const COLOR_AVATARS = ['default', 'green', 'amber', 'red'];
const PREMIUM_SKINS = ['monero-knight', 'wownero-rogue', 'cypher-operative'];
const MODEL3D_AVATARS = ['kenney-survivor-male', 'kenney-survivor-female'];
const CHAR_AVATARS = [
    'char-villager', 'char-elder', 'char-barbarian', 'char-monk', 'char-ranger',
    'char-bard', 'char-rogue', 'char-merchant', 'char-wizard', 'char-goblin'
];

const CHAR_TINTS = ['none', 'rose', 'teal', 'moss', 'gold', 'violet', 'ash'];
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

function normalizeAppearance(input = {}) {
    if (input && input.appearance && !input.avatar) input = input.appearance;
    if (typeof input === 'string') input = { avatar: input };
    if (!input || typeof input !== 'object') input = {};

    let avatar = input.avatar || input.id || 'default';
    if (!isValidAvatar(avatar)) avatar = 'default';

    if (!isCharAvatar(avatar)) {
        return { avatar, tint: 'none', equipment: { ...DEFAULT_EQUIPMENT } };
    }

    const tint = includes(CHAR_TINTS, input.tint) ? input.tint : 'none';
    return {
        avatar,
        tint,
        equipment: normalizeEquipment(input.equipment)
    };
}

module.exports = {
    COLOR_AVATARS,
    PREMIUM_SKINS,
    MODEL3D_AVATARS,
    CHAR_AVATARS,
    CHAR_TINTS,
    CHAR_EQUIPMENT,
    CHAR_EQUIPMENT_SLOTS,
    DEFAULT_EQUIPMENT,
    avatarIds: () => ALL_AVATARS.slice(),
    premiumAvatarIds: () => Object.keys(AVATAR_PACKS),
    avatarPack,
    isValidAvatar,
    isCharAvatar,
    isPremiumAvatar,
    normalizeEquipment,
    normalizeAppearance
};
