import { EXTRA_KEY } from './constants.js';
import { getWorkflowTemplate, prepareWorkflow, runWorkflow, saveImage } from './comfy.js';
import { buildParserPrompt, callParser, parseParserReply, parserLabel } from './parser.js';
import { buildImagePrompt, buildNegativePrompt } from './prompt.js';
import { findPresetById, findPresetByName, resolveTarget, settleAutoTarget } from './targets.js';
import {
    ctx,
    errorMessage,
    getSettings,
    isAbortError,
    log,
    randomSeed,
    resolveMacros,
    roundTo16,
    setMessageData,
    toSrc,
    truncate,
    warn,
} from './utils.js';

/** In-flight jobs, keyed by the chat message object so index shifts cannot misplace results. */
const jobs = new WeakMap();
const activeJobs = new Set();
let queue = Promise.resolve();
let rerender = () => {};

const FORCE_NOTE = '\n\n注意：用户手动要求为本楼出图。即使信息不足也不要输出 skip，请根据上下文合理推断。';

export function setRenderer(fn) {
    rerender = fn;
}

export function getJob(message) {
    return jobs.get(message) ?? null;
}

export function cancelJob(message) {
    jobs.get(message)?.controller.abort();
}

export function cancelAllJobs() {
    for (const job of activeJobs) job.controller.abort();
}

function render(message) {
    const index = ctx().chat.indexOf(message);
    if (index >= 0) rerender(index);
}

function setStage(job, message, stage, text) {
    job.stage = stage;
    job.text = text;
    render(message);
}

function swipeData(message, swipeId) {
    if ((message.swipe_id ?? 0) === swipeId) return message.extra?.[EXTRA_KEY] ?? null;
    return message.swipe_info?.[swipeId]?.extra?.[EXTRA_KEY] ?? null;
}

function commit(message, swipeId, data) {
    if (ctx().chat.indexOf(message) < 0) {
        warn('楼层已不在当前聊天中，丢弃结果');
        return false;
    }
    data.updatedAt = Date.now();
    setMessageData(message, swipeId, data);
    ctx().saveChat();
    return true;
}

