import { placeAnchors, positionTop } from './anchors.js';
import { layoutMode } from './layout.js';
import { currentIndex, pictureHtml, statusHtml, toolbarHtml, versionPictures } from './markup.js';
import { storyParagraphs } from './parser.js';
import { getJob } from './pipeline.js';
import { ctx, escapeHtml, getMessageData, getSettings, saveSettings } from './utils.js';

/**
 * Floating image panel for the empty margin beside the chat column (desktop).
 * Drag the header to move it, drag the bottom-right corner to resize; size and position are remembered.
 */

const MARGIN = 12;
const MIN_WIDTH = 180;
/** Header + toolbar height, used when sizing the panel to an image. */
const CHROME = 76;

let panel = null;
let shownMesId = null;
let closed = false;
let maximized = false;
/** Set when a floor was chosen explicitly (new image, chip click); reading-position follow resumes on the next scroll. */
let sticky = false;
let lastHtml = '';
let lastApplied = null;
let refreshQueued = false;
let saveTimer = null;
/** Scrolls we cause ourselves (jump to floor) must not count as the user moving on. */
let ignoreScrollUntil = 0;
/** 多张图: the picture of the shown floor on screen (story order) and the floor it belongs to. */
let shownPage = 0;
let pagedMesId = null;
/** Set by ‹ › under the picture; paging by reading position resumes on the next scroll. */
let pageSticky = false;
/** Where the shown floor's parts are in its text (kept while its text nodes are there). */
let pageAnchors = null;

export function getPanelMesId() {
    return panel && !panel.hidden ? shownMesId : null;
}

function panelSettings() {
    const settings = getSettings();
    settings.panel ??= { follow: true, geometry: null };
    return settings.panel;
}

function floorsWithImages() {
    const floors = [];
    ctx().chat.forEach((message, index) => {
        if (getMessageData(message)?.images?.length) floors.push(index);
    });
    return floors;
}

function floorElement(mesId) {
    return document.querySelector(`#chat .mes[mesid="${mesId}"]`);
}

/** The image floor being read: the last one whose top is above the bottom of the visible chat. */
function floorAtReadingPosition(floors) {
    const chatBox = document.getElementById('chat')?.getBoundingClientRect();
    if (!chatBox) return floors[floors.length - 1];
    let best = null;
    for (const mesId of floors) {
        const element = floorElement(mesId);
        if (!element) continue;
        if (element.getBoundingClientRect().top < chatBox.bottom - 80) best = mesId;
        else break;
    }
    return best ?? floors.find(floorElement) ?? floors[floors.length - 1];
}

/**
 * 多张图: where on screen the panel turns from one picture of a floor to the next: where the parts begin, else
 * halfway between the paragraphs the pictures were placed after (图片插在正文中间), else the text split evenly.
 * Spots not found in the shown text fall back as in the message (see placeAnchors).
 */
function pageBoundaries(mesId, text, pictures, bounds) {
    const count = pictures.length;
    const key = JSON.stringify([mesId, bounds, pictures.map(picture => [picture.src, picture.start, picture.place, picture.startAt, picture.placeAt])]);
    const stale = pageAnchors?.positions?.some(position => !position.node.isConnected);
    if (pageAnchors?.key !== key || pageAnchors.text !== text || stale) {
        const starts = pictures.slice(1).some(picture => picture.start || Number.isFinite(picture.startAt));
        const places = !starts && pictures.some(picture => picture.place || Number.isFinite(picture.placeAt));
        const positions = places
            ? placeAnchors(text, pictures.map((picture, index) => ({ quote: picture.place, at: picture.placeAt, even: (index + 1) / count, side: 'after' })), bounds)
            : placeAnchors(text, pictures.slice(1).map((picture, index) => ({ quote: picture.start, at: picture.startAt, even: (index + 1) / count, side: 'before' })), bounds);
        pageAnchors = { key, text, kind: positions ? places ? 'places' : 'starts' : 'even', positions };
    }
    const { kind, positions } = pageAnchors;
    if (kind === 'starts') return positions.map(positionTop);
    if (kind === 'places') {
        const tops = positions.map(positionTop);
        return tops.slice(1).map((top, index) => (tops[index] + top) / 2);
    }
    const box = text.getBoundingClientRect();
    return pictures.slice(1).map((_, index) => box.top + box.height * (index + 1) / count);
}

