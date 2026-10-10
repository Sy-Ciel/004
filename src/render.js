import { renderHints } from './hints.js';
import { layoutMode } from './layout.js';
import { currentIndex, statusHtml, toolbarHtml } from './markup.js';
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

function imageHtml(data, debug) {
    const image = data.images[currentIndex(data)];
    return `<div class="ctp-figure">
        <img class="ctp-img ctp-act" data-act="zoom" src="${escapeHtml(image.src)}" alt="" loading="lazy" style="--ctp-img-max: ${Number(getSettings().imageMaxWidth) || 480}px">
    </div>
    ${toolbarHtml(data, debug)}`;
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

    const parts = [];
    if (showJob) parts.push(statusHtml(job));
    if (hasImages) parts.push(mode.kind === 'panel' ? chipHtml(data) : imageHtml(data, settings.debug));
    if (showError) {
        parts.push(`<div class="ctp-error">
            <i class="fa-solid fa-triangle-exclamation"></i>
            <span>配图失败：${escapeHtml(String(data.error).split('\n')[0])}</span>
            <span class="ctp-link ctp-act" data-act="reparse">重试</span>
            <span class="ctp-link ctp-act" data-act="debug">详情</span>
            ${hasImages ? '' : '<span class="ctp-link ctp-act" data-act="clear">关闭</span>'}
        </div>`);
    }
    if (showSkip && !hasImages) {
        parts.push(`<div class="ctp-skip">
            <i class="fa-solid fa-forward"></i>
            <span>#${mesId} 跳过：${escapeHtml(data.skipped)}</span>
            <span class="ctp-link ctp-act" data-act="force">强制生成</span>
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
