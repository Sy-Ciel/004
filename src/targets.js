import { TARGET_AUTO, TARGET_CHAR, TARGET_USER } from './constants.js';
import { ctx, getSettings, resolveMacros } from './utils.js';

export function presetName(preset) {
    return resolveMacros(preset?.name || '');
}

function presetNames(preset) {
    const names = [presetName(preset)];
    for (const alias of String(preset?.aliases || '').split(/[,，、]/)) {
        const resolved = resolveMacros(alias);
        if (resolved) names.push(resolved);
    }
    return names.filter(Boolean).map(name => name.toLowerCase());
}

export function findPresetByName(name) {
    const needle = String(name || '').trim().toLowerCase();
    if (!needle) return null;
    return getSettings().presets.find(preset => presetNames(preset).includes(needle)) ?? null;
}

export function findPresetById(id) {
    return getSettings().presets.find(preset => preset.id === id) ?? null;
}

/* ---------------- user personas ---------------- */

let personasModule = null;
let lastPersona = '';

/** Loads SillyTavern's personas module so the active persona (avatar id) can be read live. */
export async function initPersonaTracking() {
    try {
        personasModule = await import('../../../../personas.js');
    } catch (error) {
        console.warn('[ComfyPortrait] personas.js not available, persona tracking uses the change event only', error);
    }
    const { eventSource, eventTypes } = ctx();
    if (eventTypes.PERSONA_CHANGED) {
        eventSource.on(eventTypes.PERSONA_CHANGED, avatar => { lastPersona = String(avatar || ''); });
    }
}

/** Avatar id of the active user persona, e.g. "user-default.png". */
export function currentPersona() {
    return String(personasModule?.user_avatar || lastPersona || '');
}

/** All user personas as [{ id, name }]. */
export function personaList() {
    const personas = ctx().powerUserSettings?.personas || {};
    return Object.entries(personas).map(([id, name]) => ({ id, name: String(name || id) }));
}

/** The preset {{user}} uses when no preset matches the persona name (setting "{{user}} 没有同名预设时使用"), if it exists. */
export function fallbackUserPreset() {
    const id = getSettings().userFallbackPresetId;
    return id ? findPresetById(id) : null;
}

/**
 * Preset used for {{user}} and why: the preset matching the persona name (a preset named {{user}} always does);
 * otherwise the fallback preset. Each persona has its own profile of presets (see modes.js), so switching
 * persona brings its own {{user}} preset along.
 * @returns {{ preset: object|null, via: 'name'|'fallback'|'none' }}
 */
export function resolveUserPreset() {
    const needle = String(ctx().name1 || '').trim().toLowerCase();
    const named = needle ? getSettings().presets.find(preset => presetNames(preset).includes(needle)) : null;
    if (named) return { preset: named, via: 'name' };
    const fallback = fallbackUserPreset();
    return fallback ? { preset: fallback, via: 'fallback' } : { preset: null, via: 'none' };
}

export function findUserPreset() {
    return resolveUserPreset().preset;
}

/** A preset that describes "whoever the user currently is": named {{user}}, or the fallback. */
function isUserPreset(preset) {
    return String(preset?.name || '').trim().toLowerCase() === '{{user}}'
        || (!!preset?.id && preset.id === getSettings().userFallbackPresetId);
}

/** Character presets whose name or an alias appears in the text ({{user}} presets are found via the persona). */
export function presetsMentioned(text) {
    const haystack = String(text || '').toLowerCase();
    if (!haystack) return [];
    return getSettings().presets.filter(preset => !isUserPreset(preset) && presetNames(preset).some(name => haystack.includes(name)));
}

/** Name → preset, routing the user's own name through the {{user}} preset. */
export function presetForName(name) {
    const user = String(ctx().name1 || '').trim().toLowerCase();
    if (user && String(name || '').trim().toLowerCase() === user) return findUserPreset();
    return findPresetByName(name);
}

function speakerName(message) {
    return (message && !message.is_user && message.name) || ctx().name2 || '';
}

/**
 * Works out who should be drawn for a floor.
 * @param {object} message Chat message of the floor
 * @param {string} [override] Target from a slash command or manual action (preset id, name, "user", "char", "auto")
 * @returns {{ auto: boolean, name: string, preset: object|null, candidates: string[] }}
 */
export function resolveTarget(message, override) {
    const mode = override || getSettings().targetMode || TARGET_USER;
    const lower = String(mode).toLowerCase();

    if (mode === TARGET_USER || lower === 'user' || lower === '{{user}}') {
        return { auto: false, name: ctx().name1, preset: findUserPreset(), candidates: [] };
    }
    if (mode === TARGET_CHAR || lower === 'char' || lower === '{{char}}') {
        const name = speakerName(message);
        return { auto: false, name, preset: findPresetByName(name), candidates: [] };
    }
    if (mode === TARGET_AUTO || lower === 'auto') {
        return { auto: true, name: '', preset: null, candidates: autoCandidates(message) };
    }

    const byId = findPresetById(mode);
    if (byId) {
        // A user preset follows persona switches: the preset matching the new persona's name, or the fallback.
        if (isUserPreset(byId)) {
            return { auto: false, name: ctx().name1, preset: findUserPreset(), candidates: [] };
        }
        return { auto: false, name: presetName(byId), preset: byId, candidates: [] };
    }
    const byName = presetForName(mode);
    return { auto: false, name: byName ? presetName(byName) : String(mode), preset: byName, candidates: [] };
}

export function autoCandidates(message) {
    const others = getSettings().presets.filter(preset => !isUserPreset(preset)).map(presetName);
    const names = [ctx().name1, speakerName(message), ...others];
    const seen = new Set();
    return names.filter(name => {
        const key = String(name || '').trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** Maps the name returned by the parser in auto mode back onto a candidate/preset. */
export function settleAutoTarget(target, parsedName, message) {
    const wanted = String(parsedName || '').trim();
    const settled = { ...target, auto: false };
    const preset = presetForName(wanted);
    if (preset) return { ...settled, name: presetName(preset), preset };
    const candidate = target.candidates.find(name => name.toLowerCase() === wanted.toLowerCase());
    if (candidate) return { ...settled, name: candidate, preset: null };
    // Unknown name: fall back to the speaking character so we still draw a single, known person.
    const fallback = speakerName(message);
    return { ...settled, name: fallback, preset: presetForName(fallback) };
}
