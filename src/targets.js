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
        const name = ctx().name1;
        return { auto: false, name, preset: findPresetByName(name), candidates: [] };
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
        return { auto: false, name: presetName(byId), preset: byId, candidates: [] };
    }
    const byName = findPresetByName(mode);
    return { auto: false, name: byName ? presetName(byName) : String(mode), preset: byName, candidates: [] };
}

export function autoCandidates(message) {
    const names = [ctx().name1, speakerName(message), ...getSettings().presets.map(presetName)];
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
    const preset = findPresetByName(wanted);
    if (preset) return { ...target, name: presetName(preset), preset };
    const candidate = target.candidates.find(name => name.toLowerCase() === wanted.toLowerCase());
    if (candidate) return { ...target, name: candidate, preset: null };
    // Unknown name: fall back to the speaking character so we still draw a single, known person.
    const fallback = speakerName(message);
    return { ...target, name: fallback, preset: findPresetByName(fallback) };
}
