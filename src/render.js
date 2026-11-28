import { renderHints } from './hints.js';
import { layoutMode } from './layout.js';
import { insertAfterLine, insertBeforeLine, placeAnchors, shownText } from './anchors.js';
import { currentIndex, pictureHtml, statusHtml, toolbarHtml, upscaleStatusHtml, versionPictures } from './markup.js';
import { getPanelMesId, schedulePanelRefresh } from './panel.js';
import { storyParagraphs } from './parser.js';
import { getJob, upscaleStatus } from './pipeline.js';
import { currentMode, floorMode } from './modes.js';
import { decorateStatusBars } from './statusBar.js';
import { BLOCK_LABEL, decoratePromptBlocks } from './inReply.js';
import { ctx, escapeHtml, getMessageData, getSettings } from './utils.js';

export { onLayoutChange } from './layout.js';

function messageElement(mesId) {
    return $(`#chat .mes[mesid="${mesId}"]`);
}

function placeWrap(element, wrap, kind) {
    const text = element.find('.mes_text').first();
    if (!text.length) return;
    // Floated images must come before the text they sit next to.
    if (kind === 'above' || kind === 'inline') {
        if (wrap.next()[0] !== text[0]) wrap.insertBefore(text);
    } else if (wrap.prev()[0] !== text[0]) {
        wrap.insertAfter(text);
    }
}

/** Floats the block beside the text inside the message. Only used once there is an image to show. */
function applySideLayout(element, wrap, side) {
    const settings = getSettings();
    const block = element.find('.mes_block').first();
    wrap.toggleClass('ctp-side', !!side)
        .toggleClass('ctp-side-left', side === 'left')
        .toggleClass('ctp-side-right', side === 'right');
    block.toggleClass('ctp-has-side', !!side)
        .toggleClass('ctp-text-wrap', !!side && !!settings.sideTextWrap);
    if (side) {
        const percent = Math.min(80, Math.max(10, Number(settings.sideWidth) || 40));
        wrap.css({ '--ctp-side-width': `${percent}%`, '--ctp-side-max': `${Number(settings.imageMaxWidth) || 480}px` });
    } else {
        wrap.css({ '--ctp-side-width': '', '--ctp-side-max': '' });
    }
}

function imageStyle() {
    return `--ctp-img-max: ${Number(getSettings().imageMaxWidth) || 480}px`;
}

/** 画好一张显示一张: the pictures of a floor still being drawn that are not in the text; no toolbar yet. */
function liveHtml(pictures, several) {
    return pictures.map(picture => `<div class="ctp-figure">${pictureHtml(picture, several, { style: imageStyle(), tools: 'none' })}</div>`).join('');
}

/** The image block: the pictures that are not in the text (see placePictures) and the toolbar. */
function imageHtml(data, debug, pictures, several, panelButton) {
    // Only one of several pictures here (the others are in the text): the toolbar under it acts on that one.
    const scene = several && pictures.length === 1 ? pictures[0].scene : null;
    const tools = scene === null ? 'all' : 'link';
    const figures = pictures.map(picture => `<div class="ctp-figure">${pictureHtml(picture, several, { style: imageStyle(), tools })}</div>`);
    return `${figures.join('')}
    ${toolbarHtml(data, debug, { panelButton, scene })}`;
}

/** Message blocks watched for their text being drawn again with the pictures gone (see watchText). */
const watched = new WeakSet();

/**
 * Pictures in the text are lost when something draws the message text again (a display regex, another extension)
 * without telling: once the text has stopped changing, a floor whose pictures are gone is drawn again.
 */
function watchText(element) {
    const block = element.find('.mes_block').get(0);
    if (!block || watched.has(block)) return;
    watched.add(block);
    let timer = null;
    new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            if (!block.isConnected) return;
            const text = block.querySelector('.mes_text');
            const mesId = Number(block.closest('.mes')?.getAttribute('mesid'));
            if (text && !placementIntact(text) && Number.isInteger(mesId)) renderMessage(mesId);
        }, 200);
    }).observe(block, { childList: true, subtree: true });
}

/**
 * Whether the pictures are still where they were put, for the same shown text: none of them taken out, and the text
 * not drawn again in the meantime (editing the message swaps it for the edit box and back).
 */
function placementIntact(text, wrap = text.querySelector('.ctp-wrap')) {
    const state = text.ctpPlacement;
    return !!state && text.querySelectorAll('.ctp-inserted').length === state.inserted
        && (!state.wrapInText || (!!wrap && text.contains(wrap)))
        && shownText(text) === state.shown;
}

