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

/** Where a block begins: <details …><summary>…配图提示词…</summary>. */
const BLOCK_START = /<details\b[^>]*>\s*<summary\b[^>]*>[^<]*配图提示词[^<]*<\/summary>/gi;
/** The block's closing tag right after its JSON (a ``` closing a fence, or a few stray characters, in between). */
const CLOSE_AFTER = /^[^<]{0,200}<\/details\s*>/i;
const CLOSE = /<\/details\s*>/i;
/** Without a closing tag: the ``` closing the fence the JSON was written in still belongs to the block. */
const FENCE_AFTER = /^\s*```/;

/**
 * Where the JSON object that begins at the first { of `text` ends (the index after its }), or -1 while it is not
 * closed. Strings are stepped over, so a brace inside a prompt does not count.
 */
function objectEnd(text) {
    const open = text.indexOf('{');
    if (open < 0) return -1;
    let depth = 0;
    let inString = false;
    for (let index = open; index < text.length; index++) {
        const char = text[index];
        if (inString) {
            if (char === '\\') index++;
            else if (char === '"') inString = false;
        } else if (char === '"') {
            inString = true;
        } else if (char === '{' || char === '[') {
            depth++;
        } else if ((char === '}' || char === ']') && --depth === 0) {
            return index + 1;
        }
    }
    return -1;
}

/**
 * The picture blocks of a reply, in order. A block is written — complete — the moment its JSON object is closed: its
 * picture can go to ComfyUI then, while the main AI writes on (the closing tag is not waited for, and a block whose
 * closing tag the main AI forgot ends at its JSON, so the story after it stays story). A block whose JSON cannot be
 * followed that way (a quote left unescaped) is complete with its closing tag.
 * @returns {{ start: number, end: number, json: string, complete: boolean }[]} start / end: the block in the text;
 *   json: what is in it; complete: false for the one still being written at the end of a reply streaming in
 */
export function findPromptBlocks(text) {
    const source = String(text ?? '');
    if (!source.includes(BLOCK_LABEL)) return [];
    const starts = [...source.matchAll(BLOCK_START)];
    return starts.map((match, index) => {
        const start = match.index;
        const from = start + match[0].length;
        // The block's content is before the next block at the latest.
        const region = source.slice(from, starts[index + 1]?.index ?? source.length);
        const object = objectEnd(region);
        if (object >= 0) {
            const after = region.slice(object);
            const close = after.match(CLOSE_AFTER) ?? after.match(FENCE_AFTER);
            return { start, end: from + object + (close ? close[0].length : 0), json: region.slice(0, object).trim(), complete: true };
        }
        const close = region.match(CLOSE);
        if (close) return { start, end: from + close.index + close[0].length, json: region.slice(0, close.index).trim(), complete: true };
        // Still being written (the last one), or broken: what follows a broken one stays in the text.
        const last = index === starts.length - 1;
        return { start, end: last ? source.length : from, json: region.trim(), complete: false };
    });
}

/** The text without its picture blocks (for the parser, and the main AI's view of older floors). */
export function withoutPromptBlocks(text) {
    const source = String(text ?? '');
    const blocks = findPromptBlocks(source);
    if (!blocks.length) return source;
    let result = '';
    let at = 0;
    for (const block of blocks) {
        result += source.slice(at, block.start);
        at = block.end;
    }
    return `${result}${source.slice(at)}`.replace(/\n{3,}/g, '\n\n');
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
 * Whether SillyTavern is still streaming this message's reply — its own streaming processor says so. Nothing else
 * does: a card's script or another extension may draw the floor again meanwhile, firing its "rendered" event.
 */
export function stillStreaming(message) {
    const processor = ctx().streamingProcessor;
    if (!message || !processor || processor.isFinished || processor.isStopped || processor.abortController?.signal?.aborted) return false;
    return (ctx().chat ?? [])[processor.messageId] === message;
}

/**
 * A generation starts (its type: normal, swipe, regenerate, continue …): its reply may be followed. Quiet ones (other
 * extensions, summaries), impersonation and dry runs (prompt previews) leave a reply being followed alone.
 */
export function replyStarted(type, dryRun = false) {
    if (dryRun || ['quiet', 'impersonate'].includes(type)) return;
    // One started while the reply followed still streams in is someone else's (a card's script, an extension).
    if (streaming?.message && stillStreaming(streaming.message)) return;
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
    // The message SillyTavern streams into: the newest one, unless something was added after it meanwhile.
    const processor = ctx().streamingProcessor;
    const message = processor && processor.messageId >= 0 && chat[processor.messageId] ? chat[processor.messageId] : chat.at(-1);
    if (!message || message.is_user) return null;
    streaming.message ??= message;
    if (streaming.message !== message) return null;
    streaming.text = String(text ?? '');
    for (const listener of streaming.listeners) listener(streaming.text);
    return { message, text: streaming.text };
}

/**
 * The reply is done (its floor rendered: `message`), or was stopped. A floor rendered while the reply still streams in
 * — another one, or this one drawn again by a card's script or an extension — does not end it.
 */
export function replyEnded({ stopped = false, message = null } = {}) {
    if (!streaming) return;
    if (!stopped && message) {
        if (streaming.message && streaming.message !== message) return;
        if (stillStreaming(streaming.message ?? message)) return;
    }
    streaming.finish(stopped);
    if (!stopped) streaming = null;
}

/**
 * SillyTavern's generation ended (its stop button went away): the reply is complete — or was stopped: then
 * GENERATION_STOPPED comes right after this event, so the end waits a moment for it.
 */
export function replyGenerationEnded() {
    if (!streaming) return;
    const processor = ctx().streamingProcessor;
    const aborted = !!processor?.isStopped || !!processor?.abortController?.signal?.aborted;
    setTimeout(() => replyEnded({ stopped: aborted }), 0);
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
