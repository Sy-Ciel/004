import { DEFAULT_SETTINGS, EXTRA_KEY, LOG_PREFIX, MODULE, SETTINGS_VERSION } from './constants.js';

export const ctx = () => SillyTavern.getContext();

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Fills missing keys of `target` from `defaults`, recursing into plain objects. */
function fillDefaults(target, defaults) {
    for (const [key, value] of Object.entries(defaults)) {
        if (!(key in target) || target[key] === undefined || target[key] === null) {
            target[key] = structuredClone(value);
        } else if (isPlainObject(value) && isPlainObject(target[key])) {
            fillDefaults(target[key], value);
        }
    }
    return target;
}

function migrateSettings(settings) {
    const version = Number(settings.settingsVersion) || 1;
    if (version < 2) {
        // 800 tokens was the v1 default and is too small for thinking models (GLM, DeepSeek-R1 …).
        if (Number(settings.parser?.maxTokens) === 800) settings.parser.maxTokens = 2048;
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
    fillDefaults(all[MODULE], DEFAULT_SETTINGS);
    if (!Array.isArray(all[MODULE].presets)) {
        all[MODULE].presets = structuredClone(DEFAULT_SETTINGS.presets);
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
    parentSignal?.addEventListener('abort', onAbort, { once: true });
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
    const currentSwipe = message.swipe_id ?? 0;
    if (currentSwipe === swipeId) {
        message.extra ??= {};
        if (data) message.extra[EXTRA_KEY] = data;
        else delete message.extra[EXTRA_KEY];
    }
    const info = Array.isArray(message.swipe_info) ? message.swipe_info[swipeId] : null;
    if (info && typeof info === 'object') {
        info.extra ??= {};
        if (data) info.extra[EXTRA_KEY] = structuredClone(data);
        else delete info.extra[EXTRA_KEY];
    }
}

export function toSrc(path) {
    if (!path) return '';
    if (/^(data:|blob:|https?:|\/)/i.test(path)) return path;
    return '/' + path.replace(/\\/g, '/');
}
