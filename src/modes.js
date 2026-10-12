/**
 * Image model modes (Krea 2 / Anima). Each mode has its own complete set of settings: character presets, render
 * profiles, parser presets, prompt assembly, workflow, models, sampling, display, rules, status bar and so on.
 *
 * The active mode's settings are the flat settings object every module reads through getSettings(); the other
 * mode's wait in settings.modeStore[mode] until it is switched to. Shared by both: the switch itself, "enabled"
 * and the API settings (the parser model's connection and the ComfyUI server's address).
 */
import { MODEL_ANIMA, MODEL_LABELS, modeDefaults, normalizeMode } from './constants.js';
import { fillDefaults, getSettings, isPlainObject } from './utils.js';

/** Top-level keys both modes share. */
const SHARED_KEYS = ['settingsVersion', 'enabled', 'modelMode', 'modeStore'];

/**
 * Keys of parser / comfy both modes share: the API settings. The rest of those objects (what the parser reads,
 * the workflow, models, sampling …) is per mode, like every key not listed here.
 */
export const SHARED_PARSER_KEYS = ['source', 'customUrl', 'customKey', 'customModel', 'profileId', 'temperature', 'maxTokens', 'extraBody', 'models', 'timeoutSec', 'retries'];
export const SHARED_COMFY_KEYS = ['url', 'browserUrl', 'mode', 'lists'];
const SHARED_NESTED = { parser: SHARED_PARSER_KEYS, comfy: SHARED_COMFY_KEYS };

export function currentMode() {
    return normalizeMode(getSettings().modelMode);
}

export function modeLabel(mode = currentMode()) {
    return MODEL_LABELS[normalizeMode(mode)];
}

export function isAnimaMode() {
    return currentMode() === MODEL_ANIMA;
}

/** The mode a floor was last drawn in (floors from before the Anima mode were drawn with Krea 2). */
export function floorMode(data) {
    return normalizeMode(data?.modelMode);
}

/** The mode one picture version was drawn in (pictures from before the Anima mode are Krea 2's). */
export function imageMode(image) {
    return normalizeMode(image?.mode);
}

/** A copy of one mode's own settings: everything except the shared keys. */
export function extractModeSettings(settings) {
    const own = {};
    for (const [key, value] of Object.entries(settings)) {
        if (SHARED_KEYS.includes(key)) continue;
        if (SHARED_NESTED[key] && isPlainObject(value)) {
            own[key] = {};
            for (const [inner, innerValue] of Object.entries(value)) {
                if (!SHARED_NESTED[key].includes(inner)) own[key][inner] = structuredClone(innerValue);
            }
        } else {
            own[key] = structuredClone(value);
        }
    }
    return own;
}

/** Removes the active mode's own settings from the flat object, keeping the shared ones. */
function clearModeSettings(settings) {
    for (const key of Object.keys(settings)) {
        if (SHARED_KEYS.includes(key)) continue;
        if (SHARED_NESTED[key] && isPlainObject(settings[key])) {
            for (const inner of Object.keys(settings[key])) {
                if (!SHARED_NESTED[key].includes(inner)) delete settings[key][inner];
            }
        } else {
            delete settings[key];
        }
    }
}

/** Copies a stored mode's own settings into the flat object (shared keys in the copy are ignored). */
function applyModeSettings(settings, own) {
    for (const [key, value] of Object.entries(own ?? {})) {
        if (SHARED_KEYS.includes(key)) continue;
        if (SHARED_NESTED[key] && isPlainObject(value)) {
            if (!isPlainObject(settings[key])) settings[key] = {};
            for (const [inner, innerValue] of Object.entries(value)) {
                if (!SHARED_NESTED[key].includes(inner)) settings[key][inner] = structuredClone(innerValue);
            }
        } else {
            settings[key] = structuredClone(value);
        }
    }
}

/**
 * Makes `target` the active mode: the current mode's settings go into modeStore, the target's come out of it
 * (or start from that mode's defaults the first time). Synchronous and done on the settings object itself, so
 * nothing can read a half-swapped state. Returns false when `target` is already active.
 */
export function swapModeSettings(target) {
    const settings = getSettings();
    const from = normalizeMode(settings.modelMode);
    const to = normalizeMode(target);
    if (from === to) return false;
    const store = settings.modeStore;
    const saved = isPlainObject(store[to]) ? store[to] : {};
    store[from] = extractModeSettings(settings);
    delete store[to];
    clearModeSettings(settings);
    applyModeSettings(settings, saved);
    settings.modelMode = to;
    fillDefaults(settings, modeDefaults(to));
    // Adds the mode's built-in parser presets if the stored copy lacks any.
    getSettings();
    return true;
}

/**
 * The other mode's stored settings, for "keep presets" when resetting: the character presets, render profiles
 * and the user's own parser presets, or null when that mode was never used.
 */
export function storedModeSettings(mode) {
    const own = getSettings().modeStore[normalizeMode(mode)];
    return isPlainObject(own) ? own : null;
}