function imageFolder() {
    const { name2, groupId, groups } = ctx();
    const group = groupId ? groups?.find(g => g.id === groupId) : null;
    return String(group?.name || name2 || 'ComfyPortrait').replace(/[\\/:*?"<>|]/g, '_');
}

/**
 * Queues image generation for a floor.
 * @param {number} mesId Floor index
 * @param {object} [options]
 * @param {'reparse'|'reroll'|'edit'} [options.mode='reparse'] reparse = ask the parser again; reroll = same prompt, new seed; edit = use options.prompt
 * @param {string} [options.target] Target override
 * @param {string} [options.prompt] Prompt for edit mode
 * @param {boolean} [options.force] Tell the parser not to skip
 */
export function enqueue(mesId, options = {}) {
    const message = ctx().chat[mesId];
    if (!message) return Promise.resolve();
    if (jobs.has(message)) {
        toastr.info(`#${mesId} 正在生成中`);
        return Promise.resolve();
    }
    const job = {
        controller: new AbortController(),
        swipeId: message.swipe_id ?? 0,
        stage: 'queued',
        text: '排队中…',
    };
    jobs.set(message, job);
    activeJobs.add(job);
    render(message);
    queue = queue.then(() => runJob(message, job, options)).catch(error => warn(error));
    return queue;
}

async function runJob(message, job, options) {
    const settings = getSettings();
    const signal = job.controller.signal;
    const previous = swipeData(message, job.swipeId);
    const data = previous ? structuredClone(previous) : { v: 1, images: [], index: 0 };
    data.images ??= [];
    const mode = options.mode === 'edit' || options.mode === 'reroll' ? options.mode : 'reparse';

    try {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const mesId = ctx().chat.indexOf(message);
        if (mesId < 0) return;

        data.error = null;
        data.debug = { ...(data.debug || {}), notes: [] };

        if (mode === 'reparse' || !data.prompt) {
            setStage(job, message, 'parsing', '正在解析角色状态…');
            let target = resolveTarget(message, options.target);
            const applyTarget = resolved => {
                data.target = resolved.auto ? '' : resolved.name;
                data.presetId = resolved.preset?.id ?? null;
                data.fixed = {
                    appearance: resolveMacros(resolved.preset?.appearance || ''),
                    trigger: resolveMacros(resolved.preset?.trigger || ''),
                    preset: resolved.preset ? resolveMacros(resolved.preset.name) : '',
                };
            };
            // Recorded before the request so a failed floor still shows who it was for.
            applyTarget(target);
            const parserPrompt = buildParserPrompt(mesId, target);
            if (options.force) parserPrompt.user += FORCE_NOTE;
            // Kept on failure for diagnosis; dropped after a success unless debug mode is on.
            data.debug.parserSystem = parserPrompt.system;
            data.debug.parserUser = parserPrompt.user;
            data.parser = parserLabel();
            data.parserRaw = '';
            data.parserReasoning = '';
            data.parserFinish = '';

            const started = performance.now();
            const reply = await callParser(parserPrompt.system, parserPrompt.user, signal);
            data.parserMs = Math.round(performance.now() - started);
            data.parserRaw = truncate(reply.content, 6000);
            data.parserReasoning = truncate(reply.reasoning, 4000);
            data.parserFinish = reply.finish || '';
            log(`#${mesId} 解析输出`, reply);

            const parsed = parseParserReply(reply);
            if (!settings.debug) {
                delete data.debug.parserSystem;
                delete data.debug.parserUser;
            }
            if (parsed.skip && !options.force) {
                data.skipped = parsed.reason || '解析模型判断本楼无需出图';
                commit(message, job.swipeId, data);
                log(`#${mesId} 跳过:`, data.skipped);
                return;
            }
            if (target.auto) {
                target = settleAutoTarget(target, parsed.target, message);
                applyTarget(target);
            }
            data.parsed = parsed;
            if (!target.preset) {
                data.debug.notes.push(`没有找到「${target.name}」的角色预设，固定外貌为空`);
            }
            data.prompt = buildImagePrompt(target.preset, parsed);
            data.negative = buildNegativePrompt(target.preset);
        } else if (mode === 'edit') {
            data.prompt = String(options.prompt || '').trim();
            data.debug.notes.push('提示词由用户手动编辑');
        }
        data.skipped = null;
        if (!data.prompt) throw new Error('最终提示词为空');

        setStage(job, message, 'drawing', 'ComfyUI 生成中…');
        const preset = findPresetById(data.presetId) ?? findPresetByName(data.target);
        const { comfy } = settings;
        const fixedSeed = Number(comfy.seed);
        const seed = mode !== 'reroll' && fixedSeed >= 0 ? fixedSeed : randomSeed();
        const width = roundTo16(comfy.width, 832);
        const height = roundTo16(comfy.height, 1216);
        const values = {
            prompt: data.prompt,
            negative_prompt: data.negative || '',
            width,
            height,
            seed,
            steps: Number(comfy.steps) || 8,
            cfg: Number(comfy.cfg) || 1,
            scale: Number(comfy.cfg) || 1,
            sampler: comfy.sampler || 'euler',
            scheduler: comfy.scheduler || 'simple',
            denoise: 1,
            unet: comfy.unet,
            model: comfy.unet,
            clip: comfy.clip,
            vae: comfy.vae,
            lora: comfy.lora || '',
            lora_strength: Number(comfy.loraStrength) || 0,
            char_lora: preset?.lora || '',
            char_lora_strength: Number(preset?.loraStrength) || 0,
            filename_prefix: comfy.filenamePrefix || 'ST_portrait',
            batch_size: 1,
        };

        const template = await getWorkflowTemplate();
        const { workflow, notes } = prepareWorkflow(template.text, values);
        data.debug.notes.push(...notes);
        data.params = {
            workflow: template.name,
            seed,
            width,
            height,
            steps: values.steps,
            cfg: values.cfg,
            sampler: values.sampler,
            scheduler: values.scheduler,
            unet: values.unet,
            clip: values.clip,
            vae: values.vae,
            lora: values.lora ? `${values.lora} @ ${values.lora_strength}` : '',
            charLora: values.char_lora ? `${values.char_lora} @ ${values.char_lora_strength}` : '',
        };
        if (settings.debug) data.debug.workflow = workflow;
        else delete data.debug.workflow;

        const started = performance.now();
        const image = await runWorkflow(workflow, signal, text => setStage(job, message, 'drawing', text));
        data.comfyMs = Math.round(performance.now() - started);

        let src;
        let path = '';
        try {
            path = await saveImage(image, imageFolder(), `ctp_${Date.now()}`);
            src = toSrc(path);
        } catch (error) {
            warn(error);
            src = `data:image/${image.format};base64,${image.data}`;
            data.debug.notes.push(`${error.message}，图片改为 base64 内嵌在聊天记录中`);
        }

        data.images.push({ src, path, seed, width, height, prompt: data.prompt, negative: data.negative || '', time: Date.now() });
        const maxVersions = Math.max(1, Number(settings.maxVersions) || 10);
        while (data.images.length > maxVersions) data.images.shift();
        data.index = data.images.length - 1;
        commit(message, job.swipeId, data);
        log(`#${mesId} 完成`, data);
    } catch (error) {
        if (isAbortError(error)) {
            toastr.info('已取消配图');
            return;
        }
        console.error('[ComfyPortrait]', error);
        data.error = errorMessage(error);
        commit(message, job.swipeId, data);
        toastr.error(truncate(data.error, 300), 'ComfyUI 配图失败');
    } finally {
        jobs.delete(message);
        activeJobs.delete(job);
        render(message);
    }
}

/** Dry run for the debug panel: calls the parser and builds the prompt, but does not draw. */
export async function dryRun(mesId, targetOverride) {
    const message = ctx().chat[mesId];
    if (!message) throw new Error(`没有 #${mesId} 楼`);
    let target = resolveTarget(message, targetOverride);
    const parserPrompt = buildParserPrompt(mesId, target);
    const reply = await callParser(parserPrompt.system, parserPrompt.user);
    const parsed = parseParserReply(reply);
    if (target.auto && !parsed.skip) target = settleAutoTarget(target, parsed.target, message);
    return {
        target,
        parserPrompt,
        reply,
        parsed,
        prompt: parsed.skip ? '' : buildImagePrompt(target.preset, parsed),
        negative: buildNegativePrompt(target.preset),
    };
}
