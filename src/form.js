/** Form helpers shared by the settings editors: path access, typed inputs and model pickers. */
import { LORA_NONE } from './constants.js';
import { ctx, escapeHtml, getSettings, saveSettings } from './utils.js';

export function getPath(object, path) {
    return path.split('.').reduce((value, key) => value?.[key], object);
}

export function setPath(object, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    const parent = keys.reduce((value, key) => (value[key] ??= {}), object);
    parent[last] = value;
}

export function readInput(element) {
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

export function writeInput(element, value) {
    if (element.type === 'checkbox') element.checked = !!value;
    else element.value = value ?? '';
}

/* ---------------- pickers (select + manual input, work on mobile unlike <datalist>) ---------------- */

const MANUAL = '__ctp_manual__';

/**
 * Pickers edit a settings path (data-picker="comfy.unet") or a field of the object an editor has open
 * (data-preset-picker="lora" → the selected character preset). Editors register that object here.
 * @type {Record<string, () => object | null>}
 */
const owners = {};

export function registerPickerOwner(datasetKey, getOwner) {
    owners[datasetKey] = getOwner;
}

function ownerField(select) {
    const key = Object.keys(owners).find(name => select.dataset[name]);
    return key ? { object: owners[key](), field: select.dataset[key] } : null;
}

function pickerItems(listName) {
    const settings = getSettings();
    if (listName === 'parserModels') return settings.parser.models || [];
    return settings.comfy.lists?.[listName] || [];
}

function readPicker(select) {
    if (select.dataset.picker) return String(getPath(getSettings(), select.dataset.picker) ?? '');
    const owner = ownerField(select);
    return String(owner?.object?.[owner.field] ?? '');
}

function writePicker(select, value) {
    if (select.dataset.picker) {
        setPath(getSettings(), select.dataset.picker, value);
        // Pickers that fall back to this setting show its value in their "default" option.
        document.querySelectorAll(`.ctp-settings select[data-inherit="${select.dataset.picker}"]`).forEach(renderPicker);
    } else {
        const owner = ownerField(select);
        if (!owner?.object) return;
        owner.object[owner.field] = value;
    }
    saveSettings();
}

export function renderPicker(select) {
    const value = readPicker(select);
    const items = pickerItems(select.dataset.list);
    const options = [];
    if (select.dataset.inherit) {
        // Override pickers: empty = use the default setting, LORA_NONE = explicitly nothing.
        const fallback = String(getPath(getSettings(), select.dataset.inherit) ?? '');
        options.push(['', `（默认：${fallback || '不使用'}）`]);
        if (select.dataset.none) options.push([LORA_NONE, '（不使用）']);
    } else if (select.dataset.none) {
        options.push(['', '（不使用）']);
    } else if (!value) {
        options.push(['', items.length ? '（请选择）' : '（列表为空，点「读取列表」或手动输入）']);
    }
    if (value && value !== LORA_NONE && !items.includes(value)) {
        options.push([value, items.length ? `${value}（当前值，不在列表里）` : value]);
    }
    for (const item of items) options.push([item, item]);
    options.push([MANUAL, '✏️ 手动输入…']);
    select.innerHTML = options.map(([v, label]) => `<option value="${escapeHtml(v)}">${escapeHtml(label)}</option>`).join('');
    select.value = value;
}

export function renderPickers(root = document.querySelector('.ctp-settings')) {
    root?.querySelectorAll('select[data-list]').forEach(renderPicker);
}

export function bindPickers(root) {
    root.querySelectorAll('select[data-list]').forEach(select => {
        select.addEventListener('change', async () => {
            if (select.value !== MANUAL) {
                writePicker(select, select.value);
                return;
            }
            const { callGenericPopup, POPUP_TYPE } = ctx();
            const typed = await callGenericPopup('手动输入（ComfyUI 里的文件名，含子文件夹路径和扩展名）', POPUP_TYPE.INPUT, readPicker(select));
            if (typeof typed === 'string') writePicker(select, typed.trim());
            renderPicker(select);
        });
        renderPicker(select);
    });
}
