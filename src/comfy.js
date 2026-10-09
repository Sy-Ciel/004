import { ctx, getSettings, sleep, truncate, withTimeout } from './utils.js';

const BUILTIN_WORKFLOW_URL = new URL('../workflows/krea2_turbo_t2i_lora_api.json', import.meta.url);
let builtinWorkflowCache = null;

export async function loadBuiltinWorkflow() {
    if (!builtinWorkflowCache) {
        const response = await fetch(BUILTIN_WORKFLOW_URL, { cache: 'no-cache' });
        if (!response.ok) throw new Error(`无法读取内置工作流 (${response.status})`);
        builtinWorkflowCache = await response.text();
    }
    return builtinWorkflowCache;
}

export async function getWorkflowTemplate() {
    const { comfy } = getSettings();
    if (comfy.workflowSource === 'custom' && comfy.workflow.trim()) {
        return { name: '自定义工作流', text: comfy.workflow };
    }
    return { name: '内置 Krea 2 Turbo 文生图 + LoRA', text: await loadBuiltinWorkflow() };
}

/** Parses a workflow in ComfyUI API format, rejecting the UI ("nodes"/"links") format with a helpful message. */
export function parseWorkflow(text) {
    let json;
    try {
        json = JSON.parse(text);
    } catch (error) {
        throw new Error(`工作流不是合法 JSON: ${error.message}`);
    }
    if (Array.isArray(json?.nodes) && Array.isArray(json?.links)) {
        throw new Error('这是 ComfyUI 的「UI 格式」工作流。请在 ComfyUI 中用 工作流 → 导出(API) 导出 API 格式后再粘贴');
    }
    if (json?.prompt && typeof json.prompt === 'object' && !json.class_type) {
        json = json.prompt;
    }
    const nodes = Object.entries(json || {});
    if (!nodes.length || !nodes.every(([, node]) => node && typeof node === 'object' && node.class_type)) {
        throw new Error('工作流格式不正确：应为 { "节点id": { "class_type": ..., "inputs": {...} } } 的 API 格式');
    }
    return json;
}

const isLink = value => Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isInteger(value[1]);

/** Replaces "%name%" placeholders. A string that is exactly one placeholder takes the raw (typed) value. */
function substitute(value, values) {
    if (typeof value === 'string') {
        const exact = value.match(/^%(\w+)%$/);
        if (exact && Object.hasOwn(values, exact[1])) return values[exact[1]];
        return value.replace(/%(\w+)%/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
    }
    if (Array.isArray(value)) return value.map(item => substitute(item, values));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, values)]));
    }
    return value;
}

/** Removes LoRA loader nodes whose lora name is empty and reconnects their consumers to the loader's inputs. */
function bypassEmptyLoras(workflow, notes) {
    let changed = true;
    while (changed) {
        changed = false;
        for (const [id, node] of Object.entries(workflow)) {
            const inputs = node.inputs || {};
            if (!('lora_name' in inputs)) continue;
            const name = inputs.lora_name;
            if (typeof name === 'string' && name.trim() && name.trim().toLowerCase() !== 'none') continue;
            if (isLink(name)) continue;

            // Output slot -> upstream link that should replace it
            const passthrough = { 0: inputs.model, 1: inputs.clip };
            for (const other of Object.values(workflow)) {
                for (const [key, value] of Object.entries(other.inputs || {})) {
                    if (isLink(value) && value[0] === id) {
                        const replacement = passthrough[value[1]];
                        if (!isLink(replacement)) throw new Error(`无法旁路 LoRA 节点 ${id}：缺少输入`);
                        other.inputs[key] = replacement;
                    }
                }
            }
            delete workflow[id];
            notes.push(`LoRA 节点 #${id}${node._meta?.title ? ` (${node._meta.title})` : ''} 未设置 LoRA，已自动旁路`);
            changed = true;
        }
    }
}

const TEXT_KEYS = ['text', 'prompt', 't5xxl', 'clip_l', 'clip_g', 'value', 'string'];
const SAMPLER_TYPES = ['KSampler', 'KSamplerAdvanced', 'SamplerCustom'];
const GUIDER_INPUTS = ['positive', 'conditioning'];

/** Follows conditioning links upstream until a node that holds prompt text is found. */
function findTextNode(workflow, link, depth = 0) {
    if (!isLink(link) || depth > 12) return null;
    const node = workflow[link[0]];
    if (!node) return null;
    const inputs = node.inputs || {};
    const textKey = TEXT_KEYS.find(key => key in inputs);
    if (textKey) {
        const value = inputs[textKey];
        // Text supplied by a primitive/string node
        if (isLink(value)) return findTextNode(workflow, value, depth + 1);
        return { id: link[0], key: textKey };
    }
    const next = ['conditioning', 'conditioning_1', 'positive'].map(key => inputs[key]).find(isLink);
    return findTextNode(workflow, next, depth + 1);
}

/**
 * For workflows without placeholders: writes prompt, negative, seed and size into the usual nodes.
 */
