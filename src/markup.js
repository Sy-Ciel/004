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

/** 先画完所有图，再统一放大: the line under a version whose pictures wait for the upscale model (upscaleStatus). */
export function upscaleStatusHtml(status) {
    if (!status) return '';
    const text = status.error
        ? `放大失败（原图保留）：${status.error}`
        : status.running ? `正在放大…（这一版还剩 ${status.count} 张）` : `先出原图，排队的图画完后再放大（${status.count} 张）`;
    return `<div class="ctp-status ctp-upscale-status">
        <i class="fa-solid ${status.error ? 'fa-triangle-exclamation' : 'fa-up-right-and-down-left-from-center'}${status.running ? ' fa-beat-fade' : ''}"></i>
        <span>${escapeHtml(text)}</span>
        ${status.error ? '<span class="ctp-link ctp-act" data-act="upscale-retry">重试</span>' : ''}
        <span class="ctp-link ctp-act" data-act="upscale-drop">不放大了</span>
    </div>`;
}

/**
 * The pictures of one version in story order: with 多张图 the earlier parts of the floor first, then the end.
 * @returns {{ src: string, label: string, scene: number, start: string, place: string }[]} scene = index in
 *   image.scenes, -1 for the end; start = the opening words of that part in the text; place = the sentence the
 *   picture goes after (图片插在正文中间); startAt / placeAt = the same as a share (0–1) of the story, from the
 *   paragraph the parser named (used when the words are not found in the shown text)
 */
export function versionPictures(image) {
    const scenes = Array.isArray(image?.scenes) ? image.scenes : [];
    // 画好一张显示一张: a floor still being drawn (FloorLine.preview) says how far each picture is, and its size.
    const live = picture => (image?.live ? { live: true, state: picture.state || '', width: picture.width, height: picture.height, block: picture.block } : {});
    return [
        ...scenes.map((scene, index) => ({
            src: scene.src, label: scene.label || `第 ${index + 1} 段`, scene: index,
            start: scene.start || '', place: scene.place || '', startAt: scene.startAt, placeAt: scene.placeAt, ...live(scene),
        })),
        { src: image?.src, label: image?.label || (scenes.length ? '结束时' : ''), scene: -1, start: image?.start || '', place: image?.place || '', startAt: image?.startAt, placeAt: image?.placeAt, ...live(image) },
    ];
}

/**
 * 画好一张显示一张: where a picture still on its way will be — a slim line in the text (the picture takes its size when
 * it comes, so the story is not broken up by empty boxes meanwhile); in the side panel, its page.
 */
function pendingHtml(picture, panel, style) {
    const how = {
        drawing: ['fa-paintbrush fa-beat-fade', 'ComfyUI 正在画这一张…'],
        failed: ['fa-triangle-exclamation', '这一张没画成'],
    }[picture.state] ?? ['fa-hourglass-half', '排队中，前面的画完就画这一张'];
    return `<div class="ctp-pending${panel ? ' ctp-pending-panel' : ''}"${style ? ` style="${style}"` : ''}><i class="fa-solid ${how[0]}"></i><span>${how[1]}</span></div>`;
}

/** What one picture of a version carries; the rest of a version is about the floor (its story, mode, time). */
const PICTURE_KEYS = ['src', 'path', 'upscale', 'seed', 'width', 'height', 'prompt', 'negative', 'refined', 'place', 'placeAt', 'presetId', 'target'];

/**
 * 多张图: takes one picture out of a version, the others stay (scene = its index in image.scenes, -1 = the end of
 * the floor). The version's own picture is the end of the floor: when that one goes, the part before it takes its
 * place (with its label; `promoted` says the version's own picture is not the end of the floor any more). With one
 * picture left the version is a plain one. Only the version changes: what the floor was parsed into, and so what
 * 🎲 / 🔄 on the whole floor draw, stays.
 * @returns {object} the picture taken out (its path is the file to delete)
 */
export function removePicture(image, scene) {
    const scenes = image.scenes ?? [];
    let removed;
    if (scene >= 0) {
        [removed] = scenes.splice(scene, 1);
    } else {
        removed = Object.fromEntries(PICTURE_KEYS.filter(key => key in image).map(key => [key, image[key]]));
        const last = scenes.pop();
        for (const key of PICTURE_KEYS) delete image[key];
        for (const key of PICTURE_KEYS) if (last[key] !== undefined) image[key] = last[key];
        Object.assign(image, { label: last.label || '', start: last.start || '', startAt: last.startAt, promoted: true });
    }
    if (!scenes.length) {
        // One picture left: nothing to split the story at.
        delete image.scenes;
        delete image.start;
        delete image.startAt;
    }
    return removed;
}

/**
 * One picture of a version: its label and, when the version has several, its own buttons, then the image.
 * tools: 'all' = 🎲 🔄 ✏️ for this picture and 「全部重新解析」; 'link' = only 「全部重新解析」 (the toolbar under
 * it acts on this picture); 'none'. lazy: loaded only once it is near the part of the page in view.
 */