/** 多张图: the picture whose part of the floor is at the middle of the visible chat (the floor's first one before it). */
function pageAtReadingPosition(mesId, pictures, bounds) {
    const text = floorElement(mesId)?.querySelector('.mes_text');
    const chatBox = document.getElementById('chat')?.getBoundingClientRect();
    if (!text || !chatBox) return 0;
    const line = chatBox.top + chatBox.height / 2;
    return pageBoundaries(mesId, text, pictures, bounds).filter(top => top < line).length;
}

/** Shows the current page of a floor with several pictures, its "2/3 · label", and points the toolbar at it. */
function applyPage(pictures) {
    panel.querySelectorAll('.ctp-panel-page').forEach((page, index) => page.classList.toggle('ctp-on', index === shownPage));
    const scene = pictures[shownPage]?.scene;
    if (scene !== undefined) {
        panel.querySelectorAll('.ctp-toolbar [data-act^="picture-"]').forEach(button => { button.dataset.scene = String(scene); });
    }
    const label = panel.querySelector('.ctp-panel-page-label');
    if (label) label.textContent = `${shownPage + 1}/${pictures.length}${pictures[shownPage]?.label ? ` · ${pictures[shownPage].label}` : ''}`;
}

/* ---------------- geometry ---------------- */

function clampGeometry({ left, top, width, height }) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.round(Math.min(Math.max(MIN_WIDTH, width), vw - 2 * MARGIN));
    const h = Math.round(Math.min(Math.max(120, height), vh - 2 * MARGIN));
    return {
        left: Math.round(Math.min(Math.max(0, left), vw - Math.min(w, 80))),
        top: Math.round(Math.min(Math.max(0, top), vh - 40)),
        width: w,
        height: h,
    };
}

/** Fits the panel into the empty margin on its side of the chat column, sized to the image. */
function autoGeometry(side, image) {
    const sheld = document.getElementById('sheld')?.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const top = (sheld?.top ?? 40) + MARGIN;
    const gutter = sheld ? (side === 'left' ? sheld.left : vw - sheld.right) : 0;
    const aspect = image?.width && image?.height ? image.height / image.width : 1.5;
    const maxHeight = vh - top - MARGIN;
    let width = Math.min(Math.max(MIN_WIDTH, gutter - 2 * MARGIN), 900);
    let height = width * aspect + CHROME;
    if (height > maxHeight) {
        height = maxHeight;
        width = Math.max(MIN_WIDTH, Math.min(width, (maxHeight - CHROME) / aspect));
    }
    const gutterStart = side === 'left' ? 0 : vw - gutter;
    const left = gutter >= width + 2 * MARGIN
        ? gutterStart + (gutter - width) / 2
        : (side === 'left' ? MARGIN : vw - width - MARGIN);
    return clampGeometry({ left, top, width, height });
}

function maximizedGeometry() {
    const top = (document.getElementById('sheld')?.getBoundingClientRect().top ?? 40) + MARGIN;
    return clampGeometry({ left: window.innerWidth * 0.05, top, width: window.innerWidth * 0.9, height: window.innerHeight - top - MARGIN });
}

function applyGeometry(geometry) {
    const g = clampGeometry(geometry);
    Object.assign(panel.style, { left: `${g.left}px`, top: `${g.top}px`, width: `${g.width}px`, height: `${g.height}px` });
    lastApplied = g;
}

function targetGeometry(side, image) {
    if (maximized) return maximizedGeometry();
    return panelSettings().geometry ?? autoGeometry(side, image);
}

function saveGeometry() {
    const box = panel.getBoundingClientRect();
    panelSettings().geometry = clampGeometry({ left: box.left, top: box.top, width: box.width, height: box.height });
    saveSettings();
}

/* ---------------- DOM ---------------- */

function onPointerDown(event) {
    const header = event.target.closest('.ctp-panel-header');
    if (!header || event.button !== 0 || event.target.closest('[data-panel-act], .ctp-act')) return;
    event.preventDefault();
    if (maximized) {
        maximized = false;
        lastHtml = '';
    }
    const start = panel.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    panel.classList.add('ctp-panel-dragging');
    const move = moveEvent => applyGeometry({
        left: start.left + moveEvent.clientX - startX,
        top: start.top + moveEvent.clientY - startY,
        width: start.width,
        height: start.height,
    });
    const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        panel.classList.remove('ctp-panel-dragging');
        saveGeometry();
        schedulePanelRefresh();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
}

