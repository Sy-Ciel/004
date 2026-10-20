import { PARSED_FIELDS, STATE_FIELDS, normalizeMode } from './constants.js';
import { floorMode, imageMode, modeLabel } from './modes.js';
import { dryRun } from './pipeline.js';
import { buildParserPrompt } from './parser.js';
import { resolveTarget } from './targets.js';
import { ctx, errorMessage, escapeHtml, getMessageData, truncate } from './utils.js';

const FIELD_LABELS = {
    outfit: '服装',
    action: '动作',
    expression: '表情',
    demeanor: '神态',
    scene: '场景',
    camera: '镜头',
    lighting: '光线',
    others: '其他人物',
};

const STATE_LABELS = {
    now_doing: '此刻在做',
    now_wearing: '此刻穿着',
    pending: '还没做的事',
};

/** The parser's timeline analysis (what is done vs. only planned); empty when the model skipped it. */
function stateTable(parsed) {
    const rows = STATE_FIELDS.map(field => [`${STATE_LABELS[field]} (${field})`, parsed?.[field]]);
    const html = table(rows);
    return html ? `<p class="ctp-muted">时间线分析（只用来检查，不进提示词）</p>${html}` : '';
}

function block(title, content, { open = true, copy = true } = {}) {
    if (content === undefined || content === null || content === '') return '';
    const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    return `<details class="ctp-debug-block" ${open ? 'open' : ''}>
        <summary>${escapeHtml(title)}${copy ? ' <i class="fa-solid fa-copy ctp-copy" title="复制"></i>' : ''}</summary>
        <pre>${escapeHtml(text)}</pre>
    </details>`;
}

