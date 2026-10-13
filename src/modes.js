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
const SHARED_KEYS = ['settingsVersion', 'enabled', 'modelMode', 'modeStore', 'perPersonaProfiles', 'profilePersona'];

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
 * Where a profile is kept in modeStore. Each user persona has its own profile (when "每个用户人设使用独立档案" is
 * on), and each profile has a Krea 2 and an Anima side: key "mode@persona". Without per-persona profiles the
 * key is just the mode (also what versions before profiles stored).
 */
export function slotKey(mode, persona) {
    return persona ? `${normalizeMode(mode)}@${persona}` : normalizeMode(mode);
}

/**
 * Makes (mode, persona) the active profile: the current one goes into modeStore, the target comes out of it.
 * A profile used for the first time starts as a copy of the current settings when only the persona changes
 * (so a new persona keeps what was set up), or from the mode's stored / default settings when the mode changes.
 * Synchronous and done on the settings object itself. Returns false when nothing changes.
 */
export function swapProfile(mode, persona) {
    const settings = getSettings();
    const fromMode = normalizeMode(settings.modelMode);
    const toMode = normalizeMode(mode);
    const fromPersona = String(settings.profilePersona || '');
    const toPersona = String(persona || '');
    const from = slotKey(fromMode, fromPersona);
    const to = slotKey(toMode, toPersona);
    if (from === to) return false;
    const store = settings.modeStore;
    const current = extractModeSettings(settings);
    let saved = isPlainObject(store[to]) ? store[to] : null;
    if (!saved && toMode === fromMode) saved = current;
    // A persona's first use of the other mode starts from that mode's settings from before profiles existed.
    if (!saved && toPersona && isPlainObject(store[toMode])) saved = structuredClone(store[toMode]);
    store[from] = current;
    if (saved !== current) delete store[to];
    clearModeSettings(settings);
    applyModeSettings(settings, saved ?? {});
    settings.modelMode = toMode;
    settings.profilePersona = toPersona;
    fillDefaults(settings, modeDefaults(toMode));
    // Adds the mode's built-in parser presets if the stored copy lacks any.
    getSettings();
    return true;
}

/** Switches the image model mode within the current profile. */
export function swapModeSettings(target) {
    return swapProfile(target, getSettings().profilePersona);
}

/** Key of the other mode's copy within the current profile (for reset-all). */
export function otherSlotKey(mode) {
    return slotKey(mode, getSettings().profilePersona);
}
