import {
    ANIMA_PROMPT_TEMPLATE,
    ANIMA_PROMPT_TEMPLATE_V1,
    EXTRA_KEY,
    LEGACY_PARSER_SYSTEM,
    LEGACY_PARSER_USER,
    LOG_PREFIX,
    MODULE,
    SETTINGS_VERSION,
    V3_PARSER_SYSTEM,
    V3_PARSER_USER,
    MODEL_ANIMA,
    MODEL_MOSS,
    makeId,
    modeDefaults,
    normalizeMode,
} from './constants.js';
import { BUILTIN_PARSER_PRESETS, REMOVED_PARSER_PRESETS, builtinParserPresets, isPreviousStorySystem } from './parserPresetDefaults.js';

export const ctx = () => SillyTavern.getContext();

export function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Fills missing keys of `target` from `defaults`, recursing into plain objects. */
export function fillDefaults(target, defaults) {
    for (const [key, value] of Object.entries(defaults)) {
        if (!(key in target) || target[key] === undefined || target[key] === null) {
            target[key] = structuredClone(value);
        } else if (isPlainObject(value) && isPlainObject(target[key])) {
            fillDefaults(target[key], value);
        }
    }
    return target;
}

/**
 * One-time changes for settings saved by older versions. The early ones predate the Anima mode, so only the flat
 * (Krea 2) settings need them; later ones update every mode's copy in modeStore too.
 */
