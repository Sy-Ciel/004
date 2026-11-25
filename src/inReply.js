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
 * A reply streaming in: SillyTavern sends its text so far with every token (STREAM_TOKEN_RECEIVED). A floor drawn from
 * its blocks (see pipeline.js) follows the text through here.
 *
 * When the reply is over is asked of SillyTavern's streaming processor itself (still running, finished, stopped), not
 * taken from an event: card scripts and other extensions fire "rendered" for floors while a reply streams in, and a
 * generation of their own ending fires "generation ended". Events are only a reason to look; a timer looks as well.
 */

/** The reply being followed: { type, message, processor, text, listeners, done, finish, trace, timer … }, or null. */
let streaming = null;
/** How replies were followed, by their message, for the floor's debug notes (see replyTrace). */
const traces = new WeakMap();
/** The last generation started: whether it could be followed ('' or why not). */
let lastStart = '';

/**
 * Whether SillyTavern is still streaming this message's reply — its own streaming processor says so. Nothing else
 * does: a card's script or another extension may draw the floor again meanwhile, firing its "rendered" event.
 */
export function stillStreaming(message) {
    const processor = ctx().streamingProcessor;
    if (!message || !processor || processorState(processor)) return false;
    return (ctx().chat ?? [])[processor.messageId] === message;
}

/** A streaming processor's state: '' while it streams, 'finished' when its reply is complete, 'stopped' (or failed). */
function processorState(processor) {
    if (processor.isStopped || processor.abortController?.signal?.aborted) return 'stopped';
    return processor.isFinished ? 'finished' : '';
}

/** Stops following: the floor drawing from the reply gets its end ({ stopped, text: all that streamed in }). */
function endFollowing(stopped, by) {
    const current = streaming;
    if (!current) return;
    streaming = null;
    clearInterval(current.timer);
    if (current.trace) Object.assign(current.trace, { ended: by, stopped, endedAt: performance.now() });
    current.finish({ stopped, text: current.text });
}

/**
 * Looks whether the reply followed is over (`by`: what gave the reason to look). While its processor still streams,
 * nothing that happens is its end.
 */
function checkEnd(by) {
    const current = streaming;
    if (!current?.message) return;
    const now = performance.now();
    if (current.processor) {
        const state = processorState(current.processor);
        if (state === 'stopped') return endFollowing(true, by);
        if (state !== 'finished') return;
        // Complete once SillyTavern has put the whole text into the message, which its events say; the timer is the
        // net under them.
        current.finishedAt ??= now;
        if (by !== 'timer' || now - current.finishedAt > 1500) endFollowing(false, by);
        return;
    }
    // A SillyTavern without the processor to ask: an event with no token after it for a while (one fired mid-stream is
    // followed by more), or a long silence.
    if (by === 'timer') {
        if (now - current.lastTokenAt > 8000 || (current.eventAt && current.eventAt >= current.lastTokenAt && now - current.eventAt > 1500)) endFollowing(false, by);
    } else {
        current.eventAt = now;
    }
}

/**
 * A generation starts (its type: normal, swipe, regenerate, continue …): its reply may be followed. Quiet ones (other
 * extensions, summaries), impersonation and dry runs (prompt previews) leave a reply being followed alone.
 */
export function replyStarted(type, dryRun = false) {
    if (dryRun || ['quiet', 'impersonate'].includes(type)) return;
    // One started while the reply followed still streams in is someone else's (a card's script, an extension).
    if (streaming?.processor && !processorState(streaming.processor)) return;
    // (Without a processor to ask: tokens that came a moment ago say it still streams.)
    if (streaming?.message && !streaming.processor && performance.now() - streaming.lastTokenAt < 1500) return;
    // One left over (its end never came): complete when its stream finished.
    if (streaming) endFollowing(!streaming.processor || processorState(streaming.processor) !== 'finished', 'next');
    // 「继续」 streams only the new part: its floor is drawn from the whole text once it is done.
    lastStart = !promptsInReply() ? '生成开始时「提示词和正文一起出」没有打开' : type === 'continue' ? '「继续」只输出新写的部分，等写完后读全文' : '';
    if (lastStart) return;
    let finish;
    const done = new Promise(resolve => {
        finish = resolve;
    });
    streaming = { type: type || 'normal', message: null, processor: null, text: '', listeners: new Set(), done, finish, trace: null, timer: 0, lastTokenAt: 0, finishedAt: null };
}

/**
 * A token arrived: the reply's text so far.
 * @returns {{ message: object, text: string } | null} the reply followed, for a floor to start drawing from
 */
