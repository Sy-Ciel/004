import { builtinWorkflowName, fetchModelLists, loadBuiltinWorkflow, parseWorkflow, prepareWorkflow, testConnection } from './comfy.js';
import {
    ANIMA_NEGATIVE,
    ANIMA_TURBO,
    EXTRA_KEY,
    MODEL_ANIMA,
    MODEL_KREA2,
    MODEL_MODES,
    MODEL_MOSS,
    MOSS_NEGATIVE,
    MOSS_QUALITY,
    OFFICIAL_ANIMA,
    OFFICIAL_KREA2_TURBO,
    OFFICIAL_MOSS,
    TARGET_AUTO,
    TARGET_CHAR,
    TARGET_USER,
    makeId,
    modeDefaults,
    normalizeMode,
    resolutionPresets,
} from './constants.js';
import { lastFloorId, showChatDebug, showDryRun, showParserPreview } from './debug.js';
import { DISPLAY_KEYS, SHARED_COMFY_KEYS, SHARED_PARSER_KEYS, currentMode, modeLabel, adoptProfile, hasProfile, otherSlotKey, personaMode, releaseProfile, swapModeSettings, swapProfile } from './modes.js';
import { resetPanelForMode, resetPanelGeometry } from './panel.js';
import { bindPickers, getPath, readInput, registerPickerOwner, renderPicker, renderPickers, setPath, writeInput } from './form.js';
import { initParserPresetUi, refreshParserPresetUi } from './ui-parser-presets.js';
import { initRenderProfileUi, refreshRenderProfileUi, refreshRenderProfileUsage, resetRenderProfileSelection } from './ui-render-profiles.js';
import { renderProfileFor, sanitizeRenderProfile } from './renderProfiles.js';
import { buildStatusInstruction, updateStatusPrompt } from './statusBar.js';
import { updateRatingPrompt } from './rating.js';
import { callParser, parseExtraBody } from './parser.js';
import { cancelAllJobs, enqueue, hasActiveJobs, planLoraLines, renderPlan } from './pipeline.js';
import { renderAll } from './render.js';
import { baseSize } from './resolution.js';
import { describeThinking, formatHasEffort, thinkingFormat } from './thinking.js';
import { currentPersona, findPresetById, findUserPreset, personaList, presetForName, presetName, resolveUserPreset } from './targets.js';
import { ctx, errorMessage, escapeHtml, getSettings, roundTo16, saveSettings, truncate } from './utils.js';

const SETTINGS_URL = new URL('../settings.html', import.meta.url);
const UI_WORKFLOW_URL = new URL('../workflows/krea2_turbo_t2i_lora_ui.json', import.meta.url);

/** Texts of the settings panel that depend on the image model mode. */
const MODE_TEXT = {
    [MODEL_KREA2]: {
        megapixels: 'Krea 2 Turbo 适合约 1–2 MP',
        maxMegapixels: 4.2,
        official: '恢复为官方 Krea 2 Turbo 模板的设置',
        negativePlaceholder: '内置 Krea 2 Turbo 工作流用 CFG 1，不使用反向提示词',
        negativeHint: '',
        triggerPlaceholder: '例：风格 LoRA 的触发词（留空 = 不加）',
    },
    [MODEL_ANIMA]: {
        megapixels: 'Anima 按约 1 MP 训练，太大容易重复人物、多出肢体',
        maxMegapixels: 1.6,
        official: '恢复为官方 Anima 模板的设置',
        negativePlaceholder: ANIMA_NEGATIVE,
        negativeHint: 'Anima 用真正的反向提示词（CFG 4）；默认是官方模板的那一段。用 Turbo LoRA（CFG 1）时反向提示词基本不起作用。',
        triggerPlaceholder: '例：LoRA 触发词、@画师名（留空 = 不加）',
    },
    [MODEL_MOSS]: {
        megapixels: 'MOSS-Image 推荐约 1、1.5 或 2 MP（最大约 4 MP）',
        maxMegapixels: 2.2,
        official: '恢复为官方 MOSS-Image 模板的设置',
        negativePlaceholder: MOSS_NEGATIVE,
        negativeHint: 'MOSS-Image 用真正的反向提示词（CFG 2.5）；默认是官方模板推荐的那一段。它以 nsfw 开头，会让模型避开成人内容，要画这类画面就把 nsfw 删掉。',
        triggerPlaceholder: '例：LoRA 触发词（留空 = 不加）',
    },
};

function modeText() {
    return MODE_TEXT[currentMode()];
}

let selectedPresetId = null;

function listsSummary() {
    const lists = getSettings().comfy.lists || {};
    const count = key => (lists[key]?.length ? lists[key].length : '—');
    return `已缓存列表：扩散模型 ${count('unet')} · 文本编码器 ${count('clip')} · VAE ${count('vae')} · LoRA ${count('lora')} · 采样器 ${count('sampler')}`;
}

/** Fixed width × height, or the resolution selector (aspect ratio × pixel count). */
function updateSizeVisibility() {
    const selector = getSettings().comfy.sizeMode === 'selector';
    $('#ctp_size_fixed').toggle(!selector);
    $('#ctp_size_selector').toggle(selector);
}

function updateMegapixels() {
    const { comfy } = getSettings();
    const { width, height } = baseSize(comfy);
    const mp = (Number(width) * Number(height)) / 1e6;
    const element = $('#ctp_mp');
    const text = modeText();
    const selector = comfy.sizeMode === 'selector' ? `宽高比 ${baseSize(comfy).aspect} → ` : '';
    const base = `${selector}${width}×${height} ≈ ${mp.toFixed(2)} MP。会自动对齐到 16 的倍数，${text.megapixels}。`;
    const tooBig = mp > text.maxMegapixels;
    element.text(tooBig ? `${base} 当前远超推荐范围，容易出现重复人物、多余肢体，也更慢。` : base);
    element.toggleClass('ctp-warn', tooBig);
}

/** What the thinking settings will send, and whether the effort applies. */
function updateThinkingHint() {
    const { parser } = getSettings();
    const format = thinkingFormat(parser);
    const effortUsed = parser.thinking === 'on' && (parser.source !== 'custom' || formatHasEffort(format)) && parser.source !== 'main';
    $('#ctp_thinking_effort').prop('disabled', !effortUsed);
    const text = parser.thinking === 'default'
        ? '默认：不发送任何思考参数，模型按它自己的默认方式思考或不思考。'
        : `${describeThinking(parser)}${parser.source === 'custom' && !formatHasEffort(format) && parser.thinking === 'on' ? '。这种格式只有开 / 关，没有强度' : ''}`;
    $('#ctp_thinking_hint').text(`${text} 开启思考会更慢，也更占「最大输出」；「附加请求参数」里自己写的同名参数优先。`);
}

function validateExtraBody() {
    const hint = $('#ctp_extra_body_hint');
    try {
        parseExtraBody();
        hint.removeClass('ctp-warn').text('会合并进请求体。思考模型（GLM、DeepSeek-R1 等）容易把输出额度用在思考上导致返回空内容，可以在这里关闭思考。');
    } catch (error) {
        hint.addClass('ctp-warn').text(error.message);
    }
}

