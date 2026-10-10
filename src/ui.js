import { fetchModelLists, loadBuiltinWorkflow, parseWorkflow, prepareWorkflow, testConnection } from './comfy.js';
import {
    DEFAULT_SETTINGS,
    EXTRA_KEY,
    RESOLUTION_PRESETS,
    TARGET_AUTO,
    TARGET_CHAR,
    TARGET_USER,
    makeId,
} from './constants.js';
import { lastFloorId, showChatDebug, showDryRun, showParserPreview } from './debug.js';
import { resetPanelGeometry } from './panel.js';
import { bindPickers, getPath, readInput, registerPickerOwner, renderPicker, renderPickers, setPath, writeInput } from './form.js';
import { initParserPresetUi, refreshParserPresetUi } from './ui-parser-presets.js';
import { initRenderProfileUi, refreshRenderProfileUi, refreshRenderProfileUsage } from './ui-render-profiles.js';
import { renderProfileFor, sanitizeRenderProfile } from './renderProfiles.js';
import { callParser, parseExtraBody } from './parser.js';
import { enqueue } from './pipeline.js';
import { renderAll } from './render.js';
import { currentPersona, findUserPreset, personaList, presetName } from './targets.js';
import { ctx, errorMessage, escapeHtml, getSettings, roundTo16, saveSettings, truncate } from './utils.js';

const SETTINGS_URL = new URL('../settings.html', import.meta.url);
const UI_WORKFLOW_URL = new URL('../workflows/krea2_turbo_t2i_lora_ui.json', import.meta.url);

let selectedPresetId = null;

function listsSummary() {
    const lists = getSettings().comfy.lists || {};
    const count = key => (lists[key]?.length ? lists[key].length : '—');
    return `已缓存列表：扩散模型 ${count('unet')} · 文本编码器 ${count('clip')} · VAE ${count('vae')} · LoRA ${count('lora')} · 采样器 ${count('sampler')}`;
}