function migrateSettings(settings) {
    const version = Number(settings.settingsVersion) || 1;
    if (version < 2) {
        // 800 tokens was the v1 default and is too small for thinking models (GLM, DeepSeek-R1 …).
        if (Number(settings.parser?.maxTokens) === 800) settings.parser.maxTokens = 2048;
    }
    if (version < 4 && settings.parser) {
        // Parser prompts moved into presets. Untouched defaults map to the built-in "story" preset;
        // edited ones become a preset of their own, selected so nothing changes for the user.
        const { systemPrompt: system, userTemplate: user } = settings.parser;
        const stockSystem = system === undefined || system === LEGACY_PARSER_SYSTEM || system === V3_PARSER_SYSTEM;
        const stockUser = user === undefined || user === LEGACY_PARSER_USER || user === V3_PARSER_USER;
        settings.parserPresets = structuredClone(BUILTIN_PARSER_PRESETS);
        if (!stockSystem || !stockUser) {
            const story = BUILTIN_PARSER_PRESETS[0];
            const custom = {
                ...structuredClone(story),
                id: makeId(),
                name: '我的解析提示词（从旧版本迁移）',
                system: stockSystem ? story.system : String(system),
                user: stockUser ? story.user : String(user),
            };
            settings.parserPresets.push(custom);
            settings.parserPresetId = custom.id;
        }
        delete settings.parser.systemPrompt;
        delete settings.parser.userTemplate;
    }
    if (version < 7) {
        // The built-in story prompt was rewritten (v1.24 prompt engineer, v1.25 short, with whom the character is;
        // v1.39 Anima's written the way its model card recommends): copies nobody edited get the current text (and,
        // from before v1.25, let other people in), in every mode and every profile. Anima's untouched assembly
        // template gets the official tag order.
        const upgrade = (own, mode) => {
            if (mode === MODEL_ANIMA && own?.promptTemplate === ANIMA_PROMPT_TEMPLATE_V1) own.promptTemplate = ANIMA_PROMPT_TEMPLATE;
            const story = Array.isArray(own?.parserPresets) ? own.parserPresets.find(preset => preset?.id === 'story') : null;
            if (!story || !isPreviousStorySystem(story.system, mode)) return;
            story.system = builtinParserPresets(mode)[0].system;
            if (version < 6) story.allowOthers = true;
        };
        upgrade(settings, normalizeMode(settings.modelMode));
        if (isPlainObject(settings.modeStore)) {
            for (const [key, own] of Object.entries(settings.modeStore)) upgrade(own, normalizeMode(key.split('@')[0]));
        }
    }
    if (version < 8) {
        // v1.46's 一键开关 by the chat input was easy to hit by accident: it moves into the wand menu (or stays
        // hidden, for those who had turned it off).
        if (settings.quickToggleButton === false) settings.quickTogglePlace = 'none';
        delete settings.quickToggleButton;
    }
    if (version < 9) {
        // v1.58 removed the built-in 立绘模式 and 小说插画模式 (copies made with 「复制」 are the user's and stay):
        // out of every mode and profile, and a profile that used one goes back to the story preset.
        const drop = own => {
            if (!Array.isArray(own?.parserPresets)) return;
            own.parserPresets = own.parserPresets.filter(preset => !REMOVED_PARSER_PRESETS.includes(preset?.id));
            if (REMOVED_PARSER_PRESETS.includes(own.parserPresetId)) own.parserPresetId = 'story';
        };
        drop(settings);
        if (isPlainObject(settings.modeStore)) Object.values(settings.modeStore).forEach(drop);
        // 漫画模式 is drawn at the 出图参数 size now: a comic preset still at the old default 848 × 1200 follows.
        const follow = own => {
            for (const preset of Array.isArray(own?.parserPresets) ? own.parserPresets : []) {
                if (preset?.id === 'comic' && Number(preset.width) === 848 && Number(preset.height) === 1200) Object.assign(preset, { width: 0, height: 0 });
            }
        };
        follow(settings);
        if (isPlainObject(settings.modeStore)) Object.values(settings.modeStore).forEach(follow);
        // MOSS-Image now lets the parser add each picture's negative prompt by default, like Anima: profiles that
        // had the old default (off) get it once.
        if (normalizeMode(settings.modelMode) === MODEL_MOSS) settings.parserNegative = true;
        if (isPlainObject(settings.modeStore)) {
            for (const [key, own] of Object.entries(settings.modeStore)) {
                if (normalizeMode(key.split('@')[0]) === MODEL_MOSS && isPlainObject(own)) own.parserNegative = true;
            }
        }
    }
    if (version < 10) {
        // The default 文件名前缀 carries the persona's name now (ST_portrait_{{user}} …): a prefix still at the old
        // default of its mode follows.
        const follow = (own, mode) => {
            const prefix = modeDefaults(mode).comfy.filenamePrefix;
            if (own?.comfy?.filenamePrefix === prefix.replace('_{{user}}', '')) own.comfy.filenamePrefix = prefix;
        };
        follow(settings, normalizeMode(settings.modelMode));
        if (isPlainObject(settings.modeStore)) {
            for (const [key, own] of Object.entries(settings.modeStore)) follow(own, normalizeMode(key.split('@')[0]));
        }
    }
    settings.settingsVersion = SETTINGS_VERSION;
}

export function getSettings() {
    const all = ctx().extensionSettings;
    if (!isPlainObject(all[MODULE])) {
        all[MODULE] = { settingsVersion: SETTINGS_VERSION };
    }
    if (all[MODULE].settingsVersion !== SETTINGS_VERSION) {
        migrateSettings(all[MODULE]);
    }
    // The flat settings are the active mode's (see modes.js), so missing keys get that mode's defaults.
    const mode = normalizeMode(all[MODULE].modelMode);
    all[MODULE].modelMode = mode;
    if (!isPlainObject(all[MODULE].modeStore)) all[MODULE].modeStore = {};
    if (!isPlainObject(all[MODULE].personaModes)) all[MODULE].personaModes = {};
    const defaults = modeDefaults(mode);
    fillDefaults(all[MODULE], defaults);
    if (!Array.isArray(all[MODULE].presets)) {
        all[MODULE].presets = structuredClone(defaults.presets);
    }
    if (!Array.isArray(all[MODULE].parserPresets)) {
        all[MODULE].parserPresets = [];
    }
    // Built-in parser presets are always available (they can be edited and reset, not deleted).
    for (const builtin of builtinParserPresets(mode)) {
        if (!all[MODULE].parserPresets.some(preset => preset.id === builtin.id)) {
            all[MODULE].parserPresets.push(structuredClone(builtin));
        }
    }
    return all[MODULE];
}