function onPanelAction(event) {
    const button = event.target.closest('[data-panel-act]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    // 多张图: ‹ › turn the page by hand; it stays until the chat is scrolled.
    if (button.dataset.panelAct === 'page-prev' || button.dataset.panelAct === 'page-next') {
        shownPage += button.dataset.panelAct === 'page-next' ? 1 : -1;
        pageSticky = true;
        schedulePanelRefresh();
        return;
    }
    switch (button.dataset.panelAct) {
        case 'close':
            closed = true;
            break;
        case 'maximize':
            maximized = !maximized;
            break;
        case 'fit':
            maximized = false;
            panelSettings().geometry = null;
            saveSettings();
            break;
        case 'follow': {
            const settings = panelSettings();
            settings.follow = !settings.follow;
            sticky = false;
            saveSettings();
            toastr.info(settings.follow ? '面板会跟随聊天滚动，显示正在看的楼层的图' : '面板固定显示当前这张图');
            break;
        }
        case 'jump':
            ignoreScrollUntil = Date.now() + 1500;
            floorElement(shownMesId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            sticky = true;
            break;
    }
    lastHtml = '';
    schedulePanelRefresh();
}

function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'ctp_panel';
    panel.className = 'ctp-panel';
    panel.hidden = true;
    document.body.appendChild(panel);
    panel.addEventListener('pointerdown', onPointerDown);
    panel.addEventListener('click', onPanelAction);

    // The bottom-right corner uses native CSS resizing; remember sizes the user sets.
    new ResizeObserver(() => {
        if (panel.hidden || maximized || !lastApplied) return;
        const box = panel.getBoundingClientRect();
        if (Math.abs(box.width - lastApplied.width) < 2 && Math.abs(box.height - lastApplied.height) < 2) return;
        lastApplied = { ...lastApplied, width: box.width, height: box.height };
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveGeometry, 300);
    }).observe(panel);

    document.getElementById('chat')?.addEventListener('scroll', () => {
        if (Date.now() < ignoreScrollUntil) return;
        if (sticky) sticky = false;
        pageSticky = false;
        if (panelSettings().follow) schedulePanelRefresh();
    }, { passive: true });
    window.addEventListener('resize', () => schedulePanelRefresh());
    // The chat-width slider changes the margins without resizing the window.
    const sheld = document.getElementById('sheld');
    if (sheld) new ResizeObserver(() => schedulePanelRefresh()).observe(sheld);
    return panel;
}

function panelHtml(mesId, data, job) {
    const settings = getSettings();
    const image = data.images[currentIndex(data)];
    // 多张图: one picture per page; the toolbar under it acts on the page shown (see applyPage).
    const pictures = versionPictures(image);
    const follow = panelSettings().follow;
    const name = data.target || ctx().chat[mesId]?.name || '';
    return `<div class="ctp-panel-header" title="拖动标题栏移动，拖右下角调整大小">
        <span class="ctp-panel-title">#${mesId}${name ? ` · ${escapeHtml(name)}` : ''}</span>
        <span class="ctp-panel-spacer"></span>
        <i class="fa-solid fa-location-crosshairs ctp-panel-btn ${follow ? 'ctp-on' : ''}" data-panel-act="follow" title="跟随阅读位置：${follow ? '开' : '关'}（滚动聊天时显示正在看的楼层的图；一楼有几张图时，翻到正在看的那一段）"></i>
        <i class="fa-solid fa-arrows-to-dot ctp-panel-btn" data-panel-act="jump" title="跳到这一楼"></i>
        <i class="fa-solid fa-table-columns ctp-panel-btn" data-panel-act="fit" title="重置位置和大小（贴合侧边空白）"></i>
        <i class="fa-solid ${maximized ? 'fa-down-left-and-up-right-to-center' : 'fa-up-right-and-down-left-from-center'} ctp-panel-btn" data-panel-act="maximize" title="${maximized ? '还原' : '放大'}"></i>
        <i class="fa-solid fa-xmark ctp-panel-btn" data-panel-act="close" title="关闭（有新图或点聊天里的配图条时会重新打开）"></i>
    </div>
    ${job ? statusHtml(job) : ''}
    ${picturesHtml(pictures)}
    ${toolbarHtml(data, settings.debug, { scene: pictures.length > 1 ? pictures[0].scene : null })}`;
}

