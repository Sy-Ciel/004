import { ctx, escapeHtml, getMessageData, getSettings, setExtraValue } from './utils.js';

/**
 * Drawing instructions written inside a message as [[...]] or 【【...】】.
 * They are cut out of the message text before SillyTavern builds the prompt and kept in the message's
 * extension data, so only the image parser ever sees them.
 */

export const HINTS_KEY = 'comfy_portrait_hints';
const PATTERN = /[ \t]*(?:\[\[([\s\S]*?)\]\]|【【([\s\S]*?)】】)/g;

export function hintsEnabled() {
    return getSettings().hintsEnabled !== false;
}

export function extractHints(text) {
    const hints = [];
    const cleaned = String(text ?? '').replace(PATTERN, (match, ascii, wide) => {
        const hint = String(ascii ?? wide ?? '').trim();
        if (hint) hints.push(hint);
        return '';
    });
    return { hints, text: hints.length ? cleaned.replace(/[ \t]+\n/g, '\n').trim() : String(text ?? '') };
}

export function stripHints(text) {
    return String(text ?? '').replace(PATTERN, '');
}

export function getHints(message) {
    const hints = message?.extra?.[HINTS_KEY];
    return Array.isArray(hints) ? hints : [];
}

function setHints(message, hints) {
    setExtraValue(message, message.swipe_id ?? 0, HINTS_KEY, hints.length ? hints : null);
}

/**
 * Moves [[...]] out of a message's text into its extension data.
 * @returns {number} How many instructions were captured
 */
export function captureHints(mesId) {
    if (!hintsEnabled()) return 0;
    const message = ctx().chat[mesId];
    if (!message || typeof message.mes !== 'string') return 0;
    const { hints, text } = extractHints(message.mes);
    if (!hints.length) return 0;
    message.mes = text;
    if (Array.isArray(message.swipes) && typeof message.swipe_id === 'number' && typeof message.swipes[message.swipe_id] === 'string') {
        message.swipes[message.swipe_id] = text;
    }
    setHints(message, [...new Set([...getHints(message), ...hints])]);
    return hints.length;
}

export function removeHint(message, index) {
    const hints = getHints(message).filter((_, i) => i !== index);
    setHints(message, hints);
}

/**
 * Instructions not yet used by a generation: everything written since the last floor that was drawn,
 * up to and including the floor being drawn.
 * @returns {{ floor: number, name: string, hints: string[] }[]}
 */
export function pendingHints(mesId) {
    if (!hintsEnabled()) return [];
    // Never instructions from later floors: re-drawing #10 only uses what was written up to #10.
    const chat = ctx().chat.slice(0, Math.max(0, mesId + 1));
    let start = Math.max(0, mesId - 30);
    for (let i = mesId - 1; i >= start; i--) {
        if (getMessageData(chat[i])?.parsed) {
            start = i + 1;
            break;
        }
    }
    const result = [];
    for (let i = start; i <= mesId && i < chat.length; i++) {
        const hints = getHints(chat[i]);
        if (hints.length) result.push({ floor: i, name: chat[i].name || '', hints });
    }
    return result;
}

/** Last line of defence: strip the syntax from chat turns of an outgoing prompt (messages created without events). */
export function stripOutgoingChat(messages) {
    if (!hintsEnabled() || !Array.isArray(messages)) return;
    for (const message of messages) {
        if (!message || !['user', 'assistant'].includes(message.role)) continue;
        if (typeof message.content === 'string') {
            message.content = stripHints(message.content);
        } else if (Array.isArray(message.content)) {
            for (const part of message.content) {
                if (part?.type === 'text' && typeof part.text === 'string') part.text = stripHints(part.text);
            }
        }
    }
}

/** Badge under a message listing its instructions; DOM only. */
export function renderHints(element, message) {
    const hints = getHints(message);
    let badge = element.find('.ctp-hints');
    if (!hints.length) {
        badge.remove();
        return;
    }
    if (!badge.length) {
        badge = $('<div class="ctp-hints" title="画图指令：只发给配图解析模型，正文 AI 看不到"></div>');
        element.find('.mes_block').first().append(badge);
    }
    const html = `<i class="fa-solid fa-palette"></i><span>画图指令：</span>${hints.map((hint, index) => `
        <span class="ctp-hint-item">${escapeHtml(hint)}<i class="fa-solid fa-xmark ctp-act" data-act="hint-remove" data-index="${index}" title="删除这条指令"></i></span>`).join('')}`;
    if (badge.data('html') !== html) {
        badge.data('html', html);
        badge.html(html);
    }
}
