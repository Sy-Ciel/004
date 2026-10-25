/**
 * 出图参数预设 in the settings panel (top of 出图参数): pick one to put it in place, save the current 出图参数 as a
 * new one or over the picked one, rename, delete, and bind the picked one to the open chat's character card.
 */
import { makeId } from './constants.js';
import { modeLabel } from './modes.js';
import { applyParams, bindCard, captureParams, cardPreset, currentCard, findParamPreset, paramPresets } from './paramPresets.js';
import { ctx, escapeHtml, getSettings, saveSettings } from './utils.js';

/** Shows the settings again after a preset was put in place (set by the settings UI). */
let afterApply = () => {};

function selected() {
    return findParamPreset(String($('#ctp_param_select').val() || ''));
}

export function refreshParamPresetUi() {
    const settings = getSettings();
    const presets = paramPresets();
    const current = findParamPreset(settings.paramPresetId);
    $('#ctp_param_select')
        .html([`<option value="">（不用预设 · ${escapeHtml(modeLabel())} 模式共 ${presets.length} 个）</option>`, ...presets.map(preset => `<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.name)}${preset.cards?.length ? `（绑定 ${preset.cards.length} 张角色卡）` : ''}</option>`)].join(''))
        .val(current?.id ?? '');
    const card = currentCard();
    const bound = cardPreset(card);
    $('#ctp_param_card').text(card ? `「${card.name}」` : '当前角色卡（还没打开聊天）');
    $('#ctp_param_bind')
        .prop('disabled', !card || !current)
        .prop('checked', !!current && bound === current);
    $('#ctp_param_bound').text(bound && bound !== current ? `（这张角色卡现在绑定的是「${bound.name}」）` : '');
    $('#ctp_param_save, #ctp_param_rename, #ctp_param_delete').toggleClass('disabled', !current);
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

function apply(preset, why = '') {
    const changed = applyParams(preset);
    saveSettings();
    afterApply();
    refreshParamPresetUi();
    if (changed) toastr.success(`已套用出图参数预设「${preset.name}」${why}`, 'ComfyUI 角色配图', { timeOut: 2500 });
    return changed;
}

/**
 * The open chat's card has a preset of the current mode bound to it: put it in place (after a chat, persona or
 * mode switch). Quiet when nothing changes.
 */
export function applyCardParamPreset() {
    const card = currentCard();
    const preset = cardPreset(card);
    if (preset) apply(preset, `（角色卡「${card.name}」绑定的）`);
    else refreshParamPresetUi();
}

/** @param {{ onApply: () => void }} options onApply: show the changed settings again */
export function initParamPresetUi({ onApply }) {
    afterApply = onApply;
    $('#ctp_param_select').on('change', function () {
        const preset = selected();
        if (preset) {
            apply(preset);
        } else {
            getSettings().paramPresetId = '';
            saveSettings();
            refreshParamPresetUi();
        }
    });
    $('#ctp_param_new').on('click', async () => {
        const card = currentCard();
        const name = await askName('把现在的出图参数（模型、风格 LoRA、更多 LoRA、采样、分辨率、放大、工作流、触发词）存成新预设，名字：', card ? `${card.name} 用` : '我的出图参数');
        if (!name) return;
        const preset = { id: makeId(), name, values: captureParams(), cards: [] };
        paramPresets().push(preset);
        getSettings().paramPresetId = preset.id;
        saveSettings();
        refreshParamPresetUi();
        toastr.success(`已存成出图参数预设「${name}」`);
    });
    $('#ctp_param_save').on('click', async () => {
        const preset = selected();
        if (!preset || !await confirm(`用现在的出图参数覆盖预设「${escapeHtml(preset.name)}」？`)) return;
        preset.values = captureParams();
        saveSettings();
        toastr.success(`已更新出图参数预设「${preset.name}」`);
    });
    $('#ctp_param_rename').on('click', async () => {
        const preset = selected();
        if (!preset) return;
        const name = await askName('新名字：', preset.name);
        if (!name) return;
        preset.name = name;
        saveSettings();
        refreshParamPresetUi();
    });
    $('#ctp_param_delete').on('click', async () => {
        const preset = selected();
        if (!preset || !await confirm(`删除出图参数预设「${escapeHtml(preset.name)}」？现在的出图参数不变，绑定它的角色卡不再自动套用。`)) return;
        const presets = paramPresets();
        presets.splice(presets.indexOf(preset), 1);
        getSettings().paramPresetId = '';
        saveSettings();
        refreshParamPresetUi();
    });
    $('#ctp_param_bind').on('change', function () {
        const preset = selected();
        const card = currentCard();
        if (!preset || !card) return;
        bindCard(preset, card, this.checked);
        saveSettings();
        refreshParamPresetUi();
        toastr.info(this.checked ? `打开「${card.name}」的聊天时会自动套用「${preset.name}」（${modeLabel()} 模式）` : `「${card.name}」不再自动套用出图参数预设`);
    });
    refreshParamPresetUi();
}
