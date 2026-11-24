/**
 * 提示词和正文一起出: the main AI writes each picture's prompt itself, in a hidden block right after the part of its
 * reply the picture shows (正文 1, 配图 1, 正文 2, 配图 2 …), and the extension draws from those blocks without asking
 * a parser model. Where a block is, its picture goes; while the reply streams in, each block goes to ComfyUI as soon as
 * it is written. This module finds the blocks, hides them, keeps old ones from the main AI, and follows a reply as it
 * streams in. What the main AI is told is built in parser.js (buildReplyInstruction).
 */
import { ctx, getSettings } from './utils.js';

/** The block's summary: how the extension knows it (the class is only a help for hiding it while it streams in). */
export const BLOCK_LABEL = '配图提示词';
export const BLOCK_CLASS = 'ctp-pic';

/** Whether the main AI writes the pictures' prompts (the parser model is not asked then). */
export function promptsInReply(settings = getSettings()) {
    return !!settings.parser?.inReply;
}

/** A block: <details …><summary>…配图提示词…</summary> … </details> (the closing tag may still be on its way). */
const BLOCK = /<details\b[^>]*>\s*<summary\b[^>]*>[^<]*配图提示词[^<]*<\/summary>([\s\S]*?)(<\/details\s*>|$)/gi;

/**
 * The picture blocks of a reply, in order.
 * @returns {{ start: number, end: number, json: string, complete: boolean }[]} complete: its closing tag is there
 *   (a block still being written, at the end of a reply streaming in, is not)
 */
export function findPromptBlocks(text) {
    const source = String(text ?? '');
    return [...source.matchAll(BLOCK)].map(match => ({
        start: match.index,
        end: match.index + match[0].length,
        json: match[1].trim(),
        complete: !!match[2],
    }));
}

/** The text without its picture blocks (for the parser, and the main AI's view of older floors). */
export function withoutPromptBlocks(text) {
    const source = String(text ?? '');
    if (!source.includes(BLOCK_LABEL)) return source;
    return source.replace(BLOCK, '').replace(/\n{3,}/g, '\n\n');
}

/** Marks rendered picture blocks so the extension's styling hides them (one without the class too). */
export function decoratePromptBlocks(element) {
    element.find('.mes_text details').each(function () {
        const summary = this.querySelector(':scope > summary');
        if (summary?.textContent.includes(BLOCK_LABEL)) this.classList.add('ctp-prompt-block');
    });
}

/** How many of the latest AI floors keep their picture blocks in what the main AI is sent (0 = none). */
function blockDepth() {
    const depth = Math.trunc(Number(getSettings().parser.replyBlockDepth));
    return Number.isFinite(depth) && depth > 0 ? depth : 0;
}

/**
 * What the main AI is sent (chat completion): the picture blocks of AI messages older than the latest few are taken
 * out — the main AI sees the format and its recent pictures, not every picture of the chat.
 */
export function stripOldBlocks(messages) {
    if (!Array.isArray(messages) || !messages.some(message => JSON.stringify(message?.content ?? '').includes(BLOCK_LABEL))) return;
    let kept = 0;
    const depth = blockDepth();
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message?.role !== 'assistant') continue;
        if (kept < depth) {
            kept++;
            continue;
        }
        if (typeof message.content === 'string') message.content = withoutPromptBlocks(message.content);
        else if (Array.isArray(message.content)) {
            for (const part of message.content) {
                if (part?.type === 'text' && typeof part.text === 'string') part.text = withoutPromptBlocks(part.text);
            }
        }
    }
}

/**
 * The same for a text completion prompt (one string): the blocks of the latest few AI floors stay (as many blocks as
 * those floors have), the ones before them go.
 */
export function stripOldBlocksText(prompt) {
    const text = String(prompt ?? '');
    if (!text.includes(BLOCK_LABEL)) return text;
    const depth = blockDepth();
    let keep = 0;
    let floors = 0;
    const chat = ctx().chat ?? [];
    for (let index = chat.length - 1; index >= 0 && floors < depth; index--) {
        const message = chat[index];
        if (!message || message.is_user || message.is_system) continue;
        floors++;
        keep += findPromptBlocks(message.mes).length;
    }
    const blocks = findPromptBlocks(text);
    const drop = blocks.slice(0, Math.max(0, blocks.length - keep));
    let result = text;
    for (const block of drop.reverse()) result = `${result.slice(0, block.start)}${result.slice(block.end)}`;
    return result;
}

/*
 * A reply streaming in: SillyTavern sends its text so far with every token (STREAM_TOKEN_RECEIVED), and the floor is
 * rendered when it is done. A floor drawn from its blocks (see pipeline.js) follows the text through here.
 */

/** The reply being written now: { type, message, text, listeners, done, finish, stopped }, or null. */
let streaming = null;

/**
 * A generation starts (its type: normal, swipe, regenerate, continue …): its reply may be followed. Quiet ones (other
 * extensions, summaries), impersonation and dry runs (prompt previews) leave a reply being followed alone.
 */
export function replyStarted(type, dryRun = false) {
    if (dryRun || ['quiet', 'impersonate'].includes(type)) return;
    streaming?.finish(true);
    streaming = null;
    // 「继续」 streams only the new part: its floor is drawn from the whole text once it is done.
    if (!promptsInReply() || type === 'continue') return;
    let finish;
    const done = new Promise(resolve => {
        finish = resolve;
    });
    streaming = {
        type,
        message: null,
        text: '',
        listeners: new Set(),
        done,
        stopped: false,
        finish(stopped = false) {
            this.stopped = this.stopped || stopped;
            finish({ stopped: this.stopped });
        },
    };
}

/**
 * A token arrived: the reply's text so far. The streaming message is the newest one.
 * @returns {{ message: object, text: string } | null} the reply followed, for a floor to start drawing from
 */
export function replyToken(text) {
    if (!streaming) return null;
    const chat = ctx().chat ?? [];
    const message = chat.at(-1);
    if (!message || message.is_user) return null;
    streaming.message ??= message;
    if (streaming.message !== message) return null;
    streaming.text = String(text ?? '');
    for (const listener of streaming.listeners) listener(streaming.text);
    return { message, text: streaming.text };
}

/**
 * The reply is done (its floor rendered: `message`), or was stopped. Another floor rendered meanwhile (an extension
 * drawing an older one again) does not end it.
 */
export function replyEnded({ stopped = false, message = null } = {}) {
    if (!streaming) return;
    if (!stopped && message && streaming.message && streaming.message !== message) return;
    streaming.finish(stopped);
    if (!stopped) streaming = null;
}

/**
 * The reply of a floor while it is still streaming in: listen(text) gets its text as it grows, done resolves when it
 * is complete ({ stopped }). null when the floor's reply is not streaming (it is complete).
 * @returns {{ text: string, listen: (fn: (text: string) => void) => () => void, done: Promise<{ stopped: boolean }> } | null}
 */
export function replyStream(message) {
    if (!streaming || streaming.message !== message) return null;
    const current = streaming;
    return {
        text: current.text,
        listen(fn) {
            current.listeners.add(fn);
            return () => current.listeners.delete(fn);
        },
        done: current.done,
    };
}
