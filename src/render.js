import { renderHints } from './hints.js';
import { layoutMode } from './layout.js';
import { findPartStarts, findPlaces, insertAfterLine, insertBeforeLine } from './anchors.js';
import { currentIndex, pictureHtml, statusHtml, toolbarHtml, versionPictures } from './markup.js';
import { getPanelMesId, schedulePanelRefresh } from './panel.js';
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
    const figures = pictures.map(picture => `<div class="ctp-figure">${pictureHtml(picture, several, { style: imageStyle() })}</div>`);
    return `${figures.join('')}
    ${toolbarHtml(data, debug, { panelButton })}`;
}

/** Takes the pictures put into a message's text out again (the image block is moved by placeWrap). */
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
 * - 图片插在正文中间, with the sentences the parser chose found in the text: every picture right after its
 *   sentence's line; the end of the floor's picture comes with the image block, so the toolbar stays with it.
 * - 多张图, with the parts' opening words found: the earlier pictures into the text at their parts (layout below:
 *   after the part; above / beside: before it), one picture staying in the image block at its usual place.
 * - otherwise all pictures in the image block.
 * A placement that has not changed is left alone (SillyTavern redraws the text when it changes, which takes the
 * pictures out; they are put back then).
 * @returns {{ kept: object[], wrapInText: boolean }} kept: the pictures shown in the image block
 */
function placePictures(element, wrap, pictures, kind, inStory) {
    const text = element.find('.mes_text').get(0);
    if (!text) return { kept: pictures, wrapInText: false };
    const signature = JSON.stringify([kind, inStory, pictures.map(picture => [picture.src, picture.start, picture.place])]);
    const state = text.ctpPlacement;
    if (state?.signature === signature && text.querySelectorAll('.ctp-inserted').length === state.inserted && (!state.wrapInText || text.contains(wrap))) {
        return { kept: pictures.filter(picture => state.kept.includes(picture.scene)), wrapInText: state.wrapInText };
    }
    clearInserted(element);
    const remember = (kept, wrapInText) => {
        text.ctpPlacement = { signature, kept: kept.map(picture => picture.scene), wrapInText, inserted: pictures.length - kept.length };
        return { kept, wrapInText };
    };

    if (inStory && pictures.every(picture => picture.place)) {
        const lines = findPlaces(text, pictures.map(picture => picture.place));
        if (lines) {
            // The image block first, then the other pictures from the last back, so pictures after the same
            // sentence keep their order.
            let placed = insertAfterLine(text, lines.at(-1), wrap);
            for (let index = pictures.length - 2; placed && index >= 0; index--) {
                placed = insertAfterLine(text, lines[index], insertedFigure(pictures[index]));
            }
            if (placed) return remember([pictures.at(-1)], true);
            clearInserted(element);
        }
    }

    if (pictures.length > 1) {
        const starts = findPartStarts(text, pictures.slice(1).map(picture => picture.start));
        if (starts) {
            const below = kind !== 'above' && kind !== 'inline';
            const kept = below ? pictures.at(-1) : pictures[0];
            // starts[k] is where part k + 1 begins: below, picture k goes there; otherwise picture k + 1 does.
            const placed = pictures.every((picture, index) => picture === kept
                || insertBeforeLine(text, starts[below ? index : index - 1], insertedFigure(picture)));
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
        const all = versionPictures(data.images[currentIndex(data)]);
        several = all.length > 1;
        ({ kept: pictures, wrapInText } = placePictures(element, wrap[0], all, kind, !!settings.placeInStory));
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
