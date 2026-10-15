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
    // Stored instructions always count: the switch only controls the [[ ]] syntax in message text, and
    // instructions added with the 加画图指令 button are stored without it.
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

/**
 * 「加画图指令重画」: writes a floor's instructions (one per line) without touching its text, e.g. to correct a
 * picture that came out wrong. Returns the saved instructions, or null when cancelled.
 * @param {number} mesId
 * @param {string} [prompt] The picture's prompt, shown for reference
 */
export async function openHintDialog(mesId, prompt = '') {
    const message = ctx().chat[mesId];
    if (!message) return null;
    const root = document.createElement('div');
    root.className = 'ctp-hint-dialog';
    root.innerHTML = `
        <h3>#${mesId} 的画图指令</h3>
        <p>对画面不满意时，在这里写你想要的样子，一行一条，例如「坐在床边」「穿红色连衣裙」「和他牵着手」「近景」。
        保存后按这些指令重新解析并出图（优先级最高）。<b>正文不会改动</b>，写正文的 AI 也看不到这些指令。</p>
        <textarea class="text_pole ctp-hint-input" rows="6" placeholder="一行一条，中文英文都可以"></textarea>
        <small class="ctp-hint">清空 = 删除这一楼的全部指令（不重画）。之后的楼层会按这次的画面延续（例如换过的衣服）。</small>
        ${prompt ? `<details class="ctp-hint-prompt"><summary>当前这张图的提示词</summary><div>${escapeHtml(prompt)}</div></details>` : ''}`;
    root.querySelector('.ctp-hint-input').value = getHints(message).join('\n');
    const { callGenericPopup, POPUP_TYPE, POPUP_RESULT } = ctx();
    const result = await callGenericPopup(root, POPUP_TYPE.CONFIRM, '', { okButton: '保存并重画', cancelButton: '取消', wide: true, allowVerticalScrolling: true });
    if (result !== POPUP_RESULT.AFFIRMATIVE || ctx().chat[mesId] !== message) return null;
    const hints = [...new Set(root.querySelector('.ctp-hint-input').value.split('\n').map(line => line.trim()).filter(Boolean))];
    setHints(message, hints);
    return hints;
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
