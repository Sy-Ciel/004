import { renderHints } from './hints.js';
import { layoutMode } from './layout.js';
import { insertAfterLine, insertBeforeLine, placeAnchors, shownText } from './anchors.js';
import { currentIndex, pictureHtml, statusHtml, toolbarHtml, versionPictures } from './markup.js';
import { getPanelMesId, schedulePanelRefresh } from './panel.js';
import { storyParagraphs } from './parser.js';
import { getJob } from './pipeline.js';
import { decorateStatusBars } from './statusBar.js';
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

/** The image block: the pictures that are not in the text (see placePictures) and the toolbar. */
function imageHtml(data, debug, pictures, several, panelButton) {
    // Only one of several pictures here (the others are in the text): the toolbar under it acts on that one.
    const scene = several && pictures.length === 1 ? pictures[0].scene : null;
    const tools = scene === null ? 'all' : 'link';
    const figures = pictures.map(picture => `<div class="ctp-figure">${pictureHtml(picture, several, { style: imageStyle(), tools })}</div>`);
    return `${figures.join('')}
    ${toolbarHtml(data, debug, { panelButton, scene })}`;
}

/** Takes the pictures put into a message's text out again (the image block is moved by placeWrap). */
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

function clearInserted(element) {
    const text = element.find('.mes_text').get(0);
    if (!text) return;
    text.querySelectorAll('.ctp-inserted').forEach(node => node.remove());
    delete text.ctpPlacement;
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
    const signature = JSON.stringify([kind, inStory, bounds, pictures.map(picture => [picture.src, picture.start, picture.place, picture.startAt, picture.placeAt])]);
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
function chipHtml(data) {
    const count = data.images.length;
    return `<div class="ctp-chip ctp-act" data-act="panel" title="在侧边面板中显示这一楼的图">
        <i class="fa-solid fa-image"></i>
        <span>配图${count > 1 ? ` · ${count} 张` : ''}</span>
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
    const data = getMessageData(message);
    const job = getJob(message);
    const showJob = job && job.swipeId === (message?.swipe_id ?? 0);

    let wrap = element.find('.ctp-wrap');
    const hasImages = data?.images?.length > 0;
    const showError = data?.error;
    const showSkip = data?.skipped && settings.debug;
    if (!message || (!showJob && !hasImages && !showError && !showSkip)) {
        clearInserted(element);
        wrap.remove();
        element.find('.mes_block').removeClass('ctp-has-side ctp-text-wrap');
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
    if (hasImages && kind !== 'panel') {
        const image = data.images[currentIndex(data)];
        const all = versionPictures(image);
        several = all.length > 1;
        // Pictures go into the story only (what is inside <game>…</game>), found by its paragraphs.
        // A version from before every one kept its story's ends has the floor's (the same story, read last).
        const bounds = {
            first: image.storyStart ?? data.storyStart,
            last: image.storyEnd ?? data.storyEnd,
            ending: image.storyEnding ?? data.storyEnding,
            paragraphs: several || settings.placeInStory ? storyParagraphs(message) : [],
        };
        ({ kept: pictures, wrapInText } = placePictures(element, wrap[0], all, kind, !!settings.placeInStory, bounds));
        if (several || settings.placeInStory) watchText(element);
    } else {
        clearInserted(element);
    }
    if (!wrapInText) placeWrap(element, wrap, kind);
    applySideLayout(element, wrap, hasImages && kind === 'inline' && !wrapInText ? mode.side : null);

    const parts = [];
    if (showJob) parts.push(statusHtml(job));
    if (hasImages) parts.push(kind === 'panel' ? chipHtml(data) : imageHtml(data, settings.debug, pictures, several, mode.kind === 'panel'));
    if (showError) {
        parts.push(`<div class="ctp-error">
            <i class="fa-solid fa-triangle-exclamation"></i>
            <span>配图失败：${escapeHtml(String(data.error).split('\n')[0])}</span>
            <span class="ctp-link ctp-act" data-act="reparse">重试</span>
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
    schedulePanelRefresh();
}

export function renderAll() {
    $('#chat .mes').each(function () {
        const mesId = Number($(this).attr('mesid'));
        if (Number.isInteger(mesId)) renderMessage(mesId);
    });
    schedulePanelRefresh();
}
