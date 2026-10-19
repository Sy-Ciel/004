/**
 * "编辑提示词后生成": edit a floor's prompt and draw it with an explicit seed, size and set of extras, so a result
 * can be reproduced, or compared with the same prompt and seed in ComfyUI's own template.
 */
import { MODEL_KREA2 } from './constants.js';
import { currentMode, floorMode, imageMode, modeLabel } from './modes.js';
import { enqueue, renderPlan } from './pipeline.js';
import { buildNegativePrompt } from './prompt.js';
import { ctx, escapeHtml, getMessageData } from './utils.js';

function intOrNull(value) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    const number = Number(text);
    return Number.isSafeInteger(number) && number >= 0 ? number : NaN;
}

function checkbox(name, label, checked) {
    return `<label class="checkbox_label"><input type="checkbox" data-edit="${name}" ${checked ? 'checked' : ''}> ${label}</label>`;
}

/**
 * @param {number} mesId
 * @param {number} [sceneArg] 多张图: the picture of the shown version to edit (-1 = the end of the floor). A version
 *   with several pictures always edits one of them (the end by default) and redraws only that one.
 */
export async function openEditDialog(mesId, sceneArg) {
    const message = ctx().chat[mesId];
    const data = getMessageData(message);
    const index = Math.max(0, data?.index ?? 0);
    const image = data?.images?.[index];
    const scene = Number.isInteger(sceneArg) ? sceneArg : image?.scenes?.length ? -1 : null;
    // The picture whose prompt, seed and size are filled in.
    const picture = scene !== null && scene >= 0 ? image?.scenes?.[scene] : image;
    if (scene !== null && !picture) {
        toastr.info('没有找到这一张图');
        return;
    }
    const pictureLabel = scene === null ? '' : scene >= 0 ? picture.label || `第 ${scene + 1} 段` : '结束时';
    // Edit choices of the other mode (its sizes, LoRA switches) do not carry over.
    const previous = data && floorMode(data) === currentMode() ? data.editOverrides ?? {} : {};
    // What would be used without any override, to describe the choices.
    const plan = renderPlan(data);
    const comfy = plan.comfy;
    const plain = renderPlan(data, { profile: false }).comfy;
    const sampling = settings => `${escapeHtml(settings.unet)} · ${settings.steps} 步 · CFG ${settings.cfg} · ${escapeHtml(settings.sampler)} / ${escapeHtml(settings.scheduler)}`;

    const extras = [];
    if (plan.preset?.lora) {
        extras.push(checkbox('charLora', `角色 LoRA：${escapeHtml(plan.preset.lora)} @ ${plan.charLoraStrength}（角色预设「${escapeHtml(plan.preset.name)}」）`, previous.charLora !== false));
    }
    if (comfy.lora) {
        extras.push(checkbox('styleLora', `风格 LoRA：${escapeHtml(comfy.lora)} @ ${plan.styleLoraStrength}`, previous.styleLora !== false));
    }
    if (plan.extraLoras.length) {
        extras.push(checkbox('extraLoras', `更多 LoRA：${escapeHtml(plan.extraLoras.map(lora => `${lora.name} @ ${lora.strength}`).join('、'))}`, previous.extraLoras !== false));
    }
    if (plan.boundProfile) {
        extras.push(checkbox('profile', `渲染配置「${escapeHtml(plan.boundProfile.name)}」（换掉模型、LoRA、采样）`, previous.profile !== false));
    }
    if (plan.upscale) {
        extras.push(checkbox('upscale', `放大：${escapeHtml(plan.upscale.model)} → ×${plan.upscale.factor}`, previous.upscale !== false));
    }
    // Only Krea 2's built-in workflow has the refine step.
    if (currentMode() === MODEL_KREA2) {
        extras.push(checkbox('refine', 'ComfyUI 端提示词扩写', typeof previous.refine === 'boolean' ? previous.refine : !!comfy.refinePrompt));
    }
    // The prompt shown is the selected version's, which may be an older picture of the other mode.
    const drawnIn = image ? imageMode(image) : data ? floorMode(data) : currentMode();
    const sameMode = drawnIn === currentMode();
    if (scene !== null && !sameMode) {
        toastr.warning(`这一版是 ${modeLabel(drawnIn)} 模式画的，切回 ${modeLabel(drawnIn)} 模式再单独重画`);
        return;
    }
    const modeNote = (!sameMode
        ? `<p class="ctp-warn">这一楼上次是 ${modeLabel(drawnIn)} 模式画的，下面的提示词是给 ${modeLabel(drawnIn)} 写的；这次会用 ${modeLabel()} 模式的模型、工作流和角色预设出图。</p>`
        : '') + (scene !== null
        ? `<p class="ctp-hint">这一版有 ${(image.scenes?.length ?? 0) + 1} 张图（多张图）。这里编辑「${escapeHtml(pictureLabel)}」这一张，生成后只重画这一张：新版本里其他几张照旧，原来的图在上一版。</p>`
        : '');

    const root = document.createElement('div');
    root.className = 'ctp-edit';
    root.innerHTML = `
        <h3>编辑 #${mesId}${scene !== null ? `「${escapeHtml(pictureLabel)}」这一张` : ''} 的提示词并重新生成 · ${modeLabel()} 模式</h3>
        ${modeNote}
        <textarea class="text_pole ctp-edit-prompt" rows="10"></textarea>
        <div class="ctp-row">
            <label>种子 <input type="number" class="text_pole" min="0" step="1" data-edit="seed" placeholder="留空 = 随机"></label>
            <label>宽 <input type="number" class="text_pole" min="256" step="16" data-edit="width"></label>
            <label>高 <input type="number" class="text_pole" min="256" step="16" data-edit="height"></label>
        </div>
        <label>反向提示词${currentMode() === MODEL_KREA2 ? '（内置 Krea 2 工作流 CFG 1，不使用反向提示词）' : ''}
            <input type="text" class="text_pole" data-edit="negative">
        </label>
        <small class="ctp-hint">默认填的是当前这张图的种子、尺寸和反向提示词。提示词和反向提示词原样发送，不会加任何前后缀。</small>
        <div class="ctp-edit-extras">${extras.join('')}</div>
        <small class="ctp-hint">模型和采样（「出图参数」）：${sampling(plain)}${plan.boundProfile ? `<br>勾选渲染配置时换成：${sampling(comfy)}` : ''}<br>
            想和 ComfyUI 官方 ${modeLabel()} 模板（${currentMode() === MODEL_KREA2 ? '关掉 LoRA、关掉扩写' : '不加 LoRA'}）出一样的图：提示词、${currentMode() === MODEL_KREA2 ? '' : '反向提示词、'}种子、尺寸填一样的，上面的勾全部去掉，并确认「出图参数」里的模型和采样和 ComfyUI 一致。</small>`;
    root.querySelector('.ctp-edit-prompt').value = picture?.prompt || data?.prompt || '';
    // Another model's negative prompt does not fit: then this mode's current one.
    root.querySelector('[data-edit="negative"]').value = sameMode ? picture?.negative ?? data?.negative ?? '' : buildNegativePrompt(plan.preset);
    root.querySelector('[data-edit="seed"]').value = Number.isFinite(picture?.seed) ? String(picture.seed) : '';
    root.querySelector('[data-edit="width"]').value = String(picture?.width || plan.width);
    root.querySelector('[data-edit="height"]').value = String(picture?.height || plan.height);

    const { callGenericPopup, POPUP_TYPE, POPUP_RESULT } = ctx();
    const result = await callGenericPopup(root, POPUP_TYPE.CONFIRM, '', { okButton: '生成', cancelButton: '取消', wide: true, allowVerticalScrolling: true });
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;

    const prompt = root.querySelector('.ctp-edit-prompt').value;
    if (!prompt.trim()) {
        toastr.info('提示词是空的');
        return;
    }
    const seed = intOrNull(root.querySelector('[data-edit="seed"]').value);
    const width = intOrNull(root.querySelector('[data-edit="width"]').value);
    const height = intOrNull(root.querySelector('[data-edit="height"]').value);
    if (Number.isNaN(seed) || Number.isNaN(width) || Number.isNaN(height)) {
        toastr.warning('种子、宽、高要填非负整数（种子太大会丢精度，最大 9007199254740991）');
        return;
    }
    const overrides = { seed, width: width || undefined, height: height || undefined };
    root.querySelectorAll('input[type="checkbox"][data-edit]').forEach(box => {
        overrides[box.dataset.edit] = box.checked;
    });
    const negative = root.querySelector('[data-edit="negative"]').value;
    // 多张图: only this picture is drawn again, into a copy of the version it belongs to.
    enqueue(mesId, { mode: 'edit', prompt, negative, overrides, ...(scene !== null ? { scene, version: index } : {}) });
}