/** Takes the pictures put into a message's text out again (the image block is moved by placeWrap). */
function clearInserted(element) {
    const text = element.find('.mes_text').get(0);
    if (!text) return;
    // (The pictures of a reply still streaming in are kept at their blocks, see streamPictures.)
    text.querySelectorAll('.ctp-inserted:not(.ctp-stream-figure)').forEach(node => node.remove());
    delete text.ctpPlacement;
}

/*
 * 提示词和正文一起出, a reply still streaming in. SillyTavern draws the message's text again with every token (all of
 * it, or patched node by node with its fade-in), which takes out whatever was put into it. So each picture — or the
 * line saying it is on its way — is kept right after the block it was written in (the hidden <details> marks the
 * spot) and put back every time the text was drawn again: the same node, so nothing flickers or loads twice.
 *
 * The chat keeps its place meanwhile. The text's height is held, so it is never shorter for the moment its pictures
 * are out (a chat at its end would be moved up by as much). And SillyTavern before 1.14 goes to the end of the chat
 * right after drawing the text, the pictures still out: what they add once they are back would look like the reader
 * scrolling up, and it would stop following the reply. So a chat that was at its end is put there again whenever the
 * pictures are put back or one of them is shown.
 */

/** Message texts with pictures kept at their blocks: { pictures, figures: block → node, observer, chat, … }. */
const streamed = new WeakMap();

/** The picture blocks of a message's text as shown, in order. */
function blockElements(text) {
    return [...text.querySelectorAll('details')].filter(details => details.querySelector(':scope > summary')?.textContent.includes(BLOCK_LABEL));
}

/** Whether the chat shows its end (as SillyTavern tells whether to follow a reply). */
function atEnd(chat) {
    return Math.abs(chat.scrollHeight - chat.clientHeight - chat.scrollTop) < 5;
}

/** Whether SillyTavern follows a reply at all (its 自动滚动 setting; the visual novel mode scrolls its own way). */
function followsReplies() {
    const power = ctx().powerUserSettings;
    return power?.auto_scroll_chat_to_bottom !== false && !power?.waifuMode;
}

/** The pictures are in (again), or one is shown: the text's height is held, a chat that was at its end is there again. */
function keepPlace(text, state) {
    const height = text.offsetHeight;
    const follow = !!state.chat && state.follows && followsReplies() && !atEnd(state.chat);
    if (height > state.height) {
        state.height = height;
        text.style.minHeight = `${height}px`;
    }
    if (follow) state.chat.scrollTop = state.chat.scrollHeight;
}

/**
 * Shows a picture, or the line for one on its way, in its figure. A picture only once it is loaded, the line staying
 * until then: the text grows in one step, here, and the chat can be kept at its end in the same step.
 */
function fillFigure(figure, picture, text, state) {
    const signature = `${picture.state}|${picture.src ?? ''}`;
    if (figure.dataset.signature === signature) return;
    figure.dataset.signature = signature;
    const holder = document.createElement('div');
    // (No label: which part of the floor a picture is, is only known once the reply is done. And loaded at once: a
    // picture that waits to come into view never does, taken out and put back all the time.)
    holder.innerHTML = pictureHtml({ ...picture, label: '' }, false, { style: imageStyle(), lazy: false });
    const show = () => {
        // (Unless something else is to be shown there by now.)
        if (figure.dataset.signature !== signature) return;
        figure.replaceChildren(...holder.childNodes);
        if (!figure.isConnected) return;
        state.observer.takeRecords();
        keepPlace(text, state);
    };
    const image = holder.querySelector('img');
    if (image && !image.complete && image.decode) image.decode().then(show, show);
    else show();
}

/** Puts every picture after its block (those whose block is not shown yet wait for it); how many blocks are shown. */
function putAtBlocks(text, state) {
    const blocks = blockElements(text);
    const shown = new Set();
    for (const picture of state.pictures) {
        const block = blocks[picture.block];
        if (!block) continue;
        const key = String(picture.block);
        shown.add(key);
        let figure = state.figures.get(key);
        if (!figure) {
            // An element of a kind of its own: SillyTavern's fade-in patches the text node by node, and would turn a
            // <div> standing where its next element goes into that element instead of taking it out.
            figure = document.createElement('ctp-figure');
            figure.className = 'ctp-inserted ctp-figure ctp-stream-figure';
            state.figures.set(key, figure);
        }
        fillFigure(figure, picture, text, state);
        if (block.nextSibling !== figure) block.after(figure);
    }
    for (const [key, figure] of state.figures) {
        if (shown.has(key)) continue;
        figure.remove();
        state.figures.delete(key);
    }
    // (What was changed just now is not a reason to look again.)
    state.observer.takeRecords();
    if (state.figures.size) keepPlace(text, state);
    return blocks.length;
}