export function replyToken(text) {
    if (!streaming) return null;
    const chat = ctx().chat ?? [];
    // The message SillyTavern streams into: the newest one, unless something was added after it meanwhile.
    const processor = ctx().streamingProcessor ?? null;
    const message = processor && processor.messageId >= 0 && chat[processor.messageId] ? chat[processor.messageId] : chat.at(-1);
    if (!message || message.is_user) return null;
    if (!streaming.message) {
        streaming.message = message;
        streaming.processor = processor;
        streaming.trace = { tokens: 0, startedAt: performance.now(), lastAt: 0, length: 0, jump: 0, blockAt: 0, blockToken: 0, refused: '', followed: false, ended: '', stopped: false, endedAt: 0 };
        traces.set(message, streaming.trace);
        streaming.timer = setInterval(() => checkEnd('timer'), 250);
    }
    if (streaming.message !== message) return null;
    streaming.text = String(text ?? '');
    streaming.lastTokenAt = performance.now();
    const { trace } = streaming;
    trace.tokens++;
    trace.lastAt = streaming.lastTokenAt;
    // The most text one update brought: a reply that is not really streamed comes (nearly) whole in one.
    trace.jump = Math.max(trace.jump, streaming.text.length - trace.length);
    trace.length = streaming.text.length;
    for (const listener of streaming.listeners) listener(streaming.text);
    return { message, text: streaming.text };
}

/** The first picture block of the reply followed is written (now): whether its floor could start, or why not. */
export function replyBlockWritten(message, refused = '') {
    const trace = traces.get(message);
    if (!trace) return;
    if (!trace.blockAt) Object.assign(trace, { blockAt: performance.now(), blockToken: trace.tokens });
    trace.refused = refused;
}

/** A floor was rendered: a reason to look whether the reply followed (if it is this floor's) is over. */
export function replyRendered(message) {
    if (streaming?.message && streaming.message === message) checkEnd('rendered');
}

/**
 * SillyTavern's generation ended (its stop button went away): a reason to look, a moment later — when the user
 * stopped it, the processor is told and GENERATION_STOPPED comes right after this event.
 */
export function replyGenerationEnded() {
    if (streaming?.message) setTimeout(() => checkEnd('ended'), 0);
}

/** The generation was stopped (the stop button), or the chat changed: the reply followed is over, without pictures. */
export function replyStopped() {
    endFollowing(true, 'stopped');
}

/**
 * The reply of a floor while it is still streaming in: listen(text) gets its text as it grows, done resolves when it
 * is over ({ stopped, text }). null when the floor's reply is not streaming (it is complete).
 * @returns {{ text: string, listen: (fn: (text: string) => void) => () => void, done: Promise<{ stopped: boolean, text: string }> } | null}
 */
export function replyStream(message) {
    if (!streaming || streaming.message !== message) return null;
    const current = streaming;
    if (current.trace) current.trace.followed = true;
    return {
        text: current.text,
        listen(fn) {
            current.listeners.add(fn);
            return () => current.listeners.delete(fn);
        },
        done: current.done,
    };
}

/**
 * How a floor's reply streamed in, in a line for its debug notes: how often its text was updated, when its first
 * picture block was written, and — when the floor did not start then — why.
 */
export function replyTrace(message) {
    const trace = traces.get(message);
    if (!trace) return `正文写完后才读的配图提示词：${lastStart || '这一楼的回复没有流式输出（酒馆没开流式，或者这个接口 / 反代不流式）'}`;
    const seconds = ms => `${(Math.max(0, ms) / 1000).toFixed(1)} 秒`;
    const streamed = `流式输出共更新 ${trace.tokens} 次，历时 ${seconds(trace.lastAt - trace.startedAt)}`;
    if (!trace.blockAt) return `正文写完后才读的配图提示词：${streamed}；输出过程中没有出现写完的配图块`;
    const left = trace.lastAt - trace.blockAt;
    const first = `第一个配图块在第 ${trace.blockToken} 次更新时写完，这时离输出结束还有 ${seconds(left)}`;
    // Most of the reply in one update: it was not really streamed, nothing was there to send early.
    if (trace.length > 200 && trace.jump > trace.length / 2) return `正文几乎是一次到达的（接口或反代是「假流式」：等全部写完才一起发回来），没法边写边画：${streamed}，其中一次就到了 ${trace.jump} 字（全文 ${trace.length} 字）；${first}`;
    if (trace.followed) return `正文还在输出时就开始了，写完一个配图块就送去 ComfyUI：${streamed}；${first}`;
    return `正文写完后才读的配图提示词：${streamed}；${first}；当时没有开始画：${trace.refused || '原因不明'}`;
}