export function pictureHtml(picture, several, { imgClass = 'ctp-img', style = '', tools = 'all', lazy = true } = {}) {
    // 画好一张显示一张: a picture of a floor still being drawn is in no version yet: no buttons of its own.
    if (picture.live) tools = 'none';
    const own = tools === 'all'
        ? `<i class="fa-solid fa-dice ctp-act" data-act="picture-reroll" data-scene="${picture.scene}" title="只换种子重画这一张（其他几张不变）"></i>
            <i class="fa-solid fa-rotate ctp-act" data-act="picture-reparse" data-scene="${picture.scene}" title="只重新解析这一张：解析模型重写这一段的画面，只重画这一张（其他几张不变）"></i>
            <i class="fa-solid fa-pen-to-square ctp-act" data-act="picture-edit" data-scene="${picture.scene}" title="编辑这一张的提示词后只重画这一张"></i>
            <i class="fa-solid fa-trash-can ctp-act" data-act="picture-delete" data-scene="${picture.scene}" title="只删除这一张（其他几张不变）"></i>`
        : '';
    const buttons = several && tools !== 'none'
        ? `<span class="ctp-picture-tools">
            ${own}
            <span class="ctp-link ctp-act" data-act="reparse" title="全部重新解析：重新分段，几张图都重画">全部重新解析</span>
        </span>`
        : '';
    const head = picture.label || buttons ? `<div class="ctp-scene-head"><span class="ctp-scene-label">${escapeHtml(picture.label)}</span>${buttons}</div>` : '';
    if (!picture.src) return `${head}${pendingHtml(picture, imgClass === 'ctp-panel-img', style)}`;
    return `${head}<img class="${imgClass} ctp-act" data-act="zoom" data-scene="${picture.scene}"${picture.live ? ' data-live="1"' : ''} src="${escapeHtml(picture.src)}" alt=""${lazy ? ' loading="lazy"' : ''}${style ? ` style="${style}"` : ''}>`;
}

/**
 * Version navigation and per-image actions; handled by the delegated `.ctp-act` click handler.
 * scene: 多张图 with only one of the pictures above the toolbar (a side panel page, or the one picture left in the
 * image block): 🎲 / 🔄 / ✏️ act on that picture (its index in image.scenes, -1 = the end); otherwise on all.
 */
export function toolbarHtml(data, debug, { panelButton = false, scene = null } = {}) {
    const index = currentIndex(data);
    const image = data.images[index];
    const nav = data.images.length > 1
        ? `<i class="fa-solid fa-chevron-left ctp-act" data-act="prev" title="上一张"></i>
           <span class="ctp-count">${index + 1}/${data.images.length}</span>
           <i class="fa-solid fa-chevron-right ctp-act" data-act="next" title="下一张"></i>`
        : '';
    // The picture 🎲 / 🔄 / ✏️ act on: the one above the toolbar, or the only one left of a set whose end-of-floor
    // picture was deleted (it is an earlier part: the whole floor's buttons would draw the end again).
    const own = Number.isInteger(scene) ? scene : image?.promoted && !image?.scenes?.length ? -1 : null;
    const meta = debug
        ? `<span class="ctp-meta">${escapeHtml(data.target || '')} · seed ${escapeHtml(image.seed ?? '')} · ${image.width}×${image.height}</span>`
        : '';
    return `<div class="ctp-toolbar">
        ${nav}
        ${Number.isInteger(own) ? `<i class="fa-solid fa-dice ctp-act" data-act="picture-reroll" data-scene="${own}" title="只换种子重画上面这一张（其他几张不变）"></i>
        <i class="fa-solid fa-rotate ctp-act" data-act="picture-reparse" data-scene="${own}" title="只重新解析上面这一张（其他几张不变；全部重新解析点图上方的「全部重新解析」）"></i>
        <i class="fa-solid fa-pen-to-square ctp-act" data-act="picture-edit" data-scene="${own}" title="编辑上面这一张的提示词后只重画这一张"></i>` : `<i class="fa-solid fa-dice ctp-act" data-act="reroll" title="${image?.scenes?.length ? '全部换种子重画（每张图上的 🎲 只重画那一张）' : '同一提示词换种子重画'}"></i>
        <i class="fa-solid fa-rotate ctp-act" data-act="reparse" title="${image?.scenes?.length ? '全部重新解析：重新分段，几张图都重画（每张图上的 🔄 只重新解析那一张）' : '重新解析状态并生成'}"></i>
        <i class="fa-solid fa-pen-to-square ctp-act" data-act="edit" title="${image?.scenes?.length ? '编辑「结束时」这一张的提示词后重画（其他几张不变）' : '编辑提示词后生成'}"></i>`}
        <i class="fa-solid fa-comment-dots ctp-act" data-act="hint" title="加画图指令重画（不改正文）"></i>
        ${panelButton ? '<i class="fa-solid fa-table-columns ctp-act" data-act="panel" title="在侧边面板中显示这一楼的图"></i>' : ''}
        ${debug ? '<i class="fa-solid fa-bug ctp-act" data-act="debug" title="调试信息"></i>' : ''}
        ${Number.isInteger(scene)
        ? `<i class="fa-solid fa-trash-can ctp-act" data-act="picture-delete" data-scene="${scene}" title="只删除上面这一张（其他几张不变）"></i>`
        : `<i class="fa-solid fa-trash-can ctp-act" data-act="delete" title="${image?.scenes?.length ? `删除这一版的全部 ${image.scenes.length + 1} 张图（只删一张：点那张图上方的 🗑）` : '删除这张图'}"></i>`}
        ${meta}
    </div>`;
}
