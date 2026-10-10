import { EXTRA_KEY } from './constants.js';
import { getWorkflowTemplate, prepareWorkflow, runWorkflow, saveImage } from './comfy.js';
import { buildParserPrompt, parserLabel, requestParse } from './parser.js';
import { activeParserPreset, findParserPreset, parseFixedFields, presetResolution } from './parserPresets.js';
import { buildImagePrompt, buildNegativePrompt } from './prompt.js';
import { effectiveComfy, renderProfileFor } from './renderProfiles.js';
import { findPresetById, presetForName, resolveTarget, settleAutoTarget } from './targets.js';
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
let imageAdded = () => {};

const FORCE_NOTE = '\n\n注意：用户手动要求为本楼出图。即使信息不足也不要输出 skip，请根据上下文合理推断。';

/**
 * The parser preset's fixed fields always win over what the model wrote, so e.g. a sprite keeps its pose.
 * @returns {{ parsed: object, forced: string[] }}
 */
function applyFixedFields(parsed, parserPreset) {
    const fixed = parseFixedFields(parserPreset?.fixedFields);
    return { parsed: { ...parsed, ...fixed }, forced: Object.keys(fixed) };
}

/** Builds the final prompt for a parse result; shared by real runs and the dry run. */
function promptFromParse(characterPreset, parsed, parserPrompt, notes) {
    const { parsed: final, forced } = applyFixedFields(parsed, parserPrompt.preset);
    if (forced.length) notes.push(`固定内容覆盖了：${forced.join(', ')}`);
    if (parserPrompt.mode === 'ai' && !final.prompt) {
        notes.push('解析模型没有返回 prompt 字段，已改用「固定外貌 + AI 补充」的模板拼接');
    }
    if (parserPrompt.preset?.allowOthers && final.others) notes.push('画面里有其他人物（others）');
    return {
        parsed: final,
        prompt: buildImagePrompt(characterPreset, final, { parserPreset: parserPrompt.preset, mode: parserPrompt.mode }),
    };
}

export function setRenderer(fn) {
    rerender = fn;
}

/** Called with the floor index after a new image was stored (the side panel shows it). */
export function setImageAddedHandler(fn) {
    imageAdded = fn;
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
            const parserPrompt = await buildParserPrompt(mesId, target);
            if (options.force) parserPrompt.user += FORCE_NOTE;
            data.debug.notes.push(...parserPrompt.notes);
            // Kept on failure for diagnosis; dropped after a success unless debug mode is on.
            data.debug.parserSystem = parserPrompt.system;
            data.debug.parserUser = parserPrompt.user;
            data.parser = parserLabel();
            data.parserRaw = '';
            data.parserReasoning = '';
            data.parserFinish = '';

            const started = performance.now();
            const { parsed } = await requestParse(parserPrompt.system, parserPrompt.user, signal, {
                onReply: reply => {
                    data.parserRaw = truncate(reply.content, 6000);
                    data.parserReasoning = truncate(reply.reasoning, 4000);
                    data.parserFinish = reply.finish || '';
                    log(`#${mesId} 解析输出`, reply);
                },
                onRetry: (attempt, max, error) => {
                    data.debug.notes.push(`解析第 ${attempt} 次失败，已自动重试：${truncate(errorMessage(error), 300)}`);
                    setStage(job, message, 'parsing', `解析失败，正在重试（${attempt}/${max}）…`);
                },
            });
            data.parserMs = Math.round(performance.now() - started);
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
            if (!target.preset) {
                data.debug.notes.push(`没有找到「${target.name}」的角色预设，固定外貌为空`);
            }
            const built = promptFromParse(target.preset, parsed, parserPrompt, data.debug.notes);
            data.parsed = built.parsed;
            data.prompt = built.prompt;
            data.negative = buildNegativePrompt(target.preset);
            data.parserPresetId = parserPrompt.preset.id;
            data.parserPresetName = parserPrompt.preset.name;
            data.promptMode = parserPrompt.mode;
        } else if (mode === 'edit') {
            data.prompt = String(options.prompt || '').trim();
            data.debug.notes.push('提示词由用户手动编辑');
        }
        data.skipped = null;
        if (!data.prompt) throw new Error('最终提示词为空');

        setStage(job, message, 'drawing', 'ComfyUI 生成中…');
        // presetId null = the target had no preset (e.g. a persona without one). Matching by name here would pick up
        // the {{user}} preset, whose name resolves to any persona. Only floors from older versions lack the id.
        const preset = data.presetId === null ? null : findPresetById(data.presetId) ?? presetForName(data.target);
        // The character's render profile swaps in its own model / LoRA / sampling settings.
        const profile = renderProfileFor(preset);
        const comfy = effectiveComfy(profile);
        if (profile) data.debug.notes.push(`渲染配置：${profile.name}（角色预设「${resolveMacros(preset.name)}」）`);
        else if (preset?.renderProfileId) data.debug.notes.push('角色预设选的渲染配置已被删除，使用默认 ComfyUI 设置');
        const fixedSeed = Number(comfy.seed);
        const seed = mode !== 'reroll' && fixedSeed >= 0 ? fixedSeed : randomSeed();
        // Resolution: the parser preset this floor was parsed with may override the global size.
        const presetSize = presetResolution(findParserPreset(data.parserPresetId) ?? activeParserPreset());
        const width = roundTo16(presetSize?.width ?? comfy.width, 832);
        const height = roundTo16(presetSize?.height ?? comfy.height, 1216);
        if (presetSize) data.debug.notes.push(`分辨率来自解析预设：${width}×${height}`);
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

        const template = await getWorkflowTemplate(comfy, profile);
        const { workflow, notes } = prepareWorkflow(template.text, values);
        data.debug.notes.push(...notes);
        data.params = {
            renderProfile: profile?.name || '',
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
        if (commit(message, job.swipeId, data) && (message.swipe_id ?? 0) === job.swipeId) {
            imageAdded(ctx().chat.indexOf(message));
        }
        log(`#${mesId} 完成`, data);
    } catch (error) {
        if (isAbortError(error)) {
            toastr.info('已取消配图');
            return;
        }
        console.error('[ComfyPortrait]', error);
        data.error = errorMessage(error);
        commit(message, job.swipeId, data);
        const where = job.stage === 'parsing' ? '（解析模型）' : job.stage === 'drawing' ? '（ComfyUI）' : '';
        toastr.error(truncate(data.error, 300), `配图失败${where}`);
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
    const parserPrompt = await buildParserPrompt(mesId, target);
    const { reply, parsed: raw } = await requestParse(parserPrompt.system, parserPrompt.user);
    if (target.auto && !raw.skip) target = settleAutoTarget(target, raw.target, message);
    const notes = [...parserPrompt.notes];
    const built = raw.skip ? { parsed: raw, prompt: '' } : promptFromParse(target.preset, raw, parserPrompt, notes);
    return {
        target,
        parserPrompt,
        reply,
        parsed: built.parsed,
        notes,
        prompt: built.prompt,
        negative: buildNegativePrompt(target.preset),
    };
}
