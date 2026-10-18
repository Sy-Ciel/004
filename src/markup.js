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

/**
 * The pictures of one version in story order: with 多张图 the earlier parts of the floor first, then the end.
 * @returns {{ src: string, label: string, scene: number, start: string }[]} scene = index in image.scenes, -1 for
 *   the end; start = the opening words of that part in the text
 */
export function versionPictures(image) {
    const scenes = Array.isArray(image?.scenes) ? image.scenes : [];
    return [
        ...scenes.map((scene, index) => ({ src: scene.src, label: scene.label || `第 ${index + 1} 段`, scene: index, start: scene.start || '' })),
        { src: image?.src, label: scenes.length ? '结束时' : '', scene: -1, start: image?.start || '' },
    ];
}

/** One picture of a version: its label and own 🎲 / ✏️ (only when the version has several), then the image. */
export function pictureHtml(picture, several, { imgClass = 'ctp-img', style = '' } = {}) {
    const tools = several
        ? `<span class="ctp-picture-tools">
            <i class="fa-solid fa-dice ctp-act" data-act="picture-reroll" data-scene="${picture.scene}" title="只换种子重画这一张（其他几张不变）"></i>
            <i class="fa-solid fa-pen-to-square ctp-act" data-act="picture-edit" data-scene="${picture.scene}" title="编辑这一张的提示词后只重画这一张"></i>
        </span>`
        : '';
    const head = picture.label || tools ? `<div class="ctp-scene-head"><span class="ctp-scene-label">${escapeHtml(picture.label)}</span>${tools}</div>` : '';
    return `${head}<img class="${imgClass} ctp-act" data-act="zoom" data-scene="${picture.scene}" src="${escapeHtml(picture.src)}" alt="" loading="lazy"${style ? ` style="${style}"` : ''}>`;
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
        <i class="fa-solid fa-dice ctp-act" data-act="reroll" title="${image?.scenes?.length ? '全部换种子重画（每张图上的 🎲 只重画那一张）' : '同一提示词换种子重画'}"></i>
        <i class="fa-solid fa-rotate ctp-act" data-act="reparse" title="重新解析状态并生成"></i>
        <i class="fa-solid fa-pen-to-square ctp-act" data-act="edit" title="${image?.scenes?.length ? '编辑「结束时」这一张的提示词后重画（其他几张不变）' : '编辑提示词后生成'}"></i>
        <i class="fa-solid fa-comment-dots ctp-act" data-act="hint" title="加画图指令重画（不改正文）"></i>
        ${debug ? '<i class="fa-solid fa-bug ctp-act" data-act="debug" title="调试信息"></i>' : ''}
        <i class="fa-solid fa-trash-can ctp-act" data-act="delete" title="删除这张图"></i>
        ${meta}
    </div>`;
}