function onSettingChanged(path) {
    if (['debug', 'imagePosition', 'imagePositionNarrow', 'sideWidth', 'sideTextWrap', 'imageMaxWidth', 'placeInStory', 'panelAlsoInMessage'].includes(path)) renderAll();
    if (path === 'imagePosition') {
        updateSideOptionsVisibility();
        // A remembered panel position belongs to the old side.
        resetPanelGeometry();
    }
    if (path === 'parser.source') updateSourceVisibility();
    if (path.startsWith('parser.')) updateThinkingHint();
    if (path === 'perPersonaProfiles') {
        // Turning profiles on makes the current settings this persona's; off keeps them for everyone.
        if (getSettings().perPersonaProfiles) {
            if (currentPersona()) adoptProfile(currentPersona());
        } else {
            releaseProfile();
        }
        saveSettings();
        updateProfileLabel();
    }
    if (path === 'parser.extraBody') validateExtraBody();
    if (path === 'comfy.workflowSource') updateWorkflowVisibility();
    if (path === 'enabled' || path === 'autoModelByRating') updateRatingPrompt();
    if (path === 'enabled' || path.startsWith('statusBar.')) {
        updateStatusPrompt();
        updateStatusVisibility();
    }
    if (path === 'statusBar.label') renderAll();
    if (path === 'comfy.width' || path === 'comfy.height') {
        syncResolutionSelect();
        updateMegapixels();
    }
    if (['comfy.sizeMode', 'comfy.aspectRatio', 'comfy.megapixels'].includes(path)) {
        updateSizeVisibility();
        updateMegapixels();
    }
}

function bindSettings(root) {
    const settings = getSettings();
    root.querySelectorAll('[data-ctp]').forEach(element => {
        const path = element.dataset.ctp;
        writeInput(element, getPath(settings, path));
        const handler = () => {
            setPath(getSettings(), path, readInput(element));
            saveSettings();
            onSettingChanged(path);
        };
        element.addEventListener(element.tagName === 'SELECT' || element.type === 'checkbox' ? 'change' : 'input', handler);
    });

    root.querySelectorAll('[data-reset]').forEach(link => {
        link.addEventListener('click', event => {
            event.preventDefault();
            const path = link.dataset.reset;
            setPath(getSettings(), path, structuredClone(getPath(modeDefaults(currentMode()), path)));
            saveSettings();
            const input = root.querySelector(`[data-ctp="${path}"]`);
            if (input) writeInput(input, getPath(getSettings(), path));
            onSettingChanged(path);
            toastr.success('已恢复默认');
        });
    });

    for (const id of ['ctp_width', 'ctp_height']) {
        const input = document.getElementById(id);
        input.addEventListener('change', () => {
            const key = id === 'ctp_width' ? 'width' : 'height';
            const rounded = roundTo16(input.value, modeDefaults(currentMode()).comfy[key]);
            if (String(rounded) !== input.value) {
                input.value = String(rounded);
                toastr.info(`已对齐到 16 的倍数：${rounded}`);
            }
            getSettings().comfy[key] = rounded;
            saveSettings();
            syncResolutionSelect();
            updateMegapixels();
        });
    }
}

function updateStatusVisibility() {
    $('#ctp_status_name').toggle(getSettings().statusBar.target === 'custom');
}

async function previewStatusInstruction() {
    const { callGenericPopup, POPUP_TYPE } = ctx();
    const text = ctx().substituteParams?.(buildStatusInstruction()) ?? buildStatusInstruction();
    const enabled = getSettings().statusBar.enabled ? '' : '<p class="ctp-muted">（状态栏现在是关闭的，打开后才会发给正文 AI）</p>';
    await callGenericPopup(`<h3>发给正文 AI 的状态栏说明</h3>${enabled}<pre class="ctp-pre">${escapeHtml(text)}</pre>`, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true, okButton: '关闭' });
}

function updateSourceVisibility() {
    const source = getSettings().parser.source;
    $('.ctp-settings .ctp-source').each(function () {
        $(this).toggle(this.dataset.source === source);
    });
    if (source === 'profile') refreshProfiles();
}

function updateSideOptionsVisibility() {
    const position = getSettings().imagePosition;
    $('#ctp_panel_options').toggle(position === 'left' || position === 'right');
    $('#ctp_side_options').toggle(position === 'inline-left' || position === 'inline-right');
    $('#ctp_narrow_options').toggle(!['above', 'below'].includes(position));
}

function updateWorkflowVisibility() {
    $('#ctp_workflow_custom').toggle(getSettings().comfy.workflowSource === 'custom');
}

/* ---------------- resolution ---------------- */

function syncResolutionSelect() {
    const { width, height } = getSettings().comfy;
    const match = resolutionPresets(currentMode()).findIndex(preset => preset.w === Number(width) && preset.h === Number(height));
    $('#ctp_resolution').val(match >= 0 ? String(match) : 'custom');
}

/** The size list of the active mode (Anima's are all about 1 MP). */
function renderResolutionOptions() {
    $('#ctp_resolution').html([
        '<option value="custom">自定义</option>',
        ...resolutionPresets(currentMode()).map((preset, index) => `<option value="${index}">${preset.label}</option>`),
    ].join(''));
    syncResolutionSelect();
}

function initResolution() {
    const select = $('#ctp_resolution');
    renderResolutionOptions();
    select.on('change', () => {
        const preset = resolutionPresets(currentMode())[Number(select.val())];
        if (!preset) return;
        getSettings().comfy.width = preset.w;
        getSettings().comfy.height = preset.h;
        $('#ctp_width').val(preset.w);
        $('#ctp_height').val(preset.h);
        saveSettings();
        updateMegapixels();
    });
}

/* ---------------- target & presets ---------------- */

function personaName(id) {
    return personaList().find(persona => persona.id === id)?.name ?? id;
}

function presetLabel(preset) {
    const resolved = presetName(preset);
    const base = resolved && resolved !== preset.name ? `${preset.name} → ${resolved}` : (preset.name || '（未命名）');
    const fallback = preset.id === getSettings().userFallbackPresetId ? '［{{user}} 没有同名预设时用］' : '';
    return base + fallback;
}

/** How a preset is named in messages: macro names like {{user}} are shown as written, not resolved. */
function displayName(preset) {
    const raw = String(preset?.name || '');
    return `预设「${raw.includes('{{') ? raw : (presetName(preset) || raw)}」`;
}

/** Name shown for the preset {{user}} currently resolves to. */
function userPresetName() {
    const { preset, via } = resolveUserPreset();
    if (!preset) return '无预设，默认模型和 LoRA';
    return via === 'fallback' ? `${displayName(preset)}（默认）` : displayName(preset);
}

export function refreshTargetSelect() {
    const settings = getSettings();
    const options = [
        `<option value="${TARGET_USER}">{{user}}（${escapeHtml(ctx().name1 || '用户')} → ${escapeHtml(userPresetName())}）</option>`,
        `<option value="${TARGET_CHAR}">{{char}}（当前发言角色）</option>`,
        `<option value="${TARGET_AUTO}">自动判断（解析模型挑选）</option>`,
        ...settings.presets.map(preset => `<option value="${escapeHtml(preset.id)}">预设：${escapeHtml(presetLabel(preset))}</option>`),
    ];
    const select = $('#ctp_target');
    select.html(options.join(''));
    if (!select.find(`option[value="${CSS.escape(settings.targetMode)}"]`).length) {
        settings.targetMode = TARGET_USER;
    }
    select.val(settings.targetMode);
    updateLoraSummary();
}

