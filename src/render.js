import { renderHints } from './hints.js';
import { layoutMode } from './layout.js';
import { findPartStarts, insertBeforeLine } from './anchors.js';
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
function imageHtml(data, debug, pictures, several) {
    const figures = pictures.map(picture => `<div class="ctp-figure">${pictureHtml(picture, several, { style: imageStyle() })}</div>`);
    return `${figures.join('')}
    ${toolbarHtml(data, debug)}`;
}

/** Takes the pictures put into a message's text out again. */
function clearInserted(element) {
    const text = element.find('.mes_text').get(0);
    if (!text) return;
    text.querySelectorAll('.ctp-inserted').forEach(node => node.remove());
    delete text.dataset.ctpPlaced;
}

/**
 * 多张图: puts the shown version's pictures into the text where their parts are. Layout "below": each picture
 * after its part, the last one staying under the text with the toolbar; "above" / beside the text: each before
 * its part, the first one staying in the image block. Returns the pictures for the image block: all of them
 * when a part's start is not found in the text (nothing is inserted then).
 */
function placePictures(element, pictures, kind) {
    const text = element.find('.mes_text').get(0);
    if (!text || pictures.length < 2) {
        clearInserted(element);
        return pictures;
    }
    const signature = `${kind}|${pictures.map(picture => picture.src).join('|')}`;
    const inserted = text.querySelectorAll('.ctp-inserted');
    // Still in place from the last render (SillyTavern redraws the text when it changes, which removes them).
    if (text.dataset.ctpPlaced === signature && inserted.length === pictures.length - 1) {
        return pictures.filter(picture => picture.scene === Number(text.dataset.ctpKept));
    }
    clearInserted(element);
    const starts = findPartStarts(text, pictures.slice(1).map(picture => picture.start));
    if (!starts) return pictures;
    const below = kind !== 'above' && kind !== 'inline';
    const kept = below ? pictures.at(-1) : pictures[0];
    // starts[k] is where part k + 1 begins: below, picture i goes there for i = k; otherwise picture k + 1 does.
    const placed = pictures.every((picture, index) => {
        if (picture === kept) return true;
        const figure = document.createElement('div');
        figure.className = 'ctp-inserted ctp-figure';
        figure.innerHTML = pictureHtml(picture, true, { style: imageStyle() });
        return insertBeforeLine(text, starts[below ? index : index - 1], figure);
    });
    if (!placed) {
        clearInserted(element);
        return pictures;
    }
    text.dataset.ctpPlaced = signature;
    text.dataset.ctpKept = String(kept.scene);
    return [kept];
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
    placeWrap(element, wrap, mode.kind);
    applySideLayout(element, wrap, hasImages && mode.kind === 'inline' ? mode.side : null);

    // 多张图: pictures go into the text at their parts; the panel shows them all itself.
    let pictures = [];
    let several = false;
    if (hasImages && mode.kind !== 'panel') {
        const all = versionPictures(data.images[currentIndex(data)]);
        several = all.length > 1;
        pictures = placePictures(element, all, mode.kind);
    } else {
        clearInserted(element);
    }

    const parts = [];
    if (showJob) parts.push(statusHtml(job));
    if (hasImages) parts.push(mode.kind === 'panel' ? chipHtml(data) : imageHtml(data, settings.debug, pictures, several));
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
