/**
 * 出图参数预设: named sets of 出图参数 — models, style LoRA, 更多 LoRA, sampling, size, upscale, skip layer guidance,
 * workflow — with the mode's trigger words, kept per image model mode and shared by every persona's profile. A new
 * character card (often with a new persona, whose profile starts from the defaults) gets its models and LoRAs in one
 * click, and a preset bound to a card is put in place whenever that card's chat opens.
 */
import { currentMode } from './modes.js';
import { ctx, getSettings, isPlainObject } from './utils.js';

/** The comfy settings a preset holds (the character LoRAs belong to the character presets, not here). */
export const PARAM_COMFY_KEYS = [
    'unet', 'clip', 'vae', 'lora', 'loraStrength', 'extraLoras', 'loraClip',
    'steps', 'cfg', 'sampler', 'scheduler', 'seed',
    'sizeMode', 'width', 'height', 'aspectRatio', 'megapixels', 'parserAspect',
    'upscale', 'upscaleModel', 'upscaleFactor', 'slg', 'refinePrompt', 'workflowSource', 'workflow',
];

/** The presets of an image model mode (stored with the shared settings, so every profile sees them). */
export function paramPresets(mode = currentMode()) {
    const settings = getSettings();
    if (!isPlainObject(settings.paramPresets)) settings.paramPresets = {};
    if (!Array.isArray(settings.paramPresets[mode])) settings.paramPresets[mode] = [];
    return settings.paramPresets[mode];
}

export function findParamPreset(id, mode = currentMode()) {
    return id ? paramPresets(mode).find(preset => preset.id === id) ?? null : null;
}

/** The current 出图参数 (and trigger words), as a preset keeps them. */
export function captureParams() {
    const settings = getSettings();
    const comfy = {};
    for (const key of PARAM_COMFY_KEYS) {
        if (settings.comfy[key] !== undefined) comfy[key] = structuredClone(settings.comfy[key]);
    }
    return { comfy, triggerWords: String(settings.triggerWords ?? '') };
}

/** Puts a preset's values in place and marks it as the profile's preset; returns whether anything changed. */
export function applyParams(preset) {
    const settings = getSettings();
    const before = JSON.stringify(captureParams());
    const values = preset.values ?? {};
    for (const key of PARAM_COMFY_KEYS) {
        if (isPlainObject(values.comfy) && Object.hasOwn(values.comfy, key)) settings.comfy[key] = structuredClone(values.comfy[key]);
    }
    if (typeof values.triggerWords === 'string') settings.triggerWords = values.triggerWords;
    settings.paramPresetId = preset.id;
    return JSON.stringify(captureParams()) !== before;
}

/** The open chat's character card as presets are bound to it (its avatar file; a group by its id), or null. */
export function currentCard() {
    const context = ctx();
    if (context.groupId) {
        const group = context.groups?.find(item => item.id === context.groupId);
        return { key: `group:${context.groupId}`, name: group?.name || '群聊' };
    }
    const character = context.characters?.[context.characterId];
    return character?.avatar ? { key: character.avatar, name: character.name || character.avatar } : null;
}

/** The preset of this mode bound to a card, or null. */
export function cardPreset(card = currentCard(), mode = currentMode()) {
    return card ? paramPresets(mode).find(preset => preset.cards?.includes(card.key)) ?? null : null;
}

/** Binds a card to a preset (a card has one preset per mode) or unbinds it. */
export function bindCard(preset, card, bound) {
    for (const other of paramPresets()) other.cards = (other.cards ?? []).filter(key => key !== card.key);
    if (bound) preset.cards.push(card.key);
}
