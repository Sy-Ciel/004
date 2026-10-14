/**
 * Image model modes (Krea 2 / Anima). Each mode has its own complete set of settings: character presets, render
 * profiles, parser presets, prompt assembly, workflow, models, sampling, display, rules, status bar and so on.
 *
 * The active mode's settings are the flat settings object every module reads through getSettings(); the other
 * mode's wait in settings.modeStore[mode] until it is switched to. Shared by both: the switch itself, "enabled"
 * and the API settings (the parser model's connection and the ComfyUI server's address).
 */
import { MODEL_ANIMA, MODEL_LABELS, MODEL_MODES, modeDefaults, normalizeMode } from './constants.js';
import { fillDefaults, getSettings, isPlainObject } from './utils.js';

/** Top-level keys both modes share. */
const SHARED_KEYS = ['settingsVersion', 'enabled', 'modelMode', 'modeStore', 'perPersonaProfiles', 'profilePersona', 'personaModes'];

/**
 * Keys of parser / comfy both modes share: the API settings. The rest of those objects (what the parser reads,
 * the workflow, models, sampling …) is per mode, like every key not listed here.
 */
export const SHARED_PARSER_KEYS = ['source', 'customUrl', 'customKey', 'customModel', 'profileId', 'temperature', 'maxTokens', 'extraBody', 'models', 'timeoutSec', 'retries', 'thinking', 'thinkingEffort', 'thinkingFormat'];
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
 * A profile used for the first time (a new persona, or a mode a persona never used) starts from that mode's
 * defaults. Each persona's mode is remembered, so switching to it switches the mode too.
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
    if (toPersona) settings.personaModes[toPersona] = toMode;
    if (from === to) return false;
    const store = settings.modeStore;
    const saved = isPlainObject(store[to]) ? store[to] : {};
    store[from] = extractModeSettings(settings);
    delete store[to];
    clearModeSettings(settings);
    applyModeSettings(settings, saved);
    settings.modelMode = toMode;
    settings.profilePersona = toPersona;
    fillDefaults(settings, modeDefaults(toMode));
    // Adds the mode's built-in parser presets if the stored copy lacks any.
    getSettings();
    return true;
}

/** Switches the image model mode within the current profile (and remembers it for the persona). */
export function swapModeSettings(target) {
    return swapProfile(target, getSettings().profilePersona);
}

/** The mode a persona used last; a persona never seen starts in the default mode (Krea 2). */
export function personaMode(persona) {
    const settings = getSettings();
    const remembered = settings.personaModes[persona];
    if (MODEL_MODES.includes(remembered)) return remembered;
    // Profiles from before modes were remembered: the mode that has a stored copy.
    const stored = MODEL_MODES.filter(mode => isPlainObject(settings.modeStore[slotKey(mode, persona)]));
    return stored.length === 1 ? stored[0] : normalizeMode(modeDefaults(MODEL_MODES[0]).modelMode);
}

/** Whether a persona has a profile yet (in either mode). */
export function hasProfile(persona) {
    const settings = getSettings();
    return settings.profilePersona === persona || MODEL_MODES.some(mode => isPlainObject(settings.modeStore[slotKey(mode, persona)]));
}

/**
 * Profiles turned on (or settings from before profiles): the current settings become `persona`'s profile,
 * including the other mode's copy kept under the plain mode key.
 */
export function adoptProfile(persona) {
    const settings = getSettings();
    const store = settings.modeStore;
    for (const mode of MODEL_MODES) {
        if (isPlainObject(store[mode]) && !isPlainObject(store[slotKey(mode, persona)])) store[slotKey(mode, persona)] = store[mode];
        delete store[mode];
    }
    settings.profilePersona = persona;
    settings.personaModes[persona] = normalizeMode(settings.modelMode);
}

/** Profiles turned off: the current persona's settings become everyone's, its other-mode copy included. */
export function releaseProfile() {
    const settings = getSettings();
    const persona = settings.profilePersona;
    if (!persona) return;
    for (const mode of MODEL_MODES) {
        const own = settings.modeStore[slotKey(mode, persona)];
        if (isPlainObject(own)) settings.modeStore[mode] = structuredClone(own);
    }
    settings.profilePersona = '';
}

/** Key of the other mode's copy within the current profile (for reset-all). */
export function otherSlotKey(mode) {
    return slotKey(mode, getSettings().profilePersona);
}