function refreshPresetSelect() {
    const settings = getSettings();
    if (!settings.presets.some(preset => preset.id === selectedPresetId)) {
        selectedPresetId = settings.presets[0]?.id ?? null;
    }
    $('#ctp_preset_select').html(settings.presets
        .map(preset => `<option value="${escapeHtml(preset.id)}">${escapeHtml(presetLabel(preset))}</option>`)
        .join(''))
        .val(selectedPresetId);
    const fallback = settings.presets.some(preset => preset.id === settings.userFallbackPresetId) ? settings.userFallbackPresetId : '';
    $('#ctp_user_fallback')
        .html([['', '不使用角色预设（默认模型 + 默认 LoRA）'], ...settings.presets.map(preset => [preset.id, displayName(preset)])]
            .map(([id, label]) => `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`).join(''))
        .val(fallback);
    loadPresetEditor();
    refreshLoraEditor();
    refreshTargetSelect();
    renderExtraLoras();
    updateLoraSummary();
}

function currentPreset() {
    return getSettings().presets.find(preset => preset.id === selectedPresetId) ?? null;
}

/* ---------------- character LoRA (in 出图参数) ---------------- */

/** Preset whose LoRA is shown in the 出图参数 group; separate from the preset editor's selection. */
let loraPresetId = null;

function loraPreset() {
    return getSettings().presets.find(preset => preset.id === loraPresetId) ?? null;
}

registerPickerOwner('charloraPicker', loraPreset);

function refreshLoraEditor() {
    const presets = getSettings().presets;
    if (!presets.some(preset => preset.id === loraPresetId)) {
        loraPresetId = presets.some(preset => preset.id === selectedPresetId) ? selectedPresetId : presets[0]?.id ?? null;
    }
    $('#ctp_lora_preset')
        .html(presets.map(preset => `<option value="${escapeHtml(preset.id)}">${escapeHtml(displayName(preset))}</option>`).join(''))
        .val(loraPresetId);
    const preset = loraPreset();
    $('#ctp_lora_editor').toggle(!!preset);
    if (!preset) return;
    document.querySelectorAll('#ctp_lora_editor [data-charlora]').forEach(element => writeInput(element, preset[element.dataset.charlora]));
    document.querySelectorAll('#ctp_lora_editor [data-charlora-picker]').forEach(renderPicker);
}

/* ---------------- 更多 LoRA ---------------- */