/** The picture, or with 多张图 one page per picture (the shown one is picked by applyPage) and ‹ › under them. */
function picturesHtml(pictures) {
    if (pictures.length < 2) return `<div class="ctp-panel-body">${pictureHtml(pictures[0], false, { imgClass: 'ctp-panel-img' })}</div>`;
    return `<div class="ctp-panel-body ctp-panel-paged">
        ${pictures.map((picture, index) => `<div class="ctp-panel-page" data-page="${index}">${pictureHtml(picture, true, { imgClass: 'ctp-panel-img', tools: 'link' })}</div>`).join('')}
    </div>
    <div class="ctp-panel-pager">
        <i class="fa-solid fa-chevron-left ctp-panel-btn" data-panel-act="page-prev" title="这一楼的上一张"></i>
        <span class="ctp-panel-page-label"></span>
        <i class="fa-solid fa-chevron-right ctp-panel-btn" data-panel-act="page-next" title="这一楼的下一张"></i>
    </div>`;
}

function markActiveChip() {
    document.querySelectorAll('#chat .ctp-chip').forEach(chip => {
        chip.classList.toggle('ctp-chip-active', Number(chip.closest('.mes')?.getAttribute('mesid')) === getPanelMesId());
    });
}

function hidePanel() {
    if (panel && !panel.hidden) {
        panel.hidden = true;
        markActiveChip();
    }
}

/** Re-evaluates what the panel shows. Cheap; call it after any chat render, scroll or setting change. */
export function refreshPanel() {
    const mode = layoutMode();
    if (mode.kind !== 'panel') return hidePanel();
    const floors = floorsWithImages();
    if (!floors.length || closed) return hidePanel();

    ensurePanel();
    if (!floors.includes(shownMesId)) sticky = false;
    if (!sticky || !floors.includes(shownMesId)) {
        shownMesId = panelSettings().follow || !floors.includes(shownMesId)
            ? floorAtReadingPosition(floors)
            : shownMesId;
    }

    const message = ctx().chat[shownMesId];
    const data = getMessageData(message);
    const job = getJob(message);
    const showJob = job && job.swipeId === (message?.swipe_id ?? 0) ? job : null;
    // 多张图: turn to the part being read, like the panel moves on to the floor being read.
    const shownImage = data.images[currentIndex(data)];
    const pictures = versionPictures(shownImage);
    if (pagedMesId !== shownMesId) {
        pagedMesId = shownMesId;
        pageSticky = false;
        shownPage = 0;
    }
    if (pictures.length > 1 && panelSettings().follow && !pageSticky) {
        shownPage = pageAtReadingPosition(shownMesId, pictures, {
            first: shownImage.storyStart ?? data.storyStart,
            last: shownImage.storyEnd ?? data.storyEnd,
            ending: shownImage.storyEnding ?? data.storyEnding,
            paragraphs: storyParagraphs(ctx().chat[shownMesId]),
        });
    }
    shownPage = Math.min(Math.max(0, shownPage), pictures.length - 1);
    const html = panelHtml(shownMesId, data, showJob);
    panel.dataset.mesid = String(shownMesId);
    panel.classList.toggle('ctp-panel-max', maximized);
    if (html !== lastHtml) {
        panel.innerHTML = html;
        lastHtml = html;
    }
    applyPage(pictures);
    applyGeometry(targetGeometry(mode.side, data.images[currentIndex(data)]));
    panel.hidden = false;
    markActiveChip();
}

export function schedulePanelRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => {
        refreshQueued = false;
        refreshPanel();
    });
}

/** Shows a floor in the panel (chip click, new image), reopening it if it was closed. */
export function showInPanel(mesId) {
    closed = false;
    sticky = true;
    shownMesId = mesId;
    lastHtml = '';
    schedulePanelRefresh();
}

export function resetPanelForChat() {
    shownMesId = null;
    sticky = false;
    closed = false;
    lastHtml = '';
    schedulePanelRefresh();
}

export function resetPanelGeometry() {
    maximized = false;
    panelSettings().geometry = null;
    lastHtml = '';
    schedulePanelRefresh();
}

/**
 * Before the image model mode or the profile switches: a pending save of the panel's size must not land in the
 * settings being swapped in (a mode switch keeps the geometry, a persona switch brings that persona's), and the
 * geometry in place afterwards is applied fresh.
 */
export function resetPanelForMode() {
    clearTimeout(saveTimer);
    saveTimer = null;
    maximized = false;
    lastApplied = null;
    lastHtml = '';
    schedulePanelRefresh();
}
