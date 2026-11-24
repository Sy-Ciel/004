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
    // data-digits: a number shown with that many decimals, the way ComfyUI shows it (0.500)
    else if (element.dataset.digits && String(value ?? '').trim() !== '' && Number.isFinite(Number(value))) element.value = Number(value).toFixed(Number(element.dataset.digits));
    else element.value = value ?? '';
}

/* ---------------- pickers (select + manual input, work on mobile unlike <datalist>) ---------------- */

const MANUAL = '__ctp_manual__';
const FILTER_NOTE = '__ctp_filter_note__';

/** Lists long enough to want a 🔍 filter in front of their picker: models, LoRAs, the parser's models. */
const FILTERED_LISTS = new Set(['unet', 'clip', 'vae', 'lora', 'upscale', 'parserModels', 'plugModels']);

/** Lists of model names (not ComfyUI files): typed in by hand as a model's name. */
const MODEL_LISTS = new Set(['parserModels', 'plugModels']);

/**
 * Lists that are not kept in the settings (read from SillyTavern's page when shown): name → { items, empty }.
 * empty: the label of the empty choice, which then means something of its own (e.g. 「和正文一样」).
 * @type {Record<string, { items: () => string[], empty?: () => string }>}
 */
const lists = {};

export function registerPickerList(name, list) {
    lists[name] = list;
}

/**
 * Pickers edit a settings path (data-picker="comfy.unet") or a field of the object an editor has open
 * (data-charlora-picker="lora" → the character preset picked in 出图参数). Editors register that object here.
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
    if (lists[listName]) return lists[listName].items() ?? [];
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
    // After the value is written (a typed-in one too): for what shows the picker's value elsewhere.
    select.dispatchEvent(new CustomEvent('ctp-picked', { bubbles: true }));
}

/** The picker's list narrowed by its 🔍 filter: every word typed, in any case, in the name. */
function filteredItems(select) {
    const items = pickerItems(select.dataset.list);
    const words = String(select.ctpFilter?.value ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    return { items, words, shown: words.length ? items.filter(item => words.every(word => item.toLowerCase().includes(word))) : items };
}

export function renderPicker(select) {
    const value = readPicker(select);
    const { items, words, shown } = filteredItems(select);
    const options = [];
    const empty = lists[select.dataset.list]?.empty;
    if (empty) {
        options.push(['', empty()]);
    } else if (select.dataset.inherit) {
        // Override pickers: empty = use the default setting, LORA_NONE = explicitly nothing.
        const fallback = String(getPath(getSettings(), select.dataset.inherit) ?? '');
        options.push(['', `（默认：${fallback || '不使用'}）`]);
        if (select.dataset.none) options.push([LORA_NONE, '（不使用）']);
    } else if (select.dataset.none) {
        options.push(['', '（不使用）']);
    } else if (!value) {
        options.push(['', items.length ? '（请选择）' : '（列表为空，点「读取列表」或手动输入）']);
    }
    if (words.length) options.push([FILTER_NOTE, shown.length ? `🔍 匹配 ${shown.length} 个（共 ${items.length} 个）` : '🔍 没有匹配的，换个关键词', true]);
    if (value && value !== LORA_NONE && !items.includes(value)) {
        options.push([value, items.length ? `${value}（当前值，不在列表里）` : value]);
    } else if (value && value !== LORA_NONE && !shown.includes(value)) {
        // Filtered out: still the picker's value.
        options.push([value, value]);
    }
    for (const item of shown) options.push([item, item]);
    options.push([MANUAL, '✏️ 手动输入…']);
    select.innerHTML = options.map(([v, label, disabled]) => `<option value="${escapeHtml(v)}"${disabled ? ' disabled' : ''}>${escapeHtml(label)}</option>`).join('');
    select.value = value;
}

/**
 * 快速过滤: a small 🔍 box in front of a long list's picker. Typing narrows the list (words in any order and case);
 * Enter picks the only match left, or opens the list; Esc clears it. Picking clears it too.
 */
function addFilter(select) {
    if (select.ctpFilter || !FILTERED_LISTS.has(select.dataset.list)) return;
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'text_pole ctp-picker-filter';
    input.placeholder = '🔍 过滤';
    input.title = '输入关键词过滤下拉列表（不分大小写，空格隔开几个词）；回车：只剩一个时直接选上';
    const wrap = document.createElement('span');
    wrap.className = 'ctp-picker';
    select.before(wrap);
    wrap.append(input, select);
    select.ctpFilter = input;
    input.addEventListener('input', () => renderPicker(select));
    input.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            input.value = '';
            renderPicker(select);
            return;
        }
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const { words, shown } = filteredItems(select);
        if (words.length && shown.length === 1) {
            select.value = shown[0];
            input.value = '';
            select.dispatchEvent(new Event('change', { bubbles: true }));
            renderPicker(select);
            return;
        }
        select.focus();
        try {
            select.showPicker?.();
        } catch {
            // Not every browser opens a list from code; the focused list opens with a tap or the arrow keys.
        }
    });
}

export function renderPickers(root = document.querySelector('.ctp-settings')) {
    root?.querySelectorAll('select[data-list]').forEach(renderPicker);
}

export function bindPickers(root) {
    root.querySelectorAll('select[data-list]').forEach(select => {
        addFilter(select);
        select.addEventListener('change', async () => {
            if (select.value === FILTER_NOTE) return;
            if (select.value !== MANUAL) {
                writePicker(select, select.value);
                if (select.ctpFilter?.value) {
                    select.ctpFilter.value = '';
                    renderPicker(select);
                }
                return;
            }
            const { callGenericPopup, POPUP_TYPE } = ctx();
            const typed = await callGenericPopup(MODEL_LISTS.has(select.dataset.list) ? '手动输入模型名' : '手动输入（ComfyUI 里的文件名，含子文件夹路径和扩展名）', POPUP_TYPE.INPUT, readPicker(select));
            if (typeof typed === 'string') writePicker(select, typed.trim());
            renderPicker(select);
        });
        renderPicker(select);
    });
}