/**
 * Keeps the pictures of a reply still streaming in at their blocks.
 * @returns {object[]} the pictures left for the image block: all of them when the text shows no block at all (a
 *   display rule took them out), else none
 */
function streamPictures(element, pictures) {
    const text = element.find('.mes_text').get(0);
    if (!text) return pictures;
    let state = streamed.get(text);
    if (!state) {
        const chat = text.closest('#chat');
        state = { pictures: [], figures: new Map(), observer: null, chat, follows: !!chat && atEnd(chat), height: 0, onScroll: null, inText: false };
        state.observer = new MutationObserver(() => {
            // The blocks are shown only now (the reply's text is read before it is drawn), or not any more: the
            // image block gives up the pictures, or gets them.
            const mes = text.closest('.mes')?.getAttribute('mesid');
            const inText = putAtBlocks(text, state) > 0;
            if (inText !== state.inText && mes) renderMessage(Number(mes));
        });
        state.observer.observe(text, { childList: true, subtree: true });
        // Whether the reader is at the chat's end, as of the last time the chat moved.
        state.onScroll = () => {
            if (text.isConnected) state.follows = atEnd(chat);
            else forgetStream(text, state);
        };
        chat?.addEventListener('scroll', state.onScroll, { passive: true });
        streamed.set(text, state);
    }
    state.pictures = pictures.filter(picture => Number.isInteger(picture.block));
    state.inText = putAtBlocks(text, state) > 0;
    return state.inText ? pictures.filter(picture => !state.pictures.includes(picture)) : pictures;
}

/** Stops keeping a text's pictures at their blocks, and takes them out. */
function forgetStream(text, state) {
    state.observer.disconnect();
    state.chat?.removeEventListener('scroll', state.onScroll);
    for (const figure of state.figures.values()) figure.remove();
    streamed.delete(text);
}

/**
 * The reply is done (or the floor shows something else): the pictures kept at their blocks are taken out, for the
 * version's to go where it has them.
 * @returns {() => void} to call once those are in: lets go of the text's height, a chat that was at its end is there again
 */
function stopStreamPictures(element) {
    const text = element.find('.mes_text').get(0);
    const state = text && streamed.get(text);
    if (!state) return () => {};
    forgetStream(text, state);
    return () => {
        text.style.minHeight = '';
        if (state.chat?.isConnected && state.follows && followsReplies()) state.chat.scrollTop = state.chat.scrollHeight;
    };
}

function insertedFigure(picture) {
    const figure = document.createElement('div');
    figure.className = 'ctp-inserted ctp-figure';
    figure.innerHTML = pictureHtml(picture, true, { style: imageStyle() });
    return figure;
}

/**
 * Where the shown version's pictures go:
 * - 图片插在正文中间: every picture right after the paragraph the parser chose for it; the end of the floor's
 *   picture comes with the image block, so the toolbar stays with it.
 * - 多张图: the earlier pictures where their parts are (layout below: after the part; above / beside: before it),
 *   one picture staying in the image block at its usual place.
 * A spot whose words are not found in the shown text is taken at the same share of the story (the paragraph the
 * parser named), else the pictures are spread evenly; a lone picture then goes after the story's last line, still
 * above code pages and the like. All pictures stay in the image block only when there is no story text at all.
 * A placement that has not changed is left alone (SillyTavern redraws the text when it changes, which takes the
 * pictures out; they are put back then).
 * @returns {{ kept: object[], wrapInText: boolean }} kept: the pictures shown in the image block
 */
