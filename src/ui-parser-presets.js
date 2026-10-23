import { isComicPreset } from './comic.js';
import { makeId } from './constants.js';
import { readInput, writeInput } from './form.js';
import { activeParserPreset, builtinParserPreset } from './parserPresets.js';
import { ctx, escapeHtml, getSettings, saveSettings } from './utils.js';

const DESCRIPTIONS = {
    story: '剧情状态：服装、动作、表情、场景、镜头都由 AI 按剧情推断。',
    sprite: '立绘：姿势、镜头、背景、光线固定（见下方「固定内容」），只随剧情换服装、表情、神态。适合竖图。',
    novel: '小说插画：挑当前楼层最有画面感的瞬间，电影感构图和有氛围的光线，环境更丰富。适合横图。想让同一幕的其他人也入镜，勾选下面的「允许画面里出现其他人物」。',
    comic: '漫画（MOSS-Image）：把这一楼画成一页彩色漫画，按时间顺序分成几格，人物的对白写进对话框。想要水粉漫画画风，在「出图参数」点「改用 FKEY 漫画画风 LoRA」（要先下载这个 LoRA）。',
};

function optionLabel(preset) {
    return `${preset.name}${builtinParserPreset(preset.id) ? '' : '（自定义）'}`;
}

const FIELD_NAMES = { system: 'System 提示词', user: 'User 模板' };

/**
 * Built-in presets: whether the System prompt and the User template are still the built-in text ("内置默认") or
 * edited ("已修改"), each with its own reset link. Custom presets have no built-in text to compare with.
 */
function updateFieldStates() {
    const active = activeParserPreset();
    const builtin = builtinParserPreset(active.id);
    for (const field of Object.keys(FIELD_NAMES)) {
        const edited = !!builtin && String(active[field] ?? '') !== builtin[field];
        $(`#ctp_pp_editor [data-pp-state="${field}"]`)
            .toggle(!!builtin)
            .text(edited ? '（已修改）' : '（内置默认）')
            .toggleClass('ctp-warn', edited);
        $(`#ctp_pp_editor [data-pp-reset="${field}"]`).toggle(edited);
    }
}

/** Re-reads the selected parser preset into the editor. */
export function refreshParserPresetUi() {
    const settings = getSettings();
    const active = activeParserPreset();
    $('#ctp_pp_select')
        .html(settings.parserPresets.map(preset => `<option value="${escapeHtml(preset.id)}">${escapeHtml(optionLabel(preset))}</option>`).join(''))
        .val(active.id);
    document.querySelectorAll('#ctp_pp_editor [data-pp]').forEach(element => {
        writeInput(element, active[element.dataset.pp]);
    });
    const builtin = !!builtinParserPreset(active.id);
    $('#ctp_pp_delete').toggle(!builtin);
    $('#ctp_pp_reset').toggle(builtin);
    $('#ctp_pp_desc').text(DESCRIPTIONS[active.id] ?? (isComicPreset(active) ? '自定义漫画预设：可以改下方所有内容。' : '自定义预设：可以改下方所有内容。'));
    // 漫画模式 has panels and dialogue instead of fixed fields and the other-people switch.
    const comic = isComicPreset(active);
    $('#ctp_pp_comic').toggle(comic);
    $('#ctp_pp_editor .ctp-pp-picture').toggle(!comic);
    updateFieldStates();
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
        element.addEventListener(element.type === 'checkbox' ? 'change' : 'input', () => {
            const preset = activeParserPreset();
            const key = element.dataset.pp;
            preset[key] = readInput(element);
            saveSettings();
            if (key === 'name') $('#ctp_pp_select option:selected').text(optionLabel(preset));
            if (Object.hasOwn(FIELD_NAMES, key)) updateFieldStates();
        });
    });

    // One part of a built-in preset back to its built-in text; the rest of the preset stays as it is.
    document.querySelectorAll('#ctp_pp_editor [data-pp-reset]').forEach(link => {
        link.addEventListener('click', async event => {
            event.preventDefault();
            const preset = activeParserPreset();
            const builtin = builtinParserPreset(preset.id);
            const field = link.dataset.ppReset;
            if (!builtin || !Object.hasOwn(FIELD_NAMES, field)) return;
            if (!await confirm(`把「${escapeHtml(builtin.name)}」的 ${FIELD_NAMES[field]}恢复成内置的默认内容？你对这一段的修改会丢失，其他内容不变。`)) return;
            // The popup can stay open while the preset or the mode changes: only reset the one it was opened for.
            if (activeParserPreset() !== preset) return;
            preset[field] = builtin[field];
            saveSettings();
            writeInput(document.querySelector(`#ctp_pp_editor [data-pp="${field}"]`), preset[field]);
            updateFieldStates();
            toastr.success(`${FIELD_NAMES[field]}已恢复默认`);
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
