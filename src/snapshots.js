/**
 * 设置预设: named copies of all the settings, to switch between whole setups. One holds the current profile's
 * settings in every image model mode (character presets, prompts, workflow, models, sampling, rules, display …),
 * the switches all modes share, and the API settings (the parser's provider, keys and models, the ComfyUI address).
 * It does not hold the libraries (出图参数预设, these presets themselves), the cached model lists, whether each
 * persona has a profile of its own, or other personas' profiles: putting one in place changes the profile in use.
 *
 * Only what differs from the defaults is kept, so a preset is small and the settings file stays so; what is left
 * out comes from the defaults when the preset is put in place.
 */
import { MODEL_MODES, SETTINGS_VERSION, makeId, modeDefaults, normalizeMode } from './constants.js';
import { SHARED_COMFY_KEYS, SHARED_PARSER_KEYS, applyModeSettings, clearModeSettings, extractModeSettings, slotKey } from './modes.js';
import { providerOf } from './providers.js';
import { fillDefaults, getSettings, isPlainObject, migrateSettings } from './utils.js';

export const SNAPSHOT_TYPE = 'comfy_portrait_settings';

/** Switches all modes share that belong to a setup (the mode itself is kept as `mode`). */
const SHARED_SWITCHES = ['enabled', 'autoModelByRating', 'reviewParserInput', 'placeInStory', 'panelAlsoInMessage', 'absentFallback', 'quickRegenButton', 'quickTogglePlace'];
/** Shared ComfyUI settings a preset keeps: the connection, not the cached model lists. */
const COMFY_KEYS = SHARED_COMFY_KEYS.filter(key => key !== 'lists');

/** What of `value` differs from `base` (objects key by key, anything else whole); undefined when nothing does. */
function difference(value, base) {
    if (isPlainObject(value) && isPlainObject(base)) {
        const out = {};
        for (const key of Object.keys(value)) {
            const part = difference(value[key], base[key]);
            if (part !== undefined) out[key] = part;
        }
        return Object.keys(out).length ? out : undefined;
    }
    return JSON.stringify(value) === JSON.stringify(base) ? undefined : structuredClone(value);
}

/** `base` with what a difference changed put back. */
function restored(base, changes) {
    if (!isPlainObject(changes)) return changes === undefined ? structuredClone(base) : structuredClone(changes);
    if (!isPlainObject(base)) return structuredClone(changes);
    const out = structuredClone(base);
    for (const [key, part] of Object.entries(changes)) out[key] = restored(base[key], part);
    return out;
}

/** The presets (kept with the shared settings, so every mode and profile sees them). */
export function snapshots() {
    const settings = getSettings();
    if (!Array.isArray(settings.snapshots)) settings.snapshots = [];
    return settings.snapshots;
}

export function findSnapshot(id) {
    return id ? snapshots().find(item => item.id === id) ?? null : null;
}

/** The settings as they are now, as a preset keeps them. */
export function captureSettings() {
    const settings = getSettings();
    const current = normalizeMode(settings.modelMode);
    const persona = String(settings.profilePersona || '');
    const modes = {};
    for (const mode of MODEL_MODES) {
        const own = mode === current ? extractModeSettings(settings) : settings.modeStore[slotKey(mode, persona)];
        // A mode this profile never used has nothing of its own: it stays out, and is the defaults again later.
        if (isPlainObject(own)) modes[mode] = difference(extractModeSettings(own), extractModeSettings(modeDefaults(mode))) ?? {};
    }
    const pick = (object, keys) => Object.fromEntries(keys.filter(key => object?.[key] !== undefined).map(key => [key, structuredClone(object[key])]));
    return {
        version: SETTINGS_VERSION,
        mode: current,
        shared: pick(settings, SHARED_SWITCHES),
        parser: pick(settings.parser, SHARED_PARSER_KEYS),
        comfy: pick(settings.comfy, COMFY_KEYS),
        modes,
    };
}

/** A new preset of the settings as they are now. */
export function newSnapshot(name) {
    return { id: makeId(), name, time: Date.now(), data: captureSettings() };
}

