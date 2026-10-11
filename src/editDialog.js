/**
 * "编辑提示词后生成": edit a floor's prompt and draw it with an explicit seed, size and set of extras, so a result
 * can be reproduced, or compared with the same prompt and seed in ComfyUI's own template.
 */
import { enqueue, renderPlan } from './pipeline.js';
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

export async function openEditDialog(mesId) {
    const message = ctx().chat[mesId];
    const data = getMessageData(message);
    const index = Math.max(0, data?.index ?? 0);
    const image = data?.images?.[index];
    const previous = data?.editOverrides ?? {};
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
    if (plan.boundProfile) {
        extras.push(checkbox('profile', `渲染配置「${escapeHtml(plan.boundProfile.name)}」（换掉模型、LoRA、采样）`, previous.profile !== false));
    }
    extras.push(checkbox('refine', 'ComfyUI 端提示词扩写', typeof previous.refine === 'boolean' ? previous.refine : !!comfy.refinePrompt));

    const root = document.createElement('div');
    root.className = 'ctp-edit';
    root.innerHTML = `
        <h3>编辑 #${mesId} 的提示词并重新生成</h3>
        <textarea class="text_pole ctp-edit-prompt" rows="10"></textarea>
        <div class="ctp-row">
            <label>种子 <input type="number" class="text_pole" min="0" step="1" data-edit="seed" placeholder="留空 = 随机"></label>
            <label>宽 <input type="number" class="text_pole" min="256" step="16" data-edit="width"></label>
            <label>高 <input type="number" class="text_pole" min="256" step="16" data-edit="height"></label>
        </div>
        <small class="ctp-hint">默认填的是当前这张图的种子和尺寸。提示词原样发送，不会加任何前后缀。</small>
        <div class="ctp-edit-extras">${extras.join('')}</div>
        <small class="ctp-hint">模型和采样（「出图参数」）：${sampling(plain)}${plan.boundProfile ? `<br>勾选渲染配置时换成：${sampling(comfy)}` : ''}<br>
            想和 ComfyUI 官方模板（关掉 LoRA、关掉扩写）出一样的图：提示词、种子、尺寸填一样的，上面的勾全部去掉，并确认「出图参数」里的模型和采样和 ComfyUI 一致。</small>`;
    root.querySelector('.ctp-edit-prompt').value = image?.prompt || data?.prompt || '';
    root.querySelector('[data-edit="seed"]').value = Number.isFinite(image?.seed) ? String(image.seed) : '';
    root.querySelector('[data-edit="width"]').value = String(image?.width || plan.width);
    root.querySelector('[data-edit="height"]').value = String(image?.height || plan.height);

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
    enqueue(mesId, { mode: 'edit', prompt, overrides });
}