function table(rows) {
    const body = rows
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`)
        .join('');
    return body ? `<table class="ctp-debug-table">${body}</table>` : '';
}

function bindCopy(root) {
    root.querySelectorAll('.ctp-copy').forEach(icon => {
        icon.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            const text = icon.closest('details')?.querySelector('pre')?.textContent ?? '';
            try {
                await navigator.clipboard.writeText(text);
                toastr.success('已复制');
            } catch {
                toastr.warning('复制失败，请手动选择文本');
            }
        });
    });
}

async function showPopup(html) {
    const { callGenericPopup, POPUP_TYPE } = ctx();
    const root = document.createElement('div');
    root.className = 'ctp-debug';
    root.innerHTML = html;
    bindCopy(root);
    await callGenericPopup(root, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: '关闭' });
}

export async function showFloorDebug(mesId) {
    const message = ctx().chat[mesId];
    const data = getMessageData(message);
    if (!data) {
        toastr.info(`#${mesId} 没有配图数据`);
        return;
    }
    const index = Math.min(Math.max(0, data.index ?? 0), Math.max(0, (data.images?.length ?? 1) - 1));
    const image = data.images?.[index];
    const status = data.error ? `失败：${data.error}` : data.skipped ? `跳过：${data.skipped}` : '完成';
    const parsedRows = PARSED_FIELDS.map(field => [`${FIELD_LABELS[field]} (${field})`, data.parsed?.[field]]);
    const params = data.params || {};
    // The parameters are the latest run's; the selected version may be an older picture of the other mode.
    const paramsNote = image && data.params && imageMode(image) !== normalizeMode(params.modelMode)
        ? `（下面的模型和采样是最近一次出图的，${modeLabel(params.modelMode)} 模式；当前这张图是 ${modeLabel(imageMode(image))} 模式画的）`
        : '';

    const html = `
        <h3>#${mesId} 楼 · ${escapeHtml(message?.name || '')}</h3>
        ${table([
        ['状态', status],
        ['目标角色', data.target],
        ['画面主体', data.subject === 'nobody' ? '只画了场景（目标角色不在画面里，画面里也没有别人）' : data.subject === 'substitute' ? `改画「${data.target}」（目标角色不在画面里）` : ''],
        ['使用预设', data.fixed?.preset || '（无）'],
        ['解析模型', data.parser],
        ['解析预设', data.parserPresetName ? `${data.parserPresetName} · ${data.promptMode === 'ai' ? 'AI 写完整提示词' : '固定外貌 + AI 补充'}` : ''],
        ['解析用时', data.parserMs ? `${data.parserMs} ms` : ''],
        ['结束原因', data.parserFinish],
        ['出图用时', data.comfyMs ? `${data.comfyMs} ms` : ''],
        ['图片版本', data.images?.length ? `${index + 1} / ${data.images.length}` : '无'],
        ['插图位置', image?.place ? `「${image.place}」这句话后面（图片插在正文中间）` : ''],
    ])}
        ${data.debug?.notes?.length ? block('处理备注', data.debug.notes.join('\n'), { copy: false }) : ''}
        ${image?.scenes?.length ? block('多张图 · 每一段在正文里的开头 / 插图位置（图按它插进正文，找不到时几张图放在一起）', [...image.scenes.map(scene => `${scene.label}：开头「${scene.start || '（没有）'}」${scene.place ? `，插在「${scene.place}」后面` : ''}`), `结束时：开头「${image.start || '（没有）'}」${image.place ? `，插在「${image.place}」后面` : ''}`].join('\n'), { copy: false }) : ''}
        ${(image?.scenes ?? []).map(scene => block(`多张图 · 前面的一段「${scene.label}」（种子 ${scene.seed}）的提示词`, scene.prompt, { open: false })).join('')}
        ${image ? block(image.scenes?.length ? '结束时这一张使用的正向提示词' : '当前图片使用的正向提示词', image.prompt) : block('最终正向提示词', data.prompt)}
        ${block('ComfyUI 扩写后的提示词（实际用来出图的）', image ? image.refined : data.refinedPrompt)}
        ${block('反向提示词', image?.negative ?? data.negative)}
        <h4>① 固定部分（角色预设）</h4>
        ${table([['外貌', data.fixed?.appearance || '（空）'], ['触发词', data.fixed?.trigger]])}
        ${data.parsed?.prompt ? block('AI 写的完整提示词（prompt 字段）', data.parsed.prompt) : ''}
        ${data.parsed?.negative ? block('AI 写的 negative 字段（重复的、和正向提示词相同的标签已去掉，实际发送的见上方「反向提示词」）', data.parsed.negative) : ''}
        <h4>② AI 解析部分${data.error && data.parsed ? '（以下是最近一次成功的解析，本次失败的输出见下方「原始输出」）' : ''}</h4>
        ${stateTable(data.parsed)}
        ${table(parsedRows) || '<p class="ctp-muted">无</p>'}
        ${data.parser ? block('解析模型原始输出', data.parserRaw || '（空）', { open: !!data.error }) : ''}
        ${block('解析模型思考内容', data.parserReasoning, { open: false })}
        ${data.debug?.parserSystem ? block('解析模型 · System 提示词', data.debug.parserSystem, { open: false }) : ''}
        ${data.debug?.parserUser ? block('解析模型 · 输入（剧情上下文）', data.debug.parserUser, { open: false }) : ''}
        ${!data.debug?.parserUser ? '<p class="ctp-muted">提示：开启「调试模式」后生成的楼层会额外记录解析模型的完整输入和最终工作流（失败的楼层总会记录输入）。</p>' : ''}
        <h4>③ ComfyUI 参数${paramsNote}</h4>
        ${table([
        ['模型模式', modeLabel(image ? imageMode(image) : floorMode(data))],
        ['渲染配置', data.params ? params.renderProfile || '默认（ComfyUI 设置）' : ''],
        ['提示词扩写', params.refine ? 'ComfyUI 端扩写（和官方模板的 Refine Prompt 一样）' : ''],
        ['工作流', params.workflow],
        ['种子', image?.seed ?? params.seed],
        ['分辨率', image ? `${image.width} × ${image.height}` : (params.width ? `${params.width} × ${params.height}` : '')],
        ['宽高比', params.aspect],
        ['步数 / CFG', params.steps ? `${params.steps} / ${params.cfg}` : ''],
        ['采样器', params.sampler ? `${params.sampler} + ${params.scheduler}` : ''],
        ['扩散模型', params.unet],
        ['文本编码器', params.clip],
        ['VAE', params.vae],
        ['角色 LoRA', params.charLora || '（无）'],
        ['全局 LoRA', params.lora || '（无）'],
        ['更多 LoRA', params.extraLoras || '（无）'],
        ['LoRA 作用于', data.params ? (params.loraClip ? '模型 + 文本编码器（加载 LoRA）' : '仅模型') : ''],
        ['放大', params.upscale],
        ['跳层引导 (SLG)', params.slg],
        ['图片路径', image?.path || (image?.src?.startsWith('data:') ? 'base64 内嵌' : image?.src)],
    ])}
        ${data.debug?.workflow ? block('最终提交给 ComfyUI 的工作流 (API)', data.debug.workflow, { open: false }) : ''}
        ${data.error ? block('错误详情', data.error) : ''}
    `;
    await showPopup(html);
}

