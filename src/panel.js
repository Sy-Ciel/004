import { layoutMode } from './layout.js';
import { currentIndex, statusHtml, toolbarHtml } from './markup.js';
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
    const follow = panelSettings().follow;
    const name = data.target || ctx().chat[mesId]?.name || '';
    return `<div class="ctp-panel-header" title="拖动标题栏移动，拖右下角调整大小">
        <span class="ctp-panel-title">#${mesId}${name ? ` · ${escapeHtml(name)}` : ''}</span>
        <span class="ctp-panel-spacer"></span>
        <i class="fa-solid fa-location-crosshairs ctp-panel-btn ${follow ? 'ctp-on' : ''}" data-panel-act="follow" title="跟随阅读位置：${follow ? '开' : '关'}（滚动聊天时显示正在看的楼层的图）"></i>
        <i class="fa-solid fa-arrows-to-dot ctp-panel-btn" data-panel-act="jump" title="跳到这一楼"></i>
        <i class="fa-solid fa-table-columns ctp-panel-btn" data-panel-act="fit" title="重置位置和大小（贴合侧边空白）"></i>
        <i class="fa-solid ${maximized ? 'fa-down-left-and-up-right-to-center' : 'fa-up-right-and-down-left-from-center'} ctp-panel-btn" data-panel-act="maximize" title="${maximized ? '还原' : '放大'}"></i>
        <i class="fa-solid fa-xmark ctp-panel-btn" data-panel-act="close" title="关闭（有新图或点聊天里的配图条时会重新打开）"></i>
    </div>
    ${job ? statusHtml(job) : ''}
    <div class="ctp-panel-body">
        <img class="ctp-panel-img ctp-act" data-act="zoom" src="${escapeHtml(image.src)}" alt="" title="点击查看原图">
    </div>
    ${toolbarHtml(data, settings.debug)}`;
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
    const html = panelHtml(shownMesId, data, showJob);
    panel.dataset.mesid = String(shownMesId);
    panel.classList.toggle('ctp-panel-max', maximized);
    if (html !== lastHtml) {
        panel.innerHTML = html;
        lastHtml = html;
    }
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
