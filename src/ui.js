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
import { callParser } from './parser.js';
import { enqueue } from './pipeline.js';
import { renderAll } from './render.js';
import { presetName } from './targets.js';
import { ctx, errorMessage, escapeHtml, getSettings, roundTo16, saveSettings, truncate } from './utils.js';

const SETTINGS_URL = new URL('../settings.html', import.meta.url);
const UI_WORKFLOW_URL = new URL('../workflows/krea2_turbo_t2i_lora_ui.json', import.meta.url);

let selectedPresetId = null;

function getPath(object, path) {
    return path.split('.').reduce((value, key) => value?.[key], object);
}

function setPath(object, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    const parent = keys.reduce((value, key) => (value[key] ??= {}), object);
    parent[last] = value;
}

function readInput(element) {
    const type = element.dataset.type;
    if (element.type === 'checkbox') return element.checked;
    if (type === 'int') {
        const number = parseInt(element.value, 10);
        return Number.isFinite(number) ? number : 0;
    }
    if (type === 'float') {
        const number = parseFloat(element.value);
        return Number.isFinite(number) ? number : 0;
    }
    return element.value;
}

function writeInput(element, value) {
    if (element.type === 'checkbox') element.checked = !!value;
    else element.value = value ?? '';
}

function fillDatalist(id, values) {
    const list = document.getElementById(id);
    if (!list) return;
    list.innerHTML = (values || []).map(value => `<option value="${escapeHtml(value)}"></option>`).join('');
}

function onSettingChanged(path) {
    if (path === 'debug' || path === 'imagePosition' || path === 'imageMaxWidth') renderAll();
    if (path === 'parser.source') updateSourceVisibility();
    if (path === 'comfy.workflowSource') updateWorkflowVisibility();
    if (path === 'comfy.width' || path === 'comfy.height') syncResolutionSelect();
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
    });
    syncResolutionSelect();
}

/* ---------------- target & presets ---------------- */

function presetLabel(preset) {
    const resolved = presetName(preset);
    return resolved && resolved !== preset.name ? `${preset.name} → ${resolved}` : (preset.name || '（未命名）');
}

export function refreshTargetSelect() {
    const settings = getSettings();
    const options = [
        `<option value="${TARGET_USER}">{{user}}（${escapeHtml(ctx().name1 || '用户')}）</option>`,
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

function loadPresetEditor() {
    const preset = currentPreset();
    $('#ctp_preset_editor').toggle(!!preset);
    if (!preset) return;
    document.querySelectorAll('#ctp_preset_editor [data-preset]').forEach(element => {
        writeInput(element, preset[element.dataset.preset]);
    });
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
        ...base,
    };
}

function sanitizePreset(raw) {
    const preset = newPreset();
    for (const key of Object.keys(preset)) {
        if (key === 'id') continue;
        if (raw?.[key] !== undefined) preset[key] = key === 'loraStrength' ? Number(raw[key]) || 0 : String(raw[key]);
    }
    return preset;
}

function initPresets() {
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
    });

    $('#ctp_preset_export').on('click', () => {
        const blob = new Blob([JSON.stringify({ type: 'comfy_portrait_presets', presets: getSettings().presets }, null, 2)], { type: 'application/json' });
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
            getSettings().presets.push(...imported);
            selectedPresetId = imported[0].id;
            saveSettings();
            refreshPresetSelect();
            toastr.success(`已导入 ${imported.length} 个角色预设`);
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
    fillDatalist('ctp_list_parser_models', ids);
    if (ids.length) toastr.success(`读取到 ${ids.length} 个模型，点模型输入框可选择`);
    else toastr.warning('没有读取到模型列表，可以直接手动填写模型名');
}

async function testParser() {
    toastr.info('正在请求解析模型…');
    const started = performance.now();
    try {
        const reply = await callParser('You are a JSON API. Reply with JSON only.', 'Reply exactly with {"ok": true}');
        const ms = Math.round(performance.now() - started);
        toastr.success(`${ms} ms：${truncate(reply, 120)}`, '解析模型可用');
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
    }
}

async function loadComfyLists() {
    toastr.info('正在读取 ComfyUI 模型列表…');
    try {
        const { lists, errors } = await fetchModelLists();
        fillDatalist('ctp_list_unet', lists.unet);
        fillDatalist('ctp_list_clip', lists.clip);
        fillDatalist('ctp_list_vae', lists.vae);
        fillDatalist('ctp_list_lora', lists.lora);
        fillDatalist('ctp_list_sampler', lists.sampler);
        fillDatalist('ctp_list_scheduler', lists.scheduler);
        const summary = `模型 ${lists.unet.length} · 编码器 ${lists.clip.length} · VAE ${lists.vae.length} · LoRA ${lists.lora.length}`;
        if (errors.length && !lists.lora.length) {
            toastr.warning(`${summary}\nLoRA/编码器列表需要浏览器直连（--enable-cors-header），也可以直接手填文件名`, '部分列表读取失败');
        } else {
            toastr.success(summary, '已读取，点输入框可选择');
        }
    } catch (error) {
        toastr.error(errorMessage(error), '读取失败');
    }
}

function validateWorkflow() {
    const text = getSettings().comfy.workflow;
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
    initResolution();
    initPresets();
    refreshPresetSelect();
    updateSourceVisibility();
    updateWorkflowVisibility();
    $('#ctp_workflow_ui_link').attr('href', UI_WORKFLOW_URL.href);

    $('#ctp_profile').on('change', function () {
        getSettings().parser.profileId = String($(this).val());
        saveSettings();
    });
    $('#ctp_profile_refresh').on('click', refreshProfiles);
    $('#ctp_parser_models').on('click', fetchParserModels);
    $('#ctp_parser_test').on('click', testParser);
    $('#ctp_comfy_test').on('click', testComfy);
    $('#ctp_comfy_models').on('click', loadComfyLists);
    $('#ctp_workflow_validate').on('click', validateWorkflow);
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
    refreshTargetSelect();
}