function placePictures(element, wrap, pictures, kind, inStory, bounds = {}) {
    const text = element.find('.mes_text').get(0);
    if (!text) return { kept: pictures, wrapInText: false };
    const signature = JSON.stringify([kind, inStory, bounds, pictures.map(picture => [picture.src, picture.start, picture.place, picture.startAt, picture.placeAt, picture.state ?? ''])]);
    const state = text.ctpPlacement;
    if (state?.signature === signature && placementIntact(text, wrap)) {
        return { kept: pictures.filter(picture => state.kept.includes(picture.scene)), wrapInText: state.wrapInText };
    }
    clearInserted(element);
    const shown = shownText(text);
    const remember = (kept, wrapInText) => {
        text.ctpPlacement = { signature, kept: kept.map(picture => picture.scene), wrapInText, inserted: pictures.length - kept.length, shown };
        return { kept, wrapInText };
    };
    const count = pictures.length;

    // 图片插在正文中间: every picture goes into the story, one without a place of its own after its end.
    if (inStory) {
        const spots = placeAnchors(text, pictures.map((picture, index) => ({ quote: picture.place, at: picture.placeAt, even: (index + 1) / count, side: 'after' })), bounds);
        if (spots) {
            // The image block first, then the other pictures from the last back, so pictures after the same
            // paragraph keep their order.
            let placed = insertAfterLine(text, spots.at(-1).node, wrap);
            for (let index = count - 2; placed && index >= 0; index--) {
                placed = insertAfterLine(text, spots[index].node, insertedFigure(pictures[index]));
            }
            if (placed) return remember([pictures.at(-1)], true);
            clearInserted(element);
        }
    }

    if (count > 1) {
        // starts[k] is where part k + 1 begins: below, picture k goes there; otherwise picture k + 1 does.
        const starts = placeAnchors(text, pictures.slice(1).map((picture, index) => ({ quote: picture.start, at: picture.startAt, even: (index + 1) / count, side: 'before' })), bounds);
        if (starts) {
            const below = kind !== 'above' && kind !== 'inline';
            const kept = below ? pictures.at(-1) : pictures[0];
            const placed = pictures.every((picture, index) => picture === kept
                || insertBeforeLine(text, starts[below ? index : index - 1].node, insertedFigure(picture)));
            if (placed) return remember([kept], false);
            clearInserted(element);
        }
    }
    return remember(pictures, false);
}

/** In panel mode the message only keeps a compact bar; clicking it shows this floor in the panel. */
function chipHtml(data, live = false) {
    const count = data?.images?.length ?? 0;
    return `<div class="ctp-chip ctp-act" data-act="panel" title="在侧边面板中显示这一楼的图">
        <i class="fa-solid fa-image"></i>
        <span>配图${live ? ' · 正在画' : count > 1 ? ` · ${count} 张` : ''}</span>
        <span class="ctp-chip-state"></span>
    </div>`;
}

function inlineDebugHtml(data, mesId) {
    const prompt = data.images?.[currentIndex(data)]?.prompt || data.prompt;
    if (!prompt) return '';
    return `<details class="ctp-inline-debug">
        <summary>#${mesId} 提示词 · 目标：${escapeHtml(data.target || '?')}</summary>
        <pre>${escapeHtml(prompt)}</pre>
    </details>`;
}