export async function showChatDebug() {
    const chat = ctx().chat;
    const rows = [];
    chat.forEach((message, mesId) => {
        const data = getMessageData(message);
        if (!data) return;
        const index = Math.min(Math.max(0, data.index ?? 0), Math.max(0, (data.images?.length ?? 1) - 1));
        const prompt = data.images?.[index]?.prompt || data.prompt || '';
        const status = data.error ? '❌ 失败' : data.skipped ? '⏭ 跳过' : data.images?.length ? `✅ ${data.images.length} 张` : '—';
        rows.push(`<tr>
            <td>#${mesId}</td>
            <td>${escapeHtml(message.name || '')}</td>
            <td>${escapeHtml(data.target || '')}</td>
            <td>${status}</td>
            <td class="ctp-prompt-cell">${escapeHtml(truncate(prompt || data.skipped || data.error || '', 220))}</td>
            <td><span class="menu_button ctp-floor-detail" data-mesid="${mesId}">详情</span></td>
        </tr>`);
    });

    const html = rows.length
        ? `<h3>本聊天各楼层配图提示词（${rows.length} 层）</h3>
           <table class="ctp-floor-table">
             <thead><tr><th>楼层</th><th>发言</th><th>目标</th><th>状态</th><th>提示词</th><th></th></tr></thead>
             <tbody>${rows.join('')}</tbody>
           </table>`
        : '<p>本聊天还没有任何配图数据。</p>';

    const { callGenericPopup, POPUP_TYPE } = ctx();
    const root = document.createElement('div');
    root.className = 'ctp-debug';
    root.innerHTML = html;
    root.querySelectorAll('.ctp-floor-detail').forEach(button => {
        button.addEventListener('click', () => showFloorDebug(Number(button.dataset.mesid)));
    });
    await callGenericPopup(root, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: '关闭' });
}

export function lastFloorId() {
    const chat = ctx().chat;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i].is_user && !chat[i].is_system) return i;
    }
    return chat.length - 1;
}

export async function showParserPreview() {
    const mesId = lastFloorId();
    if (mesId < 0) {
        toastr.info('当前没有聊天');
        return;
    }
    const target = resolveTarget(ctx().chat[mesId]);
    const prompt = await buildParserPrompt(mesId, target);
    await showPopup(`
        <h3>解析模型输入预览 · #${mesId}（不会发送请求）</h3>
        ${table([['目标', target.auto ? `自动（候选：${target.candidates.join('、')}）` : target.name], ['预设', target.preset ? target.preset.name : '（无）'], ['说明', prompt.notes.join('；')]])}
        ${block('System', prompt.system)}
        ${block('User', prompt.user)}
    `);
}

/**
 * 「发送前检查解析输入」: shows everything about to be sent to the parser for floor `mesId`, editable (for this
 * request only). Returns the { system, user } to send, or null when cancelled.
 */