function autoInject(workflow, values, notes) {
    const entries = Object.entries(workflow);
    let positive = null;
    let negative = null;

    for (const [, node] of entries) {
        const inputs = node.inputs || {};
        if (SAMPLER_TYPES.includes(node.class_type)) {
            positive ??= findTextNode(workflow, inputs.positive);
            negative ??= findTextNode(workflow, inputs.negative);
        } else if (/Guider$/.test(node.class_type)) {
            const link = GUIDER_INPUTS.map(key => inputs[key]).find(isLink);
            positive ??= findTextNode(workflow, link);
            negative ??= findTextNode(workflow, inputs.negative);
        }
    }

    if (positive) {
        workflow[positive.id].inputs[positive.key] = values.prompt;
        notes.push(`自动注入：正向提示词 → 节点 #${positive.id}.${positive.key}`);
    } else {
        throw new Error('工作流中没有 %prompt% 占位符，也没能自动找到正向提示词节点');
    }
    if (negative && !(negative.id === positive.id && negative.key === positive.key)) {
        workflow[negative.id].inputs[negative.key] = values.negative_prompt;
        notes.push(`自动注入：反向提示词 → 节点 #${negative.id}.${negative.key}`);
    }

    for (const [id, node] of entries) {
        const inputs = node.inputs || {};
        for (const key of ['seed', 'noise_seed']) {
            if (typeof inputs[key] === 'number') {
                inputs[key] = values.seed;
                notes.push(`自动注入：种子 → 节点 #${id}.${key}`);
            }
        }
        if (/^Empty.*Latent/i.test(node.class_type) && typeof inputs.width === 'number' && typeof inputs.height === 'number') {
            inputs.width = values.width;
            inputs.height = values.height;
            notes.push(`自动注入：分辨率 → 节点 #${id}`);
        }
    }
}

/**
 * Turns a workflow template into a ready-to-queue workflow.
 * @param {string} templateText Workflow in API format, optionally containing %placeholders%
 * @param {Record<string, any>} values Placeholder values
 */
export function prepareWorkflow(templateText, values) {
    const notes = [];
    const template = parseWorkflow(templateText);
    const usesPlaceholders = /%prompt%/.test(templateText);
    const workflow = substitute(template, values);
    if (!usesPlaceholders) {
        autoInject(workflow, values, notes);
    }
    bypassEmptyLoras(workflow, notes);

    const leftovers = [...new Set(JSON.stringify(workflow).match(/%\w+%/g) || [])];
    if (leftovers.length) {
        notes.push(`未识别的占位符（原样保留）：${leftovers.join(', ')}`);
    }
    return { workflow, notes };
}

function comfyBase() {
    const url = getSettings().comfy.url.trim().replace(/\/+$/, '');
    if (!url) throw new Error('未填写 ComfyUI 地址');
    return url;
}

function formatComfyError(text) {
    try {
        const json = JSON.parse(text);
        const lines = [];
        if (json.error) lines.push(json.error.message || JSON.stringify(json.error), json.error.details || '');
        for (const [id, info] of Object.entries(json.node_errors || {})) {
            for (const error of info.errors || []) {
                lines.push(`#${id} ${info.class_type}: ${error.message} ${error.details || ''}`);
            }
        }
        return lines.filter(Boolean).join('\n') || text;
    } catch {
        return truncate(text, 1000);
    }
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

async function generateViaProxy(workflow, signal) {
    const response = await fetch('/api/sd/comfy/generate', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({
            url: comfyBase(),
            prompt: JSON.stringify({ prompt: workflow, client_id: `st-comfy-portrait-${Date.now()}` }),
        }),
        signal,
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`ComfyUI 生成失败: ${truncate(text, 1500)}（想看节点级报错可切换为「浏览器直连」模式）`);
    }
    const body = await response.text();
    try {
        const { format, data } = JSON.parse(body);
        return { format: format || 'png', data };
    } catch {
        // Very old SillyTavern returned the bare base64 string
        return { format: 'png', data: body };
    }
}

async function generateDirect(workflow, signal, onStatus) {
    const base = comfyBase();
    const response = await fetch(`${base}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: workflow, client_id: `st-comfy-portrait-${Date.now()}` }),
        signal,
    });
    if (!response.ok) {
        throw new Error(`ComfyUI 拒绝了工作流:\n${formatComfyError(await response.text())}`);
    }
    const { prompt_id: promptId } = await response.json();
    const interrupt = () => fetch(`${base}/interrupt`, { method: 'POST' }).catch(() => {});
    signal.addEventListener('abort', interrupt, { once: true });

    try {
        let item = null;
        let polls = 0;
        while (!item) {
            await sleep(polls++ < 5 ? 500 : 1000, signal);
            const history = await fetch(`${base}/history/${promptId}`, { signal });
            if (!history.ok) throw new Error(`读取 ComfyUI 历史失败 (${history.status})`);
            item = (await history.json())[promptId] ?? null;
            if (!item && polls % 5 === 0) {
                onStatus?.(`ComfyUI 生成中…（${Math.round(polls * 0.9)} 秒）`);
            }
        }
        if (item.status?.status_str === 'error') {
            const details = (item.status.messages || [])
                .filter(entry => entry[0] === 'execution_error')
                .map(entry => `${entry[1].node_type} [#${entry[1].node_id}] ${entry[1].exception_type}: ${entry[1].exception_message}`)
                .join('\n');
            throw new Error(`ComfyUI 执行出错\n${details}`.trim());
        }
        const images = Object.values(item.outputs || {}).flatMap(output => output.images || []);
        const image = images.find(img => img.type === 'output') ?? images[0];
        if (!image) throw new Error('ComfyUI 没有输出图片（工作流里需要 SaveImage 或 PreviewImage 节点）');

        const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || '', type: image.type || 'output' });
        const view = await fetch(`${base}/view?${query}`, { signal });
        if (!view.ok) throw new Error(`下载 ComfyUI 图片失败 (${view.status})`);
        const blob = await view.blob();
        const format = (image.filename.split('.').pop() || 'png').toLowerCase();
        return { format, data: await blobToBase64(blob) };
    } finally {
        signal.removeEventListener('abort', interrupt);
    }
}

