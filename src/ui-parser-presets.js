import { makeId } from './constants.js';
import { activeParserPreset, builtinParserPreset } from './parserPresets.js';
import { ctx, escapeHtml, getSettings, saveSettings } from './utils.js';

const DESCRIPTIONS = {
    story: '剧情状态：服装、动作、表情、场景、镜头都由 AI 按剧情推断。',
    sprite: '立绘：姿势、镜头、背景、光线固定（见下方「固定内容」），只随剧情换服装、表情、神态。适合竖图。',
    novel: '小说插画：挑当前楼层最有画面感的瞬间，电影感构图和有氛围的光线，环境更丰富。适合横图。',
};

function optionLabel(preset) {
    return `${preset.name}${builtinParserPreset(preset.id) ? '' : '（自定义）'}`;
}

/** Re-reads the selected parser preset into the editor. */
export function refreshParserPresetUi() {
    const settings = getSettings();
    const active = activeParserPreset();
    $('#ctp_pp_select')
        .html(settings.parserPresets.map(preset => `<option value="${escapeHtml(preset.id)}">${escapeHtml(optionLabel(preset))}</option>`).join(''))
        .val(active.id);
    document.querySelectorAll('#ctp_pp_editor [data-pp]').forEach(element => {
        element.value = active[element.dataset.pp] ?? '';
    });
    const builtin = !!builtinParserPreset(active.id);
    $('#ctp_pp_delete').toggle(!builtin);
    $('#ctp_pp_reset').toggle(builtin);
    $('#ctp_pp_desc').text(DESCRIPTIONS[active.id] ?? '自定义预设：可以改下方所有内容。');
}

async function confirm(text) {
    const { callGenericPopup, POPUP_TYPE, POPUP_RESULT } = ctx();
    return await callGenericPopup(text, POPUP_TYPE.CONFIRM) === POPUP_RESULT.AFFIRMATIVE;
}

export function initParserPresetUi() {
    $('#ctp_pp_select').on('change', function () {
        getSettings().parserPresetId = String(this.value);
        saveSettings();
        refreshParserPresetUi();
    });

    document.querySelectorAll('#ctp_pp_editor [data-pp]').forEach(element => {
        element.addEventListener('input', () => {
            const preset = activeParserPreset();
            const key = element.dataset.pp;
            preset[key] = element.dataset.type === 'int' ? (parseInt(element.value, 10) || 0) : element.value;
            saveSettings();
            if (key === 'name') $('#ctp_pp_select option:selected').text(optionLabel(preset));
        });
    });

    $('#ctp_pp_clone').on('click', () => {
        const source = activeParserPreset();
        const copy = { ...structuredClone(source), id: makeId(), name: `${source.name} 副本` };
        const settings = getSettings();
        settings.parserPresets.push(copy);
        settings.parserPresetId = copy.id;
        saveSettings();
        refreshParserPresetUi();
        toastr.success('已复制为新预设，可以在下面修改');
    });

    $('#ctp_pp_delete').on('click', async () => {
        const preset = activeParserPreset();
        if (builtinParserPreset(preset.id)) return;
        if (!await confirm(`删除解析预设「${escapeHtml(preset.name)}」？`)) return;
        const settings = getSettings();
        settings.parserPresets = settings.parserPresets.filter(item => item.id !== preset.id);
        settings.parserPresetId = 'story';
        saveSettings();
        refreshParserPresetUi();
    });

    $('#ctp_pp_reset').on('click', async () => {
        const preset = activeParserPreset();
        const builtin = builtinParserPreset(preset.id);
        if (!builtin) return;
        if (!await confirm(`把「${escapeHtml(builtin.name)}」恢复成内置的默认内容？你对它的修改会丢失。`)) return;
        Object.assign(preset, structuredClone(builtin));
        saveSettings();
        refreshParserPresetUi();
        toastr.success('已恢复默认');
    });

    refreshParserPresetUi();
}