export async function reviewParserInput(mesId, parserPrompt, target) {
    const root = document.createElement('div');
    root.className = 'ctp-debug ctp-review';
    root.innerHTML = `
        <h3>发送给解析模型前检查 · #${mesId} · ${escapeHtml(modeLabel())} 模式</h3>
        ${table([['目标', target?.auto ? `自动（候选：${(target.candidates || []).join('、')}）` : target?.name], ['预设', target?.preset ? target.preset.name : '（无）'], ['说明', parserPrompt.notes.filter(Boolean).join('；')]])}
        <small class="ctp-hint">下面就是这次要发给解析模型的全部内容：System 是规则，User 是剧情和参考资料（【当前楼层】一节就是读到的正文）。
        可以直接改，只对这一次生效；「发送」继续解析出图，「取消」= 这一楼这次不配图。不想每次都弹出，就在设置最上面关掉「发送前检查解析输入」。</small>
        <label>System（<span class="ctp-review-count" data-for="system"></span> 字）
            <textarea class="text_pole ctp-review-system" rows="10"></textarea>
        </label>
        <label>User（<span class="ctp-review-count" data-for="user"></span> 字）
            <textarea class="text_pole ctp-review-user" rows="16"></textarea>
        </label>`;
    const fields = { system: root.querySelector('.ctp-review-system'), user: root.querySelector('.ctp-review-user') };
    fields.system.value = parserPrompt.system;
    fields.user.value = parserPrompt.user;
    for (const [name, field] of Object.entries(fields)) {
        const count = root.querySelector(`.ctp-review-count[data-for="${name}"]`);
        const update = () => { count.textContent = String(field.value.length); };
        field.addEventListener('input', update);
        update();
    }
    const { callGenericPopup, POPUP_TYPE, POPUP_RESULT } = ctx();
    const result = await callGenericPopup(root, POPUP_TYPE.CONFIRM, '', { okButton: '发送', cancelButton: '取消', wide: true, large: true, allowVerticalScrolling: true });
    if (result !== POPUP_RESULT.AFFIRMATIVE) return null;
    return { system: fields.system.value, user: fields.user.value };
}

export async function showDryRun() {
    const mesId = lastFloorId();
    if (mesId < 0) {
        toastr.info('当前没有聊天');
        return;
    }
    toastr.info(`正在对 #${mesId} 试运行解析…`);
    try {
        const result = await dryRun(mesId);
        await showPopup(`
            <h3>试运行解析 · #${mesId}（不出图）</h3>
            ${table([['目标', result.target.name || '?'], ['预设', result.target.preset?.name || '（无）'], ['跳过', result.parsed.skip ? `是：${result.parsed.reason}` : '否'], ['结束原因', result.reply.finish], ['说明', result.notes.join('；')]])}
            ${result.scenes.map(scene => block(`前面的一段「${scene.label}」的提示词（多张图）`, scene.prompt)).join('')}
            ${block(result.scenes.length ? '结束时这一张的最终正向提示词' : '最终正向提示词', result.prompt)}
            ${result.parsed.prompt ? block('AI 写的完整提示词（prompt 字段）', result.parsed.prompt, { open: false }) : ''}
            ${block('反向提示词', result.negative)}
            ${result.parsed.negative ? block('AI 补充的反向提示词（negative 字段）', result.parsed.negative, { open: false }) : ''}
            ${stateTable(result.parsed)}
            ${table(PARSED_FIELDS.map(field => [`${FIELD_LABELS[field]} (${field})`, result.parsed[field]]))}
            ${block('解析模型原始输出', result.reply.content || '（空）')}
            ${block('解析模型思考内容', result.reply.reasoning, { open: false })}
            ${block('System', result.parserPrompt.system, { open: false })}
            ${block('User', result.parserPrompt.user, { open: false })}
        `);
    } catch (error) {
        toastr.error(errorMessage(error), '试运行失败');
    }
}