function renderExtraLoras() {
    const settings = getSettings();
    if (!Array.isArray(settings.comfy.extraLoras)) settings.comfy.extraLoras = [];
    const presets = settings.presets;
    const container = document.getElementById('ctp_extra_loras');
    if (!container) return;
    container.innerHTML = settings.comfy.extraLoras.map((lora, index) => `
        <div class="ctp-row ctp-extra-lora" data-index="${index}">
            <input type="checkbox" data-extra="enabled" title="使用" ${lora.enabled !== false ? 'checked' : ''}>
            <select class="text_pole" data-picker="comfy.extraLoras.${index}.name" data-list="lora"></select>
            <input type="number" class="text_pole" step="0.05" data-extra="strength" title="强度" value="${escapeHtml(String(lora.strength ?? 1))}">
            <select class="text_pole ctp-extra-preset" data-extra="presetId" title="用于">
                ${[['', '所有图'], ...presets.map(preset => [preset.id, `只画${displayName(preset)}时`])]
                    .map(([id, label]) => `<option value="${escapeHtml(id)}" ${id === (lora.presetId || '') ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}
            </select>
            <div class="menu_button fa-solid fa-trash-can" data-extra-remove title="删除"></div>
        </div>`).join('');
    bindPickers(container);
}

function initExtraLoras() {
    const container = $('#ctp_extra_loras');
    const entry = element => getSettings().comfy.extraLoras[Number($(element).closest('.ctp-extra-lora').data('index'))];
    container.on('input change', '[data-extra]', function () {
        const lora = entry(this);
        if (!lora) return;
        const key = this.dataset.extra;
        lora[key] = key === 'enabled' ? this.checked : key === 'strength' ? Number(this.value) || 0 : String(this.value);
        saveSettings();
    });
    container.on('click', '[data-extra-remove]', function () {
        const index = Number($(this).closest('.ctp-extra-lora').data('index'));
        getSettings().comfy.extraLoras.splice(index, 1);
        saveSettings();
        renderExtraLoras();
        updateLoraSummary();
    });
    $('#ctp_extra_lora_add').on('click', () => {
        getSettings().comfy.extraLoras.push({ name: '', strength: 1, presetId: '', enabled: true });
        saveSettings();
        renderExtraLoras();
    });
    renderExtraLoras();
}

/* ---------------- summary of the LoRAs that will be used ---------------- */

/** The character "画谁" points at, when it is fixed (not "auto"). */
function targetPresetForSummary() {
    const { targetMode } = getSettings();
    if (targetMode === TARGET_AUTO) return { auto: true };
    if (targetMode === TARGET_USER) return { preset: resolveUserPreset().preset, name: ctx().name1 || '{{user}}' };
    if (targetMode === TARGET_CHAR) return { preset: presetForName(ctx().name2), name: ctx().name2 || '{{char}}' };
    const preset = findPresetById(targetMode);
    return { preset, name: preset ? presetName(preset) || preset.name : '' };
}

function summaryFor(preset, name) {
    const plan = renderPlan({ modelMode: currentMode(), presetId: preset?.id ?? null, target: name });
    const lines = planLoraLines(plan);
    const head = preset ? `画${displayName(preset)}` : `画「${name}」（没有角色预设）`;
    const profile = plan.profile ? `，渲染配置「${plan.profile.name}」` : '';
    return `${head}${profile}：\n${lines.length ? lines.map(line => `  · ${line}`).join('\n') : '  · 不加 LoRA'}`;
}

let summaryTimer = null;

/** "会使用的 LoRA" at the bottom of 出图参数: every LoRA and strength a picture of the current target would get. */
function updateLoraSummary() {
    clearTimeout(summaryTimer);
    summaryTimer = setTimeout(() => {
        const element = document.getElementById('ctp_lora_summary');
        if (!element) return;
        const { comfy } = getSettings();
        const blocks = [];
        const target = targetPresetForSummary();
        if (target.auto) blocks.push('画谁 = 自动：由解析模型挑出的角色决定，用那个角色的预设。');
        else blocks.push(summaryFor(target.preset, target.name));
        const editing = loraPreset();
        if (editing && editing.id !== target.preset?.id) blocks.push(summaryFor(editing, presetName(editing) || editing.name));
        const custom = comfy.workflowSource === 'custom' ? '\n自定义工作流：角色 / 风格 LoRA 要有 %char_lora% / %lora% 占位符才会生效，「更多 LoRA」会自动接上。' : '';
        blocks.push(`强度作用于：${comfy.loraClip ? '模型 + 文本编码器（加载 LoRA，模型和 CLIP 强度相同）' : '仅模型（LoRA 加载器（仅模型））'}${custom}`);
        element.textContent = blocks.join('\n\n');
    }, 50);
}

function initLoraEditor() {
    $('#ctp_lora_preset').on('change', function () {
        loraPresetId = String($(this).val());
        refreshLoraEditor();
    });
    document.querySelectorAll('#ctp_lora_editor [data-charlora]').forEach(element => {
        element.addEventListener('input', () => {
            const preset = loraPreset();
            if (!preset) return;
            preset[element.dataset.charlora] = readInput(element);
            saveSettings();
        });
    });
}

/** Options of the preset editor's render profile select (default + every profile). */
function renderPresetRenderOptions() {
    const preset = currentPreset();
    const options = [['', '默认（ComfyUI 区的设置）'], ...getSettings().renderProfiles.map(profile => [profile.id, profile.name])];
    $('#ctp_preset_render')
        .html(options.map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join(''))
        .val(renderProfileFor(preset)?.id ?? '');
}

function loadPresetEditor() {
    const preset = currentPreset();
    $('#ctp_preset_editor').toggle(!!preset);
    if (!preset) return;
    renderPresetRenderOptions();
    document.querySelectorAll('#ctp_preset_editor [data-preset]').forEach(element => {
        writeInput(element, preset[element.dataset.preset]);
    });
    // A deleted or unknown profile shows as the default.
    $('#ctp_preset_render').val(renderProfileFor(preset)?.id ?? '');
}

/** Persona + preset {{user}} used last time, to notice a switch. */
let lastUserKey;

function userSwitchText(preset, via) {
    const who = `{{user}}（${ctx().name1}）`;
    if (!preset) return `${who}没有预设 → 不加固定外貌，用默认模型和 LoRA`;
    const profile = renderProfileFor(preset);
    const render = `，渲染配置：${profile ? profile.name : '默认'}`;
    if (via === 'fallback') return `${who}没有自己的预设 → 默认的${displayName(preset)}${render}`;
    return `${who}→ ${displayName(preset)}${render}`;
}

/**
 * Per-persona profiles: when the user persona changed, put its own profile in place (everything except the API
 * settings). Returns true when the profile was switched.
 */
export function syncPersonaProfile() {
    const settings = getSettings();
    const persona = currentPersona() || '';
    if (!settings.perPersonaProfiles || !persona) return false;
    // Settings from before profiles (or just turned on) become the current persona's profile. The other mode's
    // copy may still be under the plain mode key (v1.16): it is this persona's too.
    if (!settings.profilePersona || MODEL_MODES.some(mode => settings.modeStore[mode])) {
        const owner = settings.profilePersona || persona;
        adoptProfile(owner);
        saveSettings();
        updateProfileLabel();
        if (owner === persona) return false;
    }
    if (settings.profilePersona === persona) return false;
    const busy = hasActiveJobs();
    cancelAllJobs();
    resetPanelForMode();
    const isNew = !hasProfile(persona);
    // The persona's own mode comes with it: a persona last used with Anima switches to Anima.
    const mode = personaMode(persona);
    swapProfile(mode, persona);
    saveSettings();
    refreshAllSettingsUi();
    const { preset, via } = resolveUserPreset();
    if (preset) {
        selectedPresetId = preset.id;
        refreshPresetSelect();
    }
    if (settings.enabled) {
        toastr.info(`已切换到人设「${personaName(persona)}」的配图档案 · ${modeLabel(mode)} 模式${isNew ? '（第一次使用，全部是默认设置）' : ''}${busy ? '，正在进行的配图已取消' : ''}\n${userSwitchText(preset, via)}`, 'ComfyUI 角色配图');
    }
    return true;
}

function updateProfileLabel() {
    const settings = getSettings();
    $('#ctp_profile_label').text(settings.perPersonaProfiles && settings.profilePersona ? `当前档案：人设「${personaName(settings.profilePersona)}」` : '所有人设共用一套设置');
}

/** Called after a persona switch: show the new persona's preset and say what {{user}} now uses. */
export function onPersonaChanged() {
    if (syncPersonaProfile()) {
        lastUserKey = `${currentPersona()}|${findUserPreset()?.id ?? ''}`;
        return;
    }
    const { preset, via } = resolveUserPreset();
    const key = `${currentPersona()}|${preset?.id ?? ''}`;
    const switched = lastUserKey !== undefined && key !== lastUserKey;
    // The editor jumps to the preset the new persona uses, so its look / LoRA / render profile are at hand.
    if (switched && preset) selectedPresetId = preset.id;
    // Labels and the checklist show persona names / the active persona.
    refreshPresetSelect();
    if (switched && getSettings().enabled) toastr.info(userSwitchText(preset, via), 'ComfyUI 角色配图');
    lastUserKey = key;
}

function newPreset(base = {}) {
    return {
        id: makeId(),
        name: '新角色',
        aliases: '',
        appearance: '',
        outfits: '',
        trigger: '',
        lora: '',
        loraStrength: 0.8,
        negative: '',
        renderProfileId: '',
        ...base,
    };
}

function sanitizePreset(raw) {
    const preset = newPreset();
    for (const key of Object.keys(preset)) {
        if (key === 'id') continue;
        if (raw?.[key] === undefined) continue;
        if (key === 'loraStrength') preset[key] = Number(raw[key]) || 0;
        else preset[key] = String(raw[key]);
    }
    return preset;
}

function initPresets() {
    lastUserKey = `${currentPersona()}|${findUserPreset()?.id ?? ''}`;
    $('#ctp_user_fallback').on('change', function () {
        getSettings().userFallbackPresetId = String($(this).val());
        saveSettings();
        refreshPresetSelect();
    });

    $('#ctp_target').on('change', function () {
        getSettings().targetMode = String($(this).val());
        saveSettings();
    });

    $('#ctp_preset_select').on('change', function () {
        selectedPresetId = String($(this).val());
        loadPresetEditor();
    });

    document.querySelectorAll('#ctp_preset_editor [data-preset]').forEach(element => {
        element.addEventListener('input', () => {
            const preset = currentPreset();
            if (!preset) return;
            preset[element.dataset.preset] = readInput(element);
            saveSettings();
            if (element.dataset.preset === 'name') {
                $('#ctp_preset_select option:selected').text(presetLabel(preset));
                refreshTargetSelect();
                refreshLoraEditor();
            }
            if (element.dataset.preset === 'name' || element.dataset.preset === 'renderProfileId') refreshRenderProfileUsage();
        });
    });

    $('#ctp_preset_add').on('click', () => {
        const preset = newPreset();
        getSettings().presets.push(preset);
        selectedPresetId = preset.id;
        saveSettings();
        refreshPresetSelect();
    });

    $('#ctp_preset_clone').on('click', () => {
        const source = currentPreset();
        if (!source) return;
        const preset = newPreset({ ...structuredClone(source), id: makeId(), name: `${source.name} 副本` });
        getSettings().presets.push(preset);
        selectedPresetId = preset.id;
        saveSettings();
        refreshPresetSelect();
    });

    $('#ctp_preset_delete').on('click', async () => {
        const preset = currentPreset();
        if (!preset) return;
        const { callGenericPopup, POPUP_TYPE, POPUP_RESULT } = ctx();
        const confirmed = await callGenericPopup(`删除角色预设「${escapeHtml(preset.name)}」？`, POPUP_TYPE.CONFIRM);
        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) return;
        const settings = getSettings();
        settings.presets = settings.presets.filter(item => item.id !== preset.id);
        if (settings.targetMode === preset.id) settings.targetMode = TARGET_USER;
        if (settings.userFallbackPresetId === preset.id) settings.userFallbackPresetId = '';
        saveSettings();
        refreshPresetSelect();
        refreshRenderProfileUsage();
    });

    $('#ctp_preset_export').on('click', () => {
        const { presets, renderProfiles } = getSettings();
        const modelMode = currentMode();
        // Render profiles go along so imported presets keep their models and LoRAs.
        const blob = new Blob([JSON.stringify({ type: 'comfy_portrait_presets', modelMode, presets, renderProfiles }, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `comfy_portrait_presets_${modelMode}.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    });

    $('#ctp_preset_import').on('click', () => $('#ctp_preset_file').trigger('click'));
    $('#ctp_preset_file').on('change', async function () {
        const file = this.files?.[0];
        this.value = '';
        if (!file) return;
        try {
            const json = JSON.parse(await file.text());
            const list = Array.isArray(json) ? json : Array.isArray(json?.presets) ? json.presets : [json];
            const imported = list.filter(item => item && typeof item === 'object').map(sanitizePreset);
            if (!imported.length) throw new Error('文件里没有角色预设');
            // The two modes are kept apart: say so when a file of the other mode's presets comes in.
            // Files exported before the Anima mode existed hold Krea 2 presets.
            const fileMode = typeof json?.modelMode === 'string' ? normalizeMode(json.modelMode)
                : json?.type === 'comfy_portrait_presets' ? MODEL_KREA2 : null;
            if (fileMode && fileMode !== currentMode()) {
                const { callGenericPopup, POPUP_TYPE, POPUP_RESULT } = ctx();
                const answer = await callGenericPopup(`这个文件是从 ${modeLabel(fileMode)} 模式导出的，当前是 ${modeLabel()} 模式。<br>里面的角色 LoRA、渲染配置（模型、工作流）是给 ${modeLabel(fileMode)} 用的，导入后请逐个检查。仍然导入到 ${modeLabel()} 模式？`, POPUP_TYPE.CONFIRM);
                if (answer !== POPUP_RESULT.AFFIRMATIVE) return;
            }
            const settings = getSettings();
            const known = new Set(settings.renderProfiles.map(profile => profile.id));
            const profiles = (Array.isArray(json?.renderProfiles) ? json.renderProfiles : [])
                .filter(item => item && typeof item === 'object' && item.id && !known.has(String(item.id)))
                .map(sanitizeRenderProfile);
            settings.renderProfiles.push(...profiles);
            settings.presets.push(...imported);
            selectedPresetId = imported[0].id;
            saveSettings();
            refreshRenderProfileUi();
            refreshPresetSelect();
            toastr.success(`已导入 ${imported.length} 个角色预设${profiles.length ? `、${profiles.length} 个渲染配置` : ''}`);
        } catch (error) {
            toastr.error(errorMessage(error), '导入失败');
        }
    });
}