function updateMegapixels() {
    const { width, height } = getSettings().comfy;
    const mp = (Number(width) * Number(height)) / 1e6;
    const element = $('#ctp_mp');
    const base = `${width}×${height} ≈ ${mp.toFixed(2)} MP。会自动对齐到 16 的倍数，Krea 2 Turbo 适合约 1–2 MP。`;
    element.text(mp > 4.2 ? `${base} 当前远超推荐范围，容易出现重复人物、多余肢体，也更慢。` : base);
    element.toggleClass('ctp-warn', mp > 4.2);
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
    if (['debug', 'imagePosition', 'imagePositionNarrow', 'sideWidth', 'sideTextWrap', 'imageMaxWidth'].includes(path)) renderAll();
    if (path === 'imagePosition') {
        updateSideOptionsVisibility();
        // A remembered panel position belongs to the old side.
        resetPanelGeometry();
    }
    if (path === 'parser.source') updateSourceVisibility();
    if (path === 'parser.extraBody') validateExtraBody();
    if (path === 'comfy.workflowSource') updateWorkflowVisibility();
    if (path === 'comfy.width' || path === 'comfy.height') {
        syncResolutionSelect();
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
            setPath(getSettings(), path, getPath(DEFAULT_SETTINGS, path));
            saveSettings();
            const input = root.querySelector(`[data-ctp="${path}"]`);
            if (input) writeInput(input, getPath(getSettings(), path));
            toastr.success('已恢复默认');
        });
    });

    for (const id of ['ctp_width', 'ctp_height']) {
        const input = document.getElementById(id);
        input.addEventListener('change', () => {
            const key = id === 'ctp_width' ? 'width' : 'height';
            const rounded = roundTo16(input.value, DEFAULT_SETTINGS.comfy[key]);
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
    const match = RESOLUTION_PRESETS.findIndex(preset => preset.w === Number(width) && preset.h === Number(height));
    $('#ctp_resolution').val(match >= 0 ? String(match) : 'custom');
}

function initResolution() {
    const select = $('#ctp_resolution');
    select.html([
        '<option value="custom">自定义</option>',
        ...RESOLUTION_PRESETS.map((preset, index) => `<option value="${index}">${preset.label}</option>`),
    ].join(''));
    select.on('change', () => {
        const preset = RESOLUTION_PRESETS[Number(select.val())];
        if (!preset) return;
        getSettings().comfy.width = preset.w;
        getSettings().comfy.height = preset.h;
        $('#ctp_width').val(preset.w);
        $('#ctp_height').val(preset.h);
        saveSettings();
        updateMegapixels();
    });
    syncResolutionSelect();
}

/* ---------------- target & presets ---------------- */

function personaName(id) {
    return personaList().find(persona => persona.id === id)?.name ?? id;
}

function presetLabel(preset) {
    const resolved = presetName(preset);
    const base = resolved && resolved !== preset.name ? `${preset.name} → ${resolved}` : (preset.name || '（未命名）');
    const bound = Array.isArray(preset.personas) && preset.personas.length
        ? `［人设：${preset.personas.map(personaName).join('、')}］`
        : '';
    return base + bound;
}

/** How a preset is named in messages: macro names like {{user}} are shown as written, not resolved. */
function displayName(preset) {
    const raw = String(preset?.name || '');
    return `预设「${raw.includes('{{') ? raw : (presetName(preset) || raw)}」`;
}

/** Name shown for the preset {{user}} currently resolves to. */
function userPresetName() {
    const preset = findUserPreset();
    return preset ? displayName(preset) : '无预设';
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
    loadPresetEditor();
    refreshTargetSelect();
}

function currentPreset() {
    return getSettings().presets.find(preset => preset.id === selectedPresetId) ?? null;
}

registerPickerOwner('presetPicker', currentPreset);

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
    document.querySelectorAll('#ctp_preset_editor [data-preset-picker]').forEach(renderPicker);
    renderPersonaBindings();
}

/** Checkbox per user persona; a persona can be bound to one preset only. */
function renderPersonaBindings() {
    const preset = currentPreset();
    const container = $('#ctp_preset_personas');
    if (!preset) return container.empty();
    const personas = personaList();
    if (!personas.length) {
        container.html('<small class="ctp-hint">酒馆里还没有用户人设</small>');
        return;
    }
    const active = currentPersona();
    const owners = new Map();
    for (const other of getSettings().presets) {
        for (const id of other.personas || []) owners.set(id, other);
    }
    container.html(personas.map(persona => {
        const owner = owners.get(persona.id);
        const elsewhere = owner && owner.id !== preset.id ? `<small>（已绑定到「${escapeHtml(presetName(owner) || owner.name)}」）</small>` : '';
        return `<label class="checkbox_label" title="${escapeHtml(persona.id)}">
            <input type="checkbox" data-persona="${escapeHtml(persona.id)}" ${(preset.personas || []).includes(persona.id) ? 'checked' : ''}>
            <span>${escapeHtml(persona.name)}${persona.id === active ? ' <b>（当前）</b>' : ''} ${elsewhere}</span>
        </label>`;
    }).join(''));
}

function onPersonaToggle(event) {
    const preset = currentPreset();
    const id = event.target.dataset.persona;
    if (!preset || !id) return;
    const settings = getSettings();
    if (event.target.checked) {
        for (const other of settings.presets) {
            if (other !== preset && other.personas?.includes(id)) {
                other.personas = other.personas.filter(item => item !== id);
                toastr.info(`人设已从预设「${presetName(other) || other.name}」改绑到当前预设`);
            }
        }
        preset.personas = [...new Set([...(preset.personas || []), id])];
    } else {
        preset.personas = (preset.personas || []).filter(item => item !== id);
    }
    saveSettings();
    renderPersonaBindings();
    $('#ctp_preset_select option').each(function () {
        const item = settings.presets.find(p => p.id === this.value);
        if (item) $(this).text(presetLabel(item));
    });
    refreshTargetSelect();
}

let lastUserPresetId;

/** Called after a persona switch: refresh labels and say which preset {{user}} now uses. */
export function onPersonaChanged() {
    // Labels and the checklist show persona names / the active persona.
    refreshPresetSelect();
    const preset = findUserPreset();
    const id = preset?.id ?? null;
    if (lastUserPresetId !== undefined && id !== lastUserPresetId && getSettings().enabled) {
        const profile = renderProfileFor(preset);
        const render = preset ? `，渲染配置：${profile ? profile.name : '默认'}` : '';
        toastr.info(`{{user}}（${ctx().name1}）→ ${preset ? displayName(preset) : '无预设（没有绑定或同名的预设）'}${render}`, 'ComfyUI 角色配图');
    }
    lastUserPresetId = id;
}

function newPreset(base = {}) {
    return {
        id: makeId(),
        name: '新角色',
        aliases: '',
        appearance: '',
        trigger: '',
        lora: '',
        loraStrength: 0.8,
        negative: '',
        personas: [],
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
        else if (key === 'personas') preset[key] = Array.isArray(raw[key]) ? raw[key].map(String) : [];
        else preset[key] = String(raw[key]);
    }
    return preset;
}

function initPresets() {
    $('#ctp_preset_personas').on('change', 'input[data-persona]', onPersonaToggle);
    lastUserPresetId = findUserPreset()?.id ?? null;
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
        saveSettings();
        refreshPresetSelect();
        refreshRenderProfileUsage();
    });

    $('#ctp_preset_export').on('click', () => {
        const { presets, renderProfiles } = getSettings();
        // Render profiles go along so imported presets keep their models and LoRAs.
        const blob = new Blob([JSON.stringify({ type: 'comfy_portrait_presets', presets, renderProfiles }, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'comfy_portrait_presets.json';
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
            lora: '', lora_strength: 0, char_lora: '', char_lora_strength: 0, filename_prefix: 'x', batch_size: 1,
        });
        const placeholders = [...new Set(text.match(/%\w+%/g) || [])];
        toastr.success(`${placeholders.length ? `占位符：${placeholders.join(' ')}` : '无占位符，将使用自动注入'}${notes.length ? `\n${notes.join('\n')}` : ''}`, '工作流可用', { timeOut: 8000 });
    } catch (error) {
        toastr.error(errorMessage(error), '工作流有问题', { timeOut: 8000 });
    }
}

async function loadBuiltinIntoEditor() {
    try {
        const text = await loadBuiltinWorkflow();
        getSettings().comfy.workflow = text;
        $('[data-ctp="comfy.workflow"]').val(text);
        saveSettings();
        toastr.success('已载入内置工作流，可以在此基础上修改');
    } catch (error) {
        toastr.error(errorMessage(error));
    }
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
    initSubSections(root);
    initParserPresetUi();
    initResolution();
    updateMegapixels();
    validateExtraBody();
    $('#ctp_lists_status').text(listsSummary());
    initPresets();
    initRenderProfileUi({ onChange: renderPresetRenderOptions, validateWorkflow });
    refreshPresetSelect();
    updateSourceVisibility();
    updateWorkflowVisibility();
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
    $('#ctp_workflow_load_builtin').on('click', loadBuiltinIntoEditor);
    $('#ctp_debug_chat').on('click', showChatDebug);
    $('#ctp_debug_preview').on('click', showParserPreview);
    $('#ctp_debug_dry').on('click', showDryRun);
    $('#ctp_generate_last').on('click', () => {
        const mesId = lastFloorId();
        if (mesId < 0) toastr.info('当前没有聊天');
        else enqueue(mesId, { mode: 'reparse', force: true });
    });
    $('#ctp_clear_chat').on('click', clearChatData);
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
}