/**
 * Queues a workflow and waits for the first output image.
 * @returns {Promise<{format: string, data: string}>} base64 image
 */
export async function runWorkflow(workflow, parentSignal, onStatus) {
    const { comfy } = getSettings();
    const { signal, dispose } = withTimeout(parentSignal, Number(comfy.timeoutSec) || 0);
    try {
        return comfy.mode === 'direct'
            ? await generateDirect(workflow, signal, onStatus)
            : await generateViaProxy(workflow, signal);
    } catch (error) {
        if (signal.aborted && signal.reason instanceof Error) throw signal.reason;
        if (error instanceof TypeError && comfy.mode === 'direct') {
            throw new Error(`无法连接 ComfyUI（${error.message}）。直连模式需要用 --enable-cors-header 启动 ComfyUI，或者改用「酒馆后端代理」模式`);
        }
        throw error;
    } finally {
        dispose();
    }
}

export async function testConnection() {
    const { comfy } = getSettings();
    if (comfy.mode === 'direct') {
        const response = await fetch(`${comfyBase()}/system_stats`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const stats = await response.json();
        return `ComfyUI ${stats?.system?.comfyui_version ?? ''}`.trim();
    }
    const response = await fetch('/api/sd/comfy/ping', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ url: comfyBase() }),
    });
    if (!response.ok) throw new Error(`酒馆后端无法连接 ComfyUI (${response.status})`);
    return 'ComfyUI 已连接（经酒馆后端）';
}

async function objectInfo(nodeType) {
    const response = await fetch(`${comfyBase()}/object_info/${nodeType}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    return json?.[nodeType]?.input?.required ?? {};
}

async function proxyList(endpoint) {
    const response = await fetch(`/api/sd/comfy/${endpoint}`, {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ url: comfyBase() }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
}

/**
 * Reads model / sampler lists from ComfyUI. Direct requests give everything (when CORS allows);
 * the SillyTavern proxy only exposes diffusion models, VAEs, samplers and schedulers.
 */
export async function fetchModelLists() {
    const lists = { unet: [], clip: [], vae: [], lora: [], sampler: [], scheduler: [] };
    const errors = [];
    try {
        const [unet, clip, vae, lora, sampler] = await Promise.all([
            objectInfo('UNETLoader'), objectInfo('CLIPLoader'), objectInfo('VAELoader'), objectInfo('LoraLoaderModelOnly'), objectInfo('KSampler'),
        ]);
        lists.unet = unet.unet_name?.[0] ?? [];
        lists.clip = clip.clip_name?.[0] ?? [];
        lists.vae = vae.vae_name?.[0] ?? [];
        lists.lora = lora.lora_name?.[0] ?? [];
        lists.sampler = sampler.sampler_name?.[0] ?? [];
        lists.scheduler = sampler.scheduler?.[0] ?? [];
        return { lists, errors };
    } catch (error) {
        errors.push(`直连 object_info 失败: ${error.message}`);
    }
    const attempts = {
        unet: async () => (await proxyList('models')).filter(m => String(m.text).startsWith('UNet:') || String(m.text).startsWith('GGUF:')).map(m => m.value),
        vae: async () => await proxyList('vaes'),
        sampler: async () => await proxyList('samplers'),
        scheduler: async () => await proxyList('schedulers'),
    };
    for (const [key, attempt] of Object.entries(attempts)) {
        try {
            lists[key] = await attempt();
        } catch (error) {
            errors.push(`代理读取 ${key} 失败: ${error.message}`);
        }
    }
    return { lists, errors };
}

/** Saves the image under SillyTavern's user/images so the chat file only keeps a short path. */
export async function saveImage(image, folder, fileName) {
    const response = await fetch('/api/images/upload', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({
            image: image.data,
            format: image.format,
            ch_name: folder,
            filename: String(fileName).replace(/\./g, '_'),
        }),
    });
    if (!response.ok) {
        let reason = `HTTP ${response.status}`;
        try {
            reason = (await response.json()).error || reason;
        } catch {
            // keep status
        }
        throw new Error(`保存图片失败: ${reason}`);
    }
    return (await response.json()).path;
}