/* ---------------- parser ---------------- */

function refreshProfiles() {
    const select = $('#ctp_profile');
    let profiles = [];
    try {
        const service = ctx().ConnectionManagerRequestService;
        profiles = service?.getSupportedProfiles?.() ?? ctx().extensionSettings?.connectionManager?.profiles ?? [];
    } catch (error) {
        select.html(`<option value="">${escapeHtml(errorMessage(error))}</option>`);
        return;
    }
    const current = getSettings().parser.profileId;
    select.html([
        '<option value="">— 选择连接配置 —</option>',
        ...profiles.map(profile => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}${profile.model ? ` (${escapeHtml(profile.model)})` : ''}</option>`),
    ].join(''));
    select.val(current);
}

async function fetchParserModels() {
    const { parser } = getSettings();
    const url = parser.customUrl.trim().replace(/\/+$/, '');
    if (!url) {
        toastr.warning('先填写 API 地址');
        return;
    }
    const toIds = json => {
        const list = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : Array.isArray(json?.data?.data) ? json.data.data : [];
        return list.map(item => (typeof item === 'string' ? item : item?.id)).filter(Boolean);
    };
    let ids = [];
    try {
        const response = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: ctx().getRequestHeaders(),
            body: JSON.stringify({
                chat_completion_source: 'custom',
                custom_url: url,
                custom_include_headers: parser.customKey ? JSON.stringify({ Authorization: `Bearer ${parser.customKey.trim()}` }) : '',
            }),
        });
        if (response.ok) ids = toIds(await response.json());
    } catch {
        // fall back to a direct request
    }
    if (!ids.length) {
        try {
            const response = await fetch(`${url}/models`, {
                headers: parser.customKey ? { Authorization: `Bearer ${parser.customKey.trim()}` } : {},
            });
            if (response.ok) ids = toIds(await response.json());
        } catch {
            // ignore
        }
    }
    if (ids.length) {
        getSettings().parser.models = [...new Set(ids)].sort();
        saveSettings();
        renderPickers();
        toastr.success(`读取到 ${ids.length} 个模型，在「模型」下拉框里选择`);
    } else {
        toastr.warning('没有读取到模型列表，可以在下拉框里选「手动输入」');
    }
}

async function testParser() {
    toastr.info('正在请求解析模型…');
    const started = performance.now();
    try {
        const reply = await callParser('You are a JSON API. Reply with JSON only.', 'Reply exactly with {"ok": true}');
        const ms = Math.round(performance.now() - started);
        if (!reply.content.trim()) {
            toastr.warning(`${ms} ms：正文为空${reply.finish ? `（finish_reason=${reply.finish}）` : ''}${reply.reasoning ? '，只有思考内容' : ''}。思考模型请调大「最大输出」或在「附加请求参数」里关闭思考。`, '解析模型返回了空内容', { timeOut: 10000 });
        } else {
            toastr.success(`${ms} ms：${truncate(reply.content, 120)}`, '解析模型可用');
        }
    } catch (error) {
        toastr.error(errorMessage(error), '解析模型请求失败');
    }
}

/* ---------------- comfy ---------------- */

async function testComfy() {
    try {
        toastr.success(await testConnection());
    } catch (error) {
        toastr.error(errorMessage(error), '连接失败');
        return;
    }
    await loadComfyLists({ quiet: true });
}

async function loadComfyLists({ quiet = false } = {}) {
    if (!quiet) toastr.info('正在读取 ComfyUI 模型列表…');
    const status = $('#ctp_lists_status');
    status.removeClass('ctp-warn').text('读取中…');
    try {
        const { lists, notes } = await fetchModelLists();
        const settings = getSettings();
        // Keep previously cached entries for lists this attempt could not read.
        for (const [key, values] of Object.entries(lists)) {
            if (values.length) settings.comfy.lists[key] = values;
        }
        saveSettings();
        renderPickers();
        status.text([listsSummary(), ...notes].join('\n')).toggleClass('ctp-warn', notes.length > 0);
        if (!quiet) {
            if (notes.length) toastr.warning(notes.join('\n'), '部分列表没读到', { timeOut: 12000 });
            else toastr.success(listsSummary(), '已读取，在下拉框里选择');
        }
    } catch (error) {
        status.addClass('ctp-warn').text(errorMessage(error));
        if (!quiet) toastr.error(errorMessage(error), '读取失败');
    }
}

function validateWorkflow(text = getSettings().comfy.workflow) {
    try {
        parseWorkflow(text);
        const { notes } = prepareWorkflow(text, {
            prompt: 'test', negative_prompt: '', width: 1024, height: 1024, seed: 1, steps: 8, cfg: 1, scale: 1,
            sampler: 'euler', scheduler: 'simple', denoise: 1, unet: 'a', model: 'a', clip: 'b', vae: 'c',
            lora: '', lora_strength: 0, lora_clip_strength: 0, char_lora: '', char_lora_strength: 0, char_lora_clip_strength: 0, filename_prefix: 'x', batch_size: 1,
            slg_layers: '',
        });
        const placeholders = [...new Set(text.match(/%\w+%/g) || [])];
        toastr.success(`${placeholders.length ? `占位符：${placeholders.join(' ')}` : '无占位符，将使用自动注入'}${notes.length ? `\n${notes.join('\n')}` : ''}`, '工作流可用', { timeOut: 8000 });
    } catch (error) {
        toastr.error(errorMessage(error), '工作流有问题', { timeOut: 8000 });
    }
}

/** Shows the comfy settings, resolution and workflow controls again after they were changed in code. */
function refreshComfyUi() {
    syncSettingsUi();
    updateSizeVisibility();
    syncResolutionSelect();
    updateMegapixels();
    updateWorkflowVisibility();
}

/** What "恢复为官方模板的设置" asks and sets in each mode. */
const OFFICIAL = {
    [MODEL_KREA2]: {
        question: '恢复为 ComfyUI 官方 Krea 2 Turbo 模板的设置？<br>内置工作流、官方模型文件、不用风格 LoRA、1024×1024、8 步、CFG 1、euler / simple、随机种子，关闭 ComfyUI 端提示词扩写（官方模板默认开着扩写，需要时自己勾选）。',
        comfy: OFFICIAL_KREA2_TURBO,
        done: '已恢复为官方 Krea 2 Turbo 模板的设置',
    },
    [MODEL_ANIMA]: {
        question: '恢复为 ComfyUI 官方 Anima Base v1 模板的设置？<br>内置工作流、官方模型文件（anima-base-v1.0、qwen_3_06b_base、qwen_image_vae）、不用风格 LoRA、1024×1024、30 步、CFG 4、euler / simple、随机种子，反向提示词换成官方模板的那一段。',
        comfy: OFFICIAL_ANIMA,
        negative: ANIMA_NEGATIVE,
        done: '已恢复为官方 Anima 模板的设置',
    },
    [MODEL_MOSS]: {
        question: '恢复为 ComfyUI 官方 MOSS-Image 模板的设置？<br>内置工作流、官方模型文件（moss_image_sft_int8_convrot、qwen3.5_9b_w4a8_gptq、flux2-vae_small）、不用风格 LoRA、1024×1024、25 步、CFG 2.5、er_sde / simple、关闭跳层引导、随机种子，反向提示词换成官方模板推荐的那一段（以 nsfw 开头）。',
        comfy: OFFICIAL_MOSS,
        negative: MOSS_NEGATIVE,
        done: '已恢复为官方 MOSS-Image 模板的设置',
    },
};

async function resetToOfficial() {
    const { callGenericPopup, POPUP_TYPE, POPUP_RESULT } = ctx();
    const mode = currentMode();
    const official = OFFICIAL[mode];
    const confirmed = await callGenericPopup(`${official.question}<br>ComfyUI 地址、连接方式、渲染配置、角色预设（角色 LoRA、触发词）不变。`, POPUP_TYPE.CONFIRM);
    if (confirmed !== POPUP_RESULT.AFFIRMATIVE) return;
    // The popup can stay open across a mode switch: these values are for the mode it was opened in.
    if (currentMode() !== mode) return;
    const settings = getSettings();
    Object.assign(settings.comfy, structuredClone(official.comfy));
    if (official.negative) settings.negativePrompt = official.negative;
    saveSettings();
    refreshComfyUi();
    toastr.success(official.done);
}

/** The official Anima template's turbo switch: its turbo LoRA as the style LoRA, 8 steps, CFG 1. */
async function useAnimaTurbo() {
    const { callGenericPopup, POPUP_TYPE, POPUP_RESULT } = ctx();
    const confirmed = await callGenericPopup(
        '改用官方 Anima Turbo 设置？<br>风格 LoRA 换成 anima-turbo-lora-v0.2.safetensors（强度 1）、8 步、CFG 1、euler / simple。<br>要先把这个 LoRA 下载到 ComfyUI 的 models/loras；想换回来点「恢复为官方 Anima 模板的设置」。',
        POPUP_TYPE.CONFIRM);
    if (confirmed !== POPUP_RESULT.AFFIRMATIVE) return;
    Object.assign(getSettings().comfy, structuredClone(ANIMA_TURBO));
    saveSettings();
    refreshComfyUi();
    toastr.success('已改用 Anima Turbo LoRA：8 步、CFG 1');
}

/** Closer to OpenMOSS's own results: 50 steps, CFG 3, Euler / sgm_uniform and skip layer guidance on layer 22. */
async function useMossQuality() {
    const { callGenericPopup, POPUP_TYPE, POPUP_RESULT } = ctx();
    const confirmed = await callGenericPopup(
        '改用 OpenMOSS 官方推荐的采样？<br>50 步、CFG 3、euler / sgm_uniform，打开跳层引导（第 22 层）。ComfyUI 模板为了速度用的是 25 步、CFG 2.5；这一套更接近 OpenMOSS 官方效果，但每张图要多花一倍时间。跳层引导可能让动漫画风颜色过重，不喜欢可以单独关掉。想换回来点「恢复为官方 MOSS-Image 模板的设置」。',
        POPUP_TYPE.CONFIRM);
    if (confirmed !== POPUP_RESULT.AFFIRMATIVE || currentMode() !== MODEL_MOSS) return;
    Object.assign(getSettings().comfy, structuredClone(MOSS_QUALITY));
    saveSettings();
    refreshComfyUi();
    toastr.success('已改用 OpenMOSS 官方推荐：50 步、CFG 3、跳层引导');
}

async function loadBuiltinIntoEditor() {
    const mode = currentMode();
    try {
        const text = await loadBuiltinWorkflow(mode);
        // The first load is a fetch; a mode switch meanwhile must not put this mode's graph into the other's.
        if (currentMode() !== mode) return;
        getSettings().comfy.workflow = text;
        $('[data-ctp="comfy.workflow"]').val(text);
        saveSettings();
        toastr.success('已载入内置工作流，可以在此基础上修改');
    } catch (error) {
        toastr.error(errorMessage(error));
    }
}

/* ---------------- reset everything ---------------- */


/**
 * What "keep presets" keeps of a mode's settings: character presets (with persona bindings), render profiles,
 * the fallback preset and the user's own parser presets (built-in ones go back to their default text).
 */
function keptPresets(own, mode) {
    const builtins = modeDefaults(mode).parserPresets;
    const builtinIds = new Set(builtins.map(preset => preset.id));
    return {
        presets: own.presets,
        renderProfiles: own.renderProfiles,
        userFallbackPresetId: own.userFallbackPresetId,
        parserPresets: [...structuredClone(builtins), ...(own.parserPresets || []).filter(preset => !builtinIds.has(preset.id))],
    };
}

/**
 * Puts the active mode's settings back to their defaults, optionally keeping the user's presets and the shared
 * connection details; the other modes' settings stay unless they are reset too.
 */
async function resetAllSettings() {
    const mode = currentMode();
    const others = MODEL_MODES.filter(item => item !== mode);
    const root = document.createElement('div');
    root.innerHTML = `
        <h3>全部恢复默认值</h3>
        <p>把这个扩展在 <b>${modeLabel(mode)}</b> 模式下的所有设置恢复成刚安装时的样子。聊天里已经生成的图片和配图记录不受影响。</p>
        <label class="checkbox_label"><input type="checkbox" data-keep="presets" checked> 保留角色预设、人设绑定、渲染配置和自己建的配图风格</label>
        <label class="checkbox_label"><input type="checkbox" data-keep="parser" checked> 保留「解析模型」的 API 设置：地址、Key、模型、连接配置、温度、最大输出、超时、重试（所有模式共用）</label>
        <label class="checkbox_label"><input type="checkbox" data-keep="comfy" checked> 保留 ComfyUI 地址、连接方式和已读取的模型列表（所有模式共用）</label>
        <label class="checkbox_label"><input type="checkbox" data-keep="reset-other"> ${others.map(item => modeLabel(item)).join('、')} 模式的设置也恢复默认（同样按第一项保留角色预设；「图片显示」只有勾了这一项才恢复，它是所有模式共用的）</label>
        <small class="ctp-hint">前三项都不勾 = 完全恢复成刚安装的样子，角色预设和 API Key 也会清掉；建议先在「角色预设」里导出备份。</small>`;
    const { callGenericPopup, POPUP_TYPE, POPUP_RESULT } = ctx();
    const result = await callGenericPopup(root, POPUP_TYPE.CONFIRM, '', { okButton: '恢复默认值', cancelButton: '取消' });
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;
    const keep = name => root.querySelector(`[data-keep="${name}"]`).checked;
    // The popup can stay open across a mode switch (slash command); reset the mode it was opened for only.
    if (currentMode() !== mode) {
        toastr.warning('模型模式已经切换，没有恢复任何设置');
        return;
    }

    const settings = getSettings();
    const fresh = structuredClone(modeDefaults(mode));
    fresh.modelMode = mode;
    if (keep('presets')) Object.assign(fresh, keptPresets(settings, mode));
    // The API settings are shared by all modes: kept as a whole, so resetting one mode does not change the others.
    if (keep('parser')) for (const key of SHARED_PARSER_KEYS) fresh.parser[key] = structuredClone(settings.parser[key]);
    if (keep('comfy')) for (const key of SHARED_COMFY_KEYS) fresh.comfy[key] = structuredClone(settings.comfy[key]);
    const store = settings.modeStore;
    // "Enabled", the automatic switch and the display settings are shared too; they go back to default only when
    // all modes are reset.
    if (!keep('reset-other')) {
        fresh.enabled = settings.enabled;
        fresh.autoModelByRating = settings.autoModelByRating;
        fresh.placeInStory = settings.placeInStory;
        fresh.panelAlsoInMessage = settings.panelAlsoInMessage;
        fresh.absentFallback = settings.absentFallback;
        for (const key of DISPLAY_KEYS) fresh[key] = structuredClone(settings[key]);
    }
    if (keep('reset-other')) {
        for (const other of others) {
            const key = otherSlotKey(other);
            const saved = store[key];
            delete store[key];
            if (keep('presets') && saved && typeof saved === 'object') store[key] = keptPresets(saved, other);
        }
    }
    fresh.modeStore = store;
    // Profiles stay as they are: this resets the current persona's profile only.
    fresh.perPersonaProfiles = settings.perPersonaProfiles;
    fresh.profilePersona = settings.profilePersona;
    fresh.personaModes = settings.personaModes;
    // Same object, new contents: other modules read it through getSettings().
    for (const key of Object.keys(settings)) delete settings[key];
    Object.assign(settings, fresh);
    saveSettings();

    refreshAllSettingsUi();
    toastr.success(keep('reset-other') ? '所有模式都已恢复默认值' : `${modeLabel(mode)} 模式已恢复默认值`);
}

/* ---------------- image model mode ---------------- */

/** Labels, hints and controls that differ between the modes. */
function applyModeChrome() {
    const mode = currentMode();
    const text = MODE_TEXT[mode];
    $('#ctp_mode_title').text(`(${modeLabel(mode)})`);
    $('#ctp_model_mode .ctp-mode-option').each(function () {
        const active = this.dataset.mode === mode;
        this.classList.toggle('active', active);
        this.setAttribute('aria-checked', String(active));
    });
    $('.ctp-settings .ctp-mode-only').each(function () {
        $(this).toggle(this.dataset.mode === mode);
    });
    $('#ctp_workflow_builtin_option').text(builtinWorkflowName(mode).replace(/^内置\s*/, '内置：'));
    $('#ctp_reset_official').text(text.official);
    $('#ctp_negative').attr('placeholder', text.negativePlaceholder);
    $('#ctp_negative_hint').text(text.negativeHint).toggle(!!text.negativeHint);
    $('#ctp_trigger_words').attr('placeholder', text.triggerPlaceholder);
    // Anima's prompt style switch (tags / English sentences)
    const natural = !!getSettings().naturalLanguage;
    $('#ctp_prompt_style .ctp-mode-option').each(function () {
        const active = (this.dataset.style === 'natural') === natural;
        this.classList.toggle('active', active);
        this.setAttribute('aria-checked', String(active));
    });
    $('#ctp_style_hint').text(natural
        ? '解析模型用英文自然语言写完整的句子（服装、动作、表情、场景……以及「AI 写完整提示词」的整段 prompt），提示词按句子拼接。画质前缀、触发词照常加在最前面；AI 补充的反向提示词仍然是标签。'
        : '解析模型用 Danbooru 风格的英文标签写服装、动作、表情等（Anima 训练时主要用的写法），提示词用逗号连接。');
}

/** Anima: write prompts as Danbooru tags or as English sentences. */
function setPromptStyle(style) {
    const natural = style === 'natural';
    if (!!getSettings().naturalLanguage === natural) return;
    getSettings().naturalLanguage = natural;
    saveSettings();
    applyModeChrome();
    toastr.success(natural ? 'Anima 提示词改用英文自然语言' : 'Anima 提示词改用 Danbooru 标签', 'ComfyUI 角色配图');
}

/** Re-reads every control after the whole settings object changed (mode switch, reset to defaults). */
function refreshAllSettingsUi() {
    // Editors show the first item of the new lists, and pickers belong to them.
    selectedPresetId = null;
    loraPresetId = null;
    resetRenderProfileSelection();
    applyModeChrome();
    updateProfileLabel();
    syncSettingsUi();
    refreshPresetSelect();
    renderResolutionOptions();
    updateSizeVisibility();
    updateMegapixels();
    updateSourceVisibility();
    updateWorkflowVisibility();
    updateSideOptionsVisibility();
    validateExtraBody();
    updateThinkingHint();
    $('#ctp_lists_status').text(listsSummary());
    // A persona switch is noticed against the new mode's {{user}} preset.
    lastUserKey = `${currentPersona()}|${findUserPreset()?.id ?? ''}`;
    updateStatusPrompt();
    updateLoraSummary();
    renderAll();
}

/**
 * Switches the image model mode (Krea 2 / Anima): every setting except the API ones changes with it. Pictures
 * being made are cancelled first, so none is parsed with one mode and drawn with the other.
 */
export function switchModelMode(target) {
    const to = normalizeMode(target);
    if (to === currentMode()) return false;
    const busy = hasActiveJobs();
    cancelAllJobs();
    resetPanelForMode();
    swapModeSettings(to);
    saveSettings();
    refreshAllSettingsUi();
    toastr.success(`已切换到 ${modeLabel(to)} 模式${busy ? '，正在进行的配图已取消' : ''}`, 'ComfyUI 角色配图');
    return true;
}

/**
 * Switch made by 按画面自动切换模型 at the start of a job: same as the mode switch, but the job that asked for it
 * keeps running (it starts in the new mode; jobs run one at a time, so none is mid-way).
 */
export function autoSwitchModelMode(target) {
    const to = normalizeMode(target);
    if (to === currentMode()) return false;
    resetPanelForMode();
    swapModeSettings(to);
    saveSettings();
    refreshAllSettingsUi();
    toastr.info(`按画面分级自动切换到 ${modeLabel(to)} 模式`, 'ComfyUI 角色配图', { timeOut: 2500 });
    return true;
}

function initModeSwitch() {
    const options = $('#ctp_model_mode .ctp-mode-option');
    options.on('click', function () {
        switchModelMode(this.dataset.mode);
    });
    options.on('keydown', function (event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        switchModelMode(this.dataset.mode);
    });
    const styles = $('#ctp_prompt_style .ctp-mode-option');
    styles.on('click', function () {
        setPromptStyle(this.dataset.style);
    });
    styles.on('keydown', function (event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        setPromptStyle(this.dataset.style);
    });
    applyModeChrome();
}

/* ---------------- collapsible groups ---------------- */

const OPEN_SECTIONS_KEY = 'ctp_open_sections';

function subIcon(sub) {
    return sub.querySelector(':scope > .inline-drawer-header .inline-drawer-icon');
}

function setSubOpen(sub, open) {
    const icon = subIcon(sub);
    icon?.classList.toggle('up', open);
    icon?.classList.toggle('fa-circle-chevron-up', open);
    icon?.classList.toggle('down', !open);
    icon?.classList.toggle('fa-circle-chevron-down', !open);
    const content = sub.querySelector(':scope > .inline-drawer-content');
    if (content) content.style.display = open ? 'block' : 'none';
}

/** Remembers which groups are open in this browser only (a viewing preference, not a setting). */
function saveOpenSections(root) {
    const open = [...root.querySelectorAll('.ctp-sub')]
        .filter(sub => subIcon(sub)?.classList.contains('up'))
        .map(sub => sub.dataset.sub);
    try {
        localStorage.setItem(OPEN_SECTIONS_KEY, JSON.stringify(open));
    } catch {
        // Storage unavailable (private window, blocked site data): groups just start closed next time.
    }
}

function initSubSections(root) {
    let open = [];
    try {
        open = JSON.parse(localStorage.getItem(OPEN_SECTIONS_KEY) || '[]');
    } catch {
        open = [];
    }
    const subs = [...root.querySelectorAll('.ctp-sub')];
    for (const sub of subs) {
        if (Array.isArray(open) && open.includes(sub.dataset.sub)) setSubOpen(sub, true);
        // SillyTavern's drawer handler flips the icon, then fires this (jQuery) event.
        $(sub).on('inline-drawer-toggle', event => {
            if (event.target === sub) saveOpenSections(root);
        });
    }
    const setAll = value => {
        subs.forEach(sub => setSubOpen(sub, value));
        saveOpenSections(root);
    };
    $('#ctp_expand_all').on('click', () => setAll(true));
    $('#ctp_collapse_all').on('click', () => setAll(false));
}

/* ---------------- debug / maintenance ---------------- */

async function clearChatData() {
    const { callGenericPopup, POPUP_TYPE, POPUP_RESULT, chat } = ctx();
    const confirmed = await callGenericPopup('清除本聊天所有楼层的配图数据？（服务器上的图片文件会保留）', POPUP_TYPE.CONFIRM);
    if (confirmed !== POPUP_RESULT.AFFIRMATIVE) return;
    let count = 0;
    for (const message of chat) {
        if (message.extra?.[EXTRA_KEY]) {
            delete message.extra[EXTRA_KEY];
            count++;
        }
        for (const info of message.swipe_info || []) {
            if (info?.extra?.[EXTRA_KEY]) delete info.extra[EXTRA_KEY];
        }
    }
    await ctx().saveChat();
    renderAll();
    toastr.success(`已清除 ${count} 层的配图数据`);
}

export async function initSettingsUi() {
    const response = await fetch(SETTINGS_URL, { cache: 'no-cache' });
    const html = await response.text();
    const container = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    const root = wrapper.firstElementChild;
    container.appendChild(root);

    bindSettings(root);
    bindPickers(root);
    initModeSwitch();
    initSubSections(root);
    initParserPresetUi();
    initResolution();
    updateSizeVisibility();
    updateMegapixels();
    validateExtraBody();
    updateThinkingHint();
    $('#ctp_lists_status').text(listsSummary());
    initPresets();
    initLoraEditor();
    initExtraLoras();
    // Any change in the panel can change which LoRAs are used.
    $(root).on('input change', updateLoraSummary);
    // The model picker changes the guessed thinking format without going through onSettingChanged.
    $(root).on('change', '[data-picker="parser.customModel"]', updateThinkingHint);
    initRenderProfileUi({ onChange: renderPresetRenderOptions, validateWorkflow });
    refreshPresetSelect();
    updateSourceVisibility();
    updateWorkflowVisibility();
    updateStatusVisibility();
    updateSideOptionsVisibility();
    $('#ctp_workflow_ui_link').attr('href', UI_WORKFLOW_URL.href);

    $('#ctp_profile').on('change', function () {
        getSettings().parser.profileId = String($(this).val());
        saveSettings();
    });
    $('#ctp_profile_refresh').on('click', refreshProfiles);
    $('#ctp_parser_models').on('click', fetchParserModels);
    $('#ctp_parser_test').on('click', testParser);
    $('#ctp_comfy_test').on('click', testComfy);
    $('#ctp_comfy_models').on('click', () => loadComfyLists());
    $('#ctp_workflow_validate').on('click', () => validateWorkflow());
    $('#ctp_status_preview').on('click', previewStatusInstruction);
    $('#ctp_workflow_load_builtin').on('click', loadBuiltinIntoEditor);
    $('#ctp_reset_official').on('click', resetToOfficial);
    $('#ctp_anima_turbo').on('click', useAnimaTurbo);
    $('#ctp_moss_quality').on('click', useMossQuality);
    $('#ctp_reset_all').on('click', resetAllSettings);
    $('#ctp_debug_chat').on('click', showChatDebug);
    $('#ctp_debug_preview, #ctp_debug_preview_top').on('click', showParserPreview);
    $('#ctp_debug_dry').on('click', showDryRun);
    $('#ctp_generate_last').on('click', () => {
        const mesId = lastFloorId();
        if (mesId < 0) toastr.info('当前没有聊天');
        else enqueue(mesId, { mode: 'reparse', force: true });
    });
    $('#ctp_clear_chat').on('click', clearChatData);
    updateProfileLabel();
    // The persona may have changed while the extension was not loaded.
    syncPersonaProfile();
}

/** Re-reads values that can change outside the panel (slash commands, persona switch). */
export function syncSettingsUi() {
    const settings = getSettings();
    document.querySelectorAll('.ctp-settings [data-ctp]').forEach(element => {
        writeInput(element, getPath(settings, element.dataset.ctp));
    });
    renderPickers();
    refreshTargetSelect();
    refreshParserPresetUi();
    refreshRenderProfileUi();
    updateStatusVisibility();
}
