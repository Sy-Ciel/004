/**
 * 设置预设 at the top of the settings panel: save all the settings as a named preset, put one back in place, save
 * over it, rename, delete, export and import (see snapshots.js for what a preset holds).
 */
import { modeLabel } from './modes.js';
import { applySnapshot, captureSettings, exportSnapshot, findSnapshot, importSnapshots, newSnapshot, snapshots } from './snapshots.js';
import { ctx, errorMessage, escapeHtml, getSettings, saveSettings } from './utils.js';

/** Stops what is running and shows the changed settings (set by the settings UI). */
let hooks = { beforeApply: () => {}, afterApply: () => {} };

function selected() {
    return findSnapshot(String($('#ctp_snap_select').val() || ''));
}

export function refreshSnapshotUi() {
    const settings = getSettings();
    const list = snapshots();
    const current = findSnapshot(settings.snapshotId);
    $('#ctp_snap_select')
        .html([`<option value="">设置预设（整套设置）· ${list.length ? `共 ${list.length} 个` : '还没有，点 ＋ 保存'}</option>`,
            ...list.map(item => `<option value="${escapeHtml(item.id)}">设置预设：${escapeHtml(item.name)}</option>`)].join(''))
        .val(current?.id ?? '');
    $('#ctp_snap_save, #ctp_snap_rename, #ctp_snap_delete').toggleClass('disabled', !current);
}

async function askName(text, value) {
    const { callGenericPopup, POPUP_TYPE } = ctx();
    const typed = await callGenericPopup(text, POPUP_TYPE.INPUT, value);
    return typeof typed === 'string' ? typed.trim() : '';
}

async function confirm(text) {
    const { callGenericPopup, POPUP_TYPE, POPUP_RESULT } = ctx();
    return await callGenericPopup(text, POPUP_TYPE.CONFIRM) === POPUP_RESULT.AFFIRMATIVE;
}

function download(name, json) {
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${name.replace(/[\\/:*?"<>|\s]+/g, '_') || 'settings'}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

/** @param {{ beforeApply: () => void, afterApply: () => void }} options */
export function initSnapshotUi(options) {
    hooks = options;
    $('#ctp_snap_select').on('change', async () => {
        const snapshot = selected();
        if (!snapshot) {
            // Back to "none": nothing changes, the settings just stop being tied to a preset.
            getSettings().snapshotId = '';
            saveSettings();
            refreshSnapshotUi();
            return;
        }
        if (!await confirm(`把全部设置换成设置预设「${escapeHtml(snapshot.name)}」？<br>现在的设置（三个模型模式的全部设置和 API 设置）会被它替换；没有存成预设的改动会丢失。正在进行的配图会取消。`)) {
            refreshSnapshotUi();
            return;
        }
        hooks.beforeApply();
        applySnapshot(snapshot);
        saveSettings();
        hooks.afterApply();
        refreshSnapshotUi();
        toastr.success(`已换成设置预设「${snapshot.name}」· ${modeLabel()} 模式`, 'ComfyUI 角色配图');
    });
    $('#ctp_snap_new').on('click', async () => {
        const name = await askName('把现在的全部设置存成新的设置预设，名字：', `我的设置 ${snapshots().length + 1}`);
        if (!name) return;
        const snapshot = newSnapshot(name);
        snapshots().push(snapshot);
        getSettings().snapshotId = snapshot.id;
        saveSettings();
        refreshSnapshotUi();
        toastr.success(`已存成设置预设「${name}」`);
    });
    $('#ctp_snap_save').on('click', async () => {
        const snapshot = selected();
        if (!snapshot || !await confirm(`用现在的全部设置覆盖设置预设「${escapeHtml(snapshot.name)}」？`)) return;
        snapshot.data = captureSettings();
        snapshot.time = Date.now();
        saveSettings();
        toastr.success(`已更新设置预设「${snapshot.name}」`);
    });
    $('#ctp_snap_rename').on('click', async () => {
        const snapshot = selected();
        if (!snapshot) return;
        const name = await askName('新名字：', snapshot.name);
        if (!name) return;
        snapshot.name = name;
        saveSettings();
        refreshSnapshotUi();
    });
    $('#ctp_snap_delete').on('click', async () => {
        const snapshot = selected();
        if (!snapshot || !await confirm(`删除设置预设「${escapeHtml(snapshot.name)}」？现在的设置不变。`)) return;
        const list = snapshots();
        list.splice(list.indexOf(snapshot), 1);
        getSettings().snapshotId = '';
        saveSettings();
        refreshSnapshotUi();
    });
    $('#ctp_snap_export').on('click', async () => {
        // Nothing picked: the settings as they are now.
        const snapshot = selected() ?? { name: '当前设置', time: Date.now(), data: captureSettings() };
        const withKeys = await confirm(`导出「${escapeHtml(snapshot.name)}」。文件里要带上 API Key 吗？<br>确定 = 带上（自己备份、换设备用）；取消 = 不带（发给别人用，对方导入后用自己的 Key）。`);
        download(`comfy_portrait_${snapshot.name}`, exportSnapshot(snapshot, withKeys));
    });
    $('#ctp_snap_import').on('click', () => $('#ctp_snap_file').trigger('click'));
    $('#ctp_snap_file').on('change', async function () {
        const file = this.files?.[0];
        this.value = '';
        if (!file) return;
        try {
            const imported = importSnapshots(JSON.parse(await file.text()));
            snapshots().push(...imported);
            saveSettings();
            refreshSnapshotUi();
            toastr.success(`已导入 ${imported.length} 个设置预设：${imported.map(item => item.name).join('、')}。在下拉框里选它才会套用`);
        } catch (error) {
            toastr.error(errorMessage(error), '导入失败');
        }
    });
    refreshSnapshotUi();
}
