import { escapeHtml } from './utils.js';

export function currentIndex(data) {
    return Math.min(Math.max(0, data?.index ?? 0), Math.max(0, (data?.images?.length ?? 1) - 1));
}

export function statusHtml(job) {
    const icon = job.stage === 'parsing' ? 'fa-magnifying-glass' : job.stage === 'drawing' ? 'fa-paintbrush' : 'fa-hourglass-half';
    return `<div class="ctp-status">
        <i class="fa-solid ${icon} fa-beat-fade"></i>
        <span>${escapeHtml(job.text)}</span>
        <span class="ctp-link ctp-act" data-act="cancel">取消</span>
    </div>`;
}

/** Version navigation and per-image actions; handled by the delegated `.ctp-act` click handler. */
export function toolbarHtml(data, debug) {
    const index = currentIndex(data);
    const image = data.images[index];
    const nav = data.images.length > 1
        ? `<i class="fa-solid fa-chevron-left ctp-act" data-act="prev" title="上一张"></i>
           <span class="ctp-count">${index + 1}/${data.images.length}</span>
           <i class="fa-solid fa-chevron-right ctp-act" data-act="next" title="下一张"></i>`
        : '';
    const meta = debug
        ? `<span class="ctp-meta">${escapeHtml(data.target || '')} · seed ${escapeHtml(image.seed ?? '')} · ${image.width}×${image.height}</span>`
        : '';
    return `<div class="ctp-toolbar">
        ${nav}
        <i class="fa-solid fa-dice ctp-act" data-act="reroll" title="同一提示词换种子重画"></i>
        <i class="fa-solid fa-rotate ctp-act" data-act="reparse" title="重新解析状态并生成"></i>
        <i class="fa-solid fa-pen-to-square ctp-act" data-act="edit" title="编辑提示词后生成"></i>
        ${debug ? '<i class="fa-solid fa-bug ctp-act" data-act="debug" title="调试信息"></i>' : ''}
        <i class="fa-solid fa-trash-can ctp-act" data-act="delete" title="删除这张图"></i>
        ${meta}
    </div>`;
}
