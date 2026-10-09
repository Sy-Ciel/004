import { getJob } from './pipeline.js';
import { ctx, escapeHtml, getMessageData, getSettings } from './utils.js';

function messageElement(mesId) {
    return $(`#chat .mes[mesid="${mesId}"]`);
}

function placeWrap(element, wrap) {
    const text = element.find('.mes_text').first();
    if (!text.length) return;
    if (getSettings().imagePosition === 'above') {
        if (wrap.next()[0] !== text[0]) wrap.insertBefore(text);
    } else if (wrap.prev()[0] !== text[0]) {
        wrap.insertAfter(text);
    }
}

function statusHtml(job) {
    const icon = job.stage === 'parsing' ? 'fa-magnifying-glass' : job.stage === 'drawing' ? 'fa-paintbrush' : 'fa-hourglass-half';
    return `<div class="ctp-status">
        <i class="fa-solid ${icon} fa-beat-fade"></i>
        <span>${escapeHtml(job.text)}</span>
        <span class="ctp-link ctp-act" data-act="cancel">取消</span>
    </div>`;
}

function imageHtml(data, debug) {
    const index = Math.min(Math.max(0, data.index ?? 0), data.images.length - 1);
    const image = data.images[index];
    const nav = data.images.length > 1
        ? `<i class="fa-solid fa-chevron-left ctp-act" data-act="prev" title="上一张"></i>
           <span class="ctp-count">${index + 1}/${data.images.length}</span>
           <i class="fa-solid fa-chevron-right ctp-act" data-act="next" title="下一张"></i>`
        : '';
    const meta = debug
        ? `<span class="ctp-meta">${escapeHtml(data.target || '')} · seed ${escapeHtml(image.seed ?? '')} · ${image.width}×${image.height}</span>`
        : '';
    return `<div class="ctp-figure">
        <img class="ctp-img ctp-act" data-act="zoom" src="${escapeHtml(image.src)}" alt="" loading="lazy" style="max-width: min(100%, ${Number(getSettings().imageMaxWidth) || 480}px)">
    </div>
    <div class="ctp-toolbar">
        ${nav}
        <i class="fa-solid fa-dice ctp-act" data-act="reroll" title="同一提示词换种子重画"></i>
        <i class="fa-solid fa-rotate ctp-act" data-act="reparse" title="重新解析状态并生成"></i>
        <i class="fa-solid fa-pen-to-square ctp-act" data-act="edit" title="编辑提示词后生成"></i>
        ${debug ? '<i class="fa-solid fa-bug ctp-act" data-act="debug" title="调试信息"></i>' : ''}
        <i class="fa-solid fa-trash-can ctp-act" data-act="delete" title="删除这张图"></i>
        ${meta}
    </div>`;
}

function inlineDebugHtml(data, mesId) {
    const index = Math.min(Math.max(0, data.index ?? 0), Math.max(0, (data.images?.length ?? 1) - 1));
    const prompt = data.images?.[index]?.prompt || data.prompt;
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
    const data = getMessageData(message);
    const job = getJob(message);
    const showJob = job && job.swipeId === (message?.swipe_id ?? 0);

    let wrap = element.find('.ctp-wrap');
    const hasImages = data?.images?.length > 0;
    const showError = data?.error;
    const showSkip = data?.skipped && settings.debug;
    if (!message || (!showJob && !hasImages && !showError && !showSkip)) {
        wrap.remove();
        return;
    }

    if (!wrap.length) {
        wrap = $('<div class="ctp-wrap"></div>');
    }
    placeWrap(element, wrap);

    const parts = [];
    if (showJob) parts.push(statusHtml(job));
    if (hasImages) parts.push(imageHtml(data, settings.debug));
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
}

export function renderAll() {
    $('#chat .mes').each(function () {
        const mesId = Number($(this).attr('mesid'));
        if (Number.isInteger(mesId)) renderMessage(mesId);
    });
}