/**
 * Puts a preset's settings in place of the current profile's: every mode of it, the shared switches and the API
 * settings. A preset saved by an older version goes through the same one-time changes old settings do.
 * Synchronous, on the settings object itself (other modules read it through getSettings()).
 */
export function applySnapshot(snapshot) {
    const data = snapshot.data ?? {};
    const mode = normalizeMode(data.mode);
    // The preset as settings of its own version: its mode flat, the other modes stored beside it.
    const temp = { settingsVersion: Number(data.version) || SETTINGS_VERSION, modelMode: mode, modeStore: {}, parser: {}, comfy: {} };
    for (const [key, changes] of Object.entries(data.modes ?? {})) {
        if (!MODEL_MODES.includes(key)) continue;
        const own = restored(extractModeSettings(modeDefaults(key)), changes);
        if (key === mode) applyModeSettings(temp, own);
        else temp.modeStore[key] = own;
    }
    Object.assign(temp.parser, structuredClone(data.parser ?? {}));
    Object.assign(temp.comfy, structuredClone(data.comfy ?? {}));
    Object.assign(temp, structuredClone(data.shared ?? {}));
    migrateSettings(temp);

    const settings = getSettings();
    const persona = String(settings.profilePersona || '');
    // A preset passed on without its API keys uses the keys already here, each provider its own.
    const keyHere = provider => (providerOf(settings.parser) === provider ? settings.parser.customKey : settings.parser.providerStore?.[provider]?.customKey) ?? '';
    if (temp.parser.customKey === undefined && temp.parser.provider !== undefined) temp.parser.customKey = keyHere(providerOf(temp.parser));
    for (const [provider, own] of Object.entries(isPlainObject(temp.parser.providerStore) ? temp.parser.providerStore : {})) {
        if (isPlainObject(own) && own.customKey === undefined) own.customKey = keyHere(provider);
    }
    clearModeSettings(settings);
    applyModeSettings(settings, extractModeSettings(temp));
    // The preset's mode is the one in use now: a copy of it stored while another mode was in use is stale.
    delete settings.modeStore[slotKey(mode, persona)];
    for (const other of MODEL_MODES.filter(item => item !== mode)) {
        const slot = slotKey(other, persona);
        if (isPlainObject(temp.modeStore[other])) settings.modeStore[slot] = temp.modeStore[other];
        else delete settings.modeStore[slot];
    }
    for (const key of SHARED_SWITCHES) if (temp[key] !== undefined) settings[key] = temp[key];
    for (const key of SHARED_PARSER_KEYS) if (temp.parser[key] !== undefined) settings.parser[key] = structuredClone(temp.parser[key]);
    for (const key of COMFY_KEYS) if (temp.comfy[key] !== undefined) settings.comfy[key] = structuredClone(temp.comfy[key]);
    settings.modelMode = mode;
    if (persona) settings.personaModes[persona] = mode;
    settings.snapshotId = snapshot.id;
    fillDefaults(settings, modeDefaults(mode));
    // Adds the mode's built-in parser presets if the preset left them out.
    getSettings();
}

/** A preset as a file: with the API keys, or without them (to pass on). */
export function exportSnapshot(snapshot, withKeys) {
    const copy = structuredClone(snapshot);
    if (!withKeys && isPlainObject(copy.data?.parser)) {
        delete copy.data.parser.customKey;
        for (const own of Object.values(copy.data.parser.providerStore ?? {})) if (isPlainObject(own)) delete own.customKey;
    }
    return { type: SNAPSHOT_TYPE, name: copy.name, time: copy.time, data: copy.data };
}

/** Presets read from a file (one, or a list), as new ones; throws when the file holds none. */
export function importSnapshots(json) {
    const list = (Array.isArray(json) ? json : [json]).filter(item => item?.type === SNAPSHOT_TYPE && isPlainObject(item.data) && isPlainObject(item.data.modes));
    if (!list.length) throw new Error('文件里没有设置预设（要用这里「导出」的文件）');
    return list.map(item => ({ id: makeId(), name: String(item.name || '导入的设置预设'), time: Number(item.time) || Date.now(), data: structuredClone(item.data) }));
}