export function saveSettings() {
    ctx().saveSettingsDebounced();
}

export function log(...args) {
    if (getSettings().debug) {
        console.log(LOG_PREFIX, ...args);
    }
}

export function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
}

export function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
    });
}

/** Returns an AbortSignal that fires when either the parent fires or the timeout elapses. */
export function withTimeout(parentSignal, timeoutSec) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(parentSignal?.reason);
    // An abort listener added after the fact never fires, so a job cancelled meanwhile stops here.
    if (parentSignal?.aborted) onAbort();
    else parentSignal?.addEventListener('abort', onAbort, { once: true });
    const timer = timeoutSec > 0
        ? setTimeout(() => controller.abort(new Error(`超时（${timeoutSec} 秒）`)), timeoutSec * 1000)
        : null;
    return {
        signal: controller.signal,
        dispose: () => {
            if (timer) clearTimeout(timer);
            parentSignal?.removeEventListener('abort', onAbort);
        },
    };
}

export function isAbortError(error) {
    return error?.name === 'AbortError';
}

export function errorMessage(error) {
    if (!error) return '未知错误';
    const parts = [error.message || String(error)];
    let cause = error.cause;
    while (cause) {
        parts.push(cause.message || (typeof cause === 'string' ? cause : JSON.stringify(cause)));
        cause = cause.cause;
    }
    return parts.join(' ← ');
}

/** Removes HTML tags and squashes blank lines so the parser sees plain story text. */
export function plainText(text) {
    return String(text ?? '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export function truncate(text, max) {
    const value = String(text ?? '');
    if (!max || value.length <= max) return value;
    return value.slice(0, max) + '…';
}

export function roundTo16(value, fallback) {
    const number = Math.round(Number(value) / 16) * 16;
    return Number.isFinite(number) && number >= 256 ? number : fallback;
}

export function randomSeed() {
    return Math.floor(Math.random() * 2 ** 48);
}

/** Fills `{{name}}` slots from `vars`, then lets SillyTavern resolve its own macros ({{user}}, {{char}} …). */
export function fillTemplate(template, vars, { stMacros = true } = {}) {
    const slots = new Map();
    let index = 0;
    let text = String(template ?? '').replace(/\{\{(\w+)\}\}/g, (match, key) => {
        if (!Object.hasOwn(vars, key)) return match;
        const token = `⁣CTP${index++}⁣`;
        slots.set(token, String(vars[key] ?? ''));
        return token;
    });
    if (stMacros) {
        text = ctx().substituteParams(text);
    }
    for (const [token, value] of slots) {
        text = text.split(token).join(value);
    }
    return text;
}

export function resolveMacros(text) {
    return ctx().substituteParams(String(text ?? '')).trim();
}

export function getMessageData(message) {
    const data = message?.extra?.[EXTRA_KEY];
    return data && typeof data === 'object' ? data : null;
}

/**
 * Stores extension data on a message for one specific swipe. SillyTavern swaps `extra` in and out of
 * `swipe_info` when swiping, so the swipe copy has to be updated too or the image disappears on swipe back.
 */
export function setMessageData(message, swipeId, data) {
    setExtraValue(message, swipeId, EXTRA_KEY, data);
}

/** Sets (or with a null value removes) one extra key on a message and on its swipe copy. */
export function setExtraValue(message, swipeId, key, value) {
    const currentSwipe = message.swipe_id ?? 0;
    if (currentSwipe === swipeId) {
        message.extra ??= {};
        if (value) message.extra[key] = value;
        else delete message.extra[key];
    }
    const info = Array.isArray(message.swipe_info) ? message.swipe_info[swipeId] : null;
    if (info && typeof info === 'object') {
        info.extra ??= {};
        if (value) info.extra[key] = structuredClone(value);
        else delete info.extra[key];
    }
}

export function toSrc(path) {
    if (!path) return '';
    if (/^(data:|blob:|https?:|\/)/i.test(path)) return path;
    return '/' + path.replace(/\\/g, '/');
}