/** Draws (or removes) the image block of one floor. The block lives only in the DOM, never in the message text. */
export function renderMessage(mesId) {
    const element = messageElement(mesId);
    if (!element.length) return;
    const message = ctx().chat[mesId];
    const settings = getSettings();
    renderHints(element, message);
    decorateStatusBars(element);
    // 提示词和正文一起出: the main AI's picture blocks are hidden.
    decoratePromptBlocks(element);
    const data = getMessageData(message);
    const job = getJob(message);
    const showJob = job && job.swipeId === (message?.swipe_id ?? 0);
    // 画好一张显示一张: a floor being drawn shows its pictures as they are done, in their places (FloorLine.preview).
    const live = showJob ? job.preview?.() ?? null : null;

    let wrap = element.find('.ctp-wrap');
    const hasImages = data?.images?.length > 0;
    const showError = data?.error && !live;
    const showSkip = data?.skipped && settings.debug && !live;
    if (!message || (!showJob && !hasImages && !showError && !showSkip)) {
        const settle = stopStreamPictures(element);
        clearInserted(element);
        wrap.remove();
        element.find('.mes_block').removeClass('ctp-has-side ctp-text-wrap');
        settle();
        schedulePanelRefresh();
        return;
    }

    if (!wrap.length) {
        wrap = $('<div class="ctp-wrap"></div>');
    }
    const mode = layoutMode();
    // Side panel layouts: the message keeps a compact bar, or shows the pictures too (under the text).
    const kind = mode.kind === 'panel' && settings.panelAlsoInMessage ? 'below' : mode.kind;

    // Pictures may go into the text (图片插在正文中间, 多张图); the panel shows them all itself.
    let pictures = [];
    let several = false;
    let wrapInText = false;
    // (A reply that was streaming in until now: see stopStreamPictures.)
    let settle = () => {};
    const shown = live ?? (hasImages ? data.images[currentIndex(data)] : null);
    if (shown && kind !== 'panel') {
        const image = shown;
        const all = versionPictures(image);
        several = all.length > 1;
        // 提示词和正文一起出: pictures drawn from the main AI's blocks go where the blocks are.
        const inStory = !!settings.placeInStory || !!image.inStory;
        // Pictures go into the story only (what is inside <game>…</game>), found by its paragraphs.
        // A version from before every one kept its story's ends has the floor's (the same story, read last).
        const bounds = {
            first: image.storyStart ?? data?.storyStart,
            last: image.storyEnd ?? data?.storyEnd,
            ending: image.storyEnding ?? data?.storyEnding,
            paragraphs: several || inStory ? storyParagraphs(message) : [],
        };
        if (image.streaming) {
            // The reply is still streaming in: each picture at the block it was written in (see streamPictures).
            clearInserted(element);
            pictures = streamPictures(element, all);
        } else {
            settle = stopStreamPictures(element);
            ({ kept: pictures, wrapInText } = placePictures(element, wrap[0], all, kind, inStory, bounds));
            if (several || inStory) watchText(element);
        }
    } else {
        settle = stopStreamPictures(element);
        clearInserted(element);
    }
    if (!wrapInText) placeWrap(element, wrap, kind);
    applySideLayout(element, wrap, shown && kind === 'inline' && !wrapInText ? mode.side : null);

    const parts = [];
    if (showJob) parts.push(statusHtml(job));
    if (live) parts.push(kind === 'panel' ? chipHtml(data, true) : liveHtml(pictures, several));
    else if (hasImages) parts.push(kind === 'panel' ? chipHtml(data) : imageHtml(data, settings.debug, pictures, several, mode.kind === 'panel'));
    if (hasImages && !live) parts.push(upscaleStatusHtml(upscaleStatus(message, data.images[currentIndex(data)])));
    if (showError) {
        // 重新发送提示词: ComfyUI failed after the parser had written the prompts (not reachable, an error in the
        // workflow …): they go to ComfyUI again as they are, without asking the parser. Not for another mode's prompts.
        const resend = data.failedAt === 'comfy' && !!data.prompt && (floorMode(data) === currentMode() || !!settings.autoModelByRating);
        parts.push(`<div class="ctp-error">
            <i class="fa-solid fa-triangle-exclamation"></i>
            <span>配图失败：${escapeHtml(String(data.error).split('\n')[0])}</span>
            ${resend ? '<span class="ctp-link ctp-act" data-act="resend" title="解析结果已经有了：不再问解析模型，把这一楼的提示词原样重新发给 ComfyUI（几张图都重画）">重新发送提示词</span>' : ''}
            <span class="ctp-link ctp-act" data-act="reparse"${resend ? ' title="重新问一次解析模型，再出图"' : ''}>${resend ? '重新解析' : '重试'}</span>
            <span class="ctp-link ctp-act" data-act="hint">加指令重画</span>
            <span class="ctp-link ctp-act" data-act="debug">详情</span>
            ${hasImages ? '' : '<span class="ctp-link ctp-act" data-act="clear">关闭</span>'}
        </div>`);
    }
    if (showSkip && !hasImages) {
        parts.push(`<div class="ctp-skip">
            <i class="fa-solid fa-forward"></i>
            <span>#${mesId} 跳过：${escapeHtml(data.skipped)}</span>
            <span class="ctp-link ctp-act" data-act="force">强制生成</span>
            <span class="ctp-link ctp-act" data-act="hint">加指令重画</span>
            <span class="ctp-link ctp-act" data-act="debug">详情</span>
        </div>`);
    }
    if (settings.debug && data) parts.push(inlineDebugHtml(data, mesId));

    const html = parts.join('');
    if (wrap.data('html') !== html) {
        wrap.data('html', html);
        wrap.html(html);
    }
    wrap.find('.ctp-chip').toggleClass('ctp-chip-active', getPanelMesId() === mesId);
    settle();
    schedulePanelRefresh();
}

export function renderAll() {
    $('#chat .mes').each(function () {
        const mesId = Number($(this).attr('mesid'));
        if (Number.isInteger(mesId)) renderMessage(mesId);
    });
    schedulePanelRefresh();
}
