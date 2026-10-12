import { EXTRA_KEY, modeDefaults } from './constants.js';
import { addExtraLoras, getWorkflowTemplate, prepareWorkflow, runWorkflow, saveImage } from './comfy.js';
import { currentMode, floorMode, modeLabel } from './modes.js';
import { buildParserPrompt, parserLabel, requestParse } from './parser.js';
import { activeParserPreset, findParserPreset, parseFixedFields, presetResolution } from './parserPresets.js';
import { buildImagePrompt, buildNegativePrompt, finishPrompt } from './prompt.js';
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

export function hasActiveJobs() {
    return activeJobs.size > 0;
}

/** Thrown when the image model mode changed while a job or dry run was waiting; nothing is written. */
function modeChangedError() {
    const error = new DOMException('Image model mode changed', 'AbortError');
    error.modeChanged = true;
    return error;
}

function assertMode(mode) {
    if (currentMode() !== mode) throw modeChangedError();
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
 * @param {string} [options.negative] Negative prompt for edit mode (default: the floor's)
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

/**
 * The character preset a floor is drawn with. Presets are per image model mode and both modes have one with the
 * id 'user', so a floor drawn in the other mode is matched by its character's name in the active mode instead.
 */
function floorPreset(data) {
    if (data && floorMode(data) !== currentMode()) return data.target ? presetForName(data.target) : null;
    // presetId null = the target had no preset (e.g. a persona without one). Matching by name here would pick up
    // the {{user}} preset, whose name resolves to any persona. Only floors from older versions lack the id.
    return data?.presetId === null ? null : findPresetById(data?.presetId) ?? presetForName(data?.target);
}

/**
 * What a floor will be drawn with: its character preset, that preset's render profile, the resulting ComfyUI
 * settings, size and LoRAs. `overrides` come from the edit dialog: seed, size, and whether to use the character
 * LoRA, the style LoRA, the render profile and the ComfyUI-side refine step.
 */
export function renderPlan(data, overrides = null) {
    const preset = floorPreset(data);
    const boundProfile = renderProfileFor(preset);
    const profile = overrides?.profile === false ? null : boundProfile;
    let comfy = effectiveComfy(profile);
    if (typeof overrides?.refine === 'boolean') comfy = { ...comfy, refinePrompt: overrides.refine };
    // Resolution: the edit dialog, else the parser preset this floor was parsed with, else the global size.
    const presetSize = presetResolution(findParserPreset(data?.parserPresetId) ?? activeParserPreset());
    const defaults = modeDefaults(currentMode()).comfy;
    const width = roundTo16(overrides?.width || presetSize?.width || comfy.width, defaults.width);
    const height = roundTo16(overrides?.height || presetSize?.height || comfy.height, defaults.height);
    return {
        preset,
        profile,
        boundProfile,
        comfy,
        width,
        height,
        sizeFromPreset: !overrides?.width && !!presetSize,
        charLora: overrides?.charLora === false ? '' : preset?.lora || '',
        charLoraStrength: Number(preset?.loraStrength) || 0,
        styleLora: overrides?.styleLora === false ? '' : comfy.lora || '',
        styleLoraStrength: Number(comfy.loraStrength) || 0,
        // "更多 LoRA": the ones for every picture plus this character's.
        extraLoras: overrides?.extraLoras === false ? [] : extraLorasFor(preset),
        loraClip: !!getSettings().comfy.loraClip,
    };
}

/** The "更多 LoRA" entries used for a character preset (entries for every picture and the preset's own). */
export function extraLorasFor(preset) {
    return (getSettings().comfy.extraLoras || [])
        .filter(lora => String(lora?.name || '').trim() && lora.enabled !== false && (!lora.presetId || lora.presetId === preset?.id))
        .map(lora => ({ name: String(lora.name).trim(), strength: Number(lora.strength) || 0 }));
}

/** Every LoRA a plan uses, in order, as "name @ strength" lines (for the summary and the debug view). */
export function planLoraLines(plan) {
    return [
        plan.charLora ? `角色 LoRA：${plan.charLora} @ ${plan.charLoraStrength}` : '',
        plan.styleLora ? `风格 LoRA：${plan.styleLora} @ ${plan.styleLoraStrength}` : '',
        ...plan.extraLoras.map(lora => `更多 LoRA：${lora.name} @ ${lora.strength}`),
    ].filter(Boolean);
}

function describeOverrides(overrides) {
    const parts = [];
    if (Number.isFinite(overrides.seed)) parts.push(`种子 ${overrides.seed}`);
    if (overrides.width && overrides.height) parts.push(`${overrides.width}×${overrides.height}`);
    if (overrides.charLora === false) parts.push('不加角色 LoRA');
    if (overrides.styleLora === false) parts.push('不加风格 LoRA');
    if (overrides.extraLoras === false) parts.push('不加更多 LoRA');
    if (overrides.profile === false) parts.push('不用渲染配置');
    if (overrides.refine === false) parts.push('不扩写');
    if (overrides.refine === true) parts.push('ComfyUI 端扩写');
    return parts.length ? `按编辑窗口的设置出图：${parts.join('、')}` : '';
}

/**
 * A floor's picture state: what 🔄 and ✏️ reuse and what continuity reads. All of it belongs to one image model
 * mode, data.modelMode (a Krea 2 sentence prompt or preset id means nothing to Anima, and the other way round).
 */
const FLOOR_STATE_KEYS = ['modelMode', 'target', 'presetId', 'fixed', 'parsed', 'prompt', 'negative', 'parserPresetId', 'parserPresetName', 'promptMode', 'editOverrides', 'promptEdited'];

/** Whether a floor has picture state of its own (a parse or a prompt), as opposed to nothing or only an error. */
function hasFloorState(data) {
    return !!(data?.prompt || data?.parsed);
}

/** Puts back the other mode's state after a run that did not replace it (failed or skipped), so it stays usable there. */
function restoreFloorState(data, previous) {
    for (const key of FLOOR_STATE_KEYS) {
        if (key in previous) data[key] = structuredClone(previous[key]);
        else delete data[key];
    }
}

async function runJob(message, job, options) {
    const settings = getSettings();
    const signal = job.controller.signal;
    const previous = swipeData(message, job.swipeId);
    const data = previous ? structuredClone(previous) : { v: 1, images: [], index: 0 };
    data.images ??= [];
    const mode = options.mode === 'edit' || options.mode === 'reroll' ? options.mode : 'reparse';
    // The whole job uses one image model mode; switching modes cancels it (see assertMode).
    const modelMode = currentMode();
    // The floor's state was made in the other mode: 🔄 parses it again instead of reusing that model's prompt, and
    // the state only changes over to this mode once this run has replaced it (`converted`).
    const otherMode = !!previous && floorMode(previous) !== modelMode && hasFloorState(previous);
    let converted = !otherMode;
    if (converted) data.modelMode = modelMode;
    // The user asked for a picture: a 🔄 that has to parse again must not be skipped.
    const force = !!options.force || (mode === 'reroll' && otherMode);

    try {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const mesId = ctx().chat.indexOf(message);
        if (mesId < 0) return;

        data.error = null;
        data.debug = { ...(data.debug || {}), notes: [] };
        // Edit-dialog choices stay with the floor for 🔄 (new seed, same settings) until it is parsed again.
        let overrides = mode === 'edit' ? options.overrides ?? null : mode === 'reroll' ? data.editOverrides ?? null : null;

        if (mode === 'reparse' || !data.prompt || (mode === 'reroll' && otherMode)) {
            overrides = null;
            delete data.editOverrides;
            delete data.promptEdited;
            if (mode === 'reroll' && otherMode) data.debug.notes.push(`这一楼上次是 ${modeLabel(floorMode(previous))} 模式画的，已按 ${modeLabel(modelMode)} 模式重新解析`);
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
            if (force) parserPrompt.user += FORCE_NOTE;
            data.debug.notes.push(...parserPrompt.notes);
            // Kept on failure for diagnosis; dropped after a success unless debug mode is on.
            data.debug.parserSystem = parserPrompt.system;
            data.debug.parserUser = parserPrompt.user;
            data.parser = parserLabel();
            data.parserRaw = '';
            data.parserReasoning = '';
            data.parserFinish = '';

            const started = performance.now();
            assertMode(modelMode);
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
            assertMode(modelMode);
            if (!settings.debug) {
                delete data.debug.parserSystem;
                delete data.debug.parserUser;
            }
            if (parsed.skip && !force) {
                // A skip in this mode leaves the other mode's picture state as it was.
                if (!converted) restoreFloorState(data, previous);
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
            data.modelMode = modelMode;
            converted = true;
            data.parsed = built.parsed;
            data.prompt = built.prompt;
            data.negative = buildNegativePrompt(target.preset);
            data.parserPresetId = parserPrompt.preset.id;
            data.parserPresetName = parserPrompt.preset.name;
            data.promptMode = parserPrompt.mode;
        } else if (mode === 'edit') {
            if (otherMode) {
                // The other mode's parse results must not reach this mode's parser as earlier outputs.
                for (const key of ['parsed', 'parserPresetId', 'parserPresetName', 'promptMode']) delete data[key];
                // The other mode's preset ids mean nothing here: use this mode's preset for the same character.
                const preset = floorPreset(data);
                data.presetId = preset?.id ?? null;
                data.fixed = {
                    appearance: resolveMacros(preset?.appearance || ''),
                    trigger: resolveMacros(preset?.trigger || ''),
                    preset: preset ? resolveMacros(preset.name) : '',
                };
                // The other mode's negative prompt (Krea 2's is usually empty) does not fit this model.
                data.negative = buildNegativePrompt(preset);
                data.debug.notes.push(`这一楼上次是 ${modeLabel(floorMode(previous))} 模式画的，这次用 ${modeLabel(modelMode)} 模式的设置出图`);
            }
            data.modelMode = modelMode;
            converted = true;
            // The dialog shows the negative prompt too and sends it as typed.
            if (typeof options.negative === 'string') data.negative = options.negative;
            // Sent exactly as typed, so it can be compared with the same text in ComfyUI.
            data.prompt = String(options.prompt ?? '');
            data.promptEdited = true;
            data.editOverrides = overrides ?? undefined;
            data.debug.notes.push('提示词由用户手动编辑（原样发送）');
        } else if (!data.promptEdited && !data.editOverrides) {
            // 🔄 keeps the prompt, but trigger words added or changed since then are put in (not into an edited prompt).
            const finished = finishPrompt(data.prompt);
            if (finished !== data.prompt) data.debug.notes.push('补上了本模式的触发词');
            data.prompt = finished;
        }
        data.skipped = null;
        if (!String(data.prompt ?? '').trim()) throw new Error('最终提示词为空');

        setStage(job, message, 'drawing', 'ComfyUI 生成中…');
        // The character's render profile swaps in its own model / LoRA / sampling settings.
        const plan = renderPlan(data, overrides);
        const { preset, profile, comfy, width, height } = plan;
        if (profile) data.debug.notes.push(`渲染配置：${profile.name}（角色预设「${resolveMacros(preset.name)}」）`);
        else if (preset?.renderProfileId && !plan.boundProfile) data.debug.notes.push('角色预设选的渲染配置已被删除，使用默认 ComfyUI 设置');
        if (overrides) {
            const described = describeOverrides(overrides);
            if (described) data.debug.notes.push(described);
        }
        const fixedSeed = Number(comfy.seed);
        const ownSeed = mode === 'edit' && Number.isFinite(overrides?.seed) && overrides.seed >= 0 ? overrides.seed : null;
        const seed = ownSeed ?? (mode !== 'reroll' && fixedSeed >= 0 ? fixedSeed : randomSeed());
        if (plan.sizeFromPreset) data.debug.notes.push(`分辨率来自解析预设：${width}×${height}`);
        // A cleared field falls back to the mode's default (Krea 2 Turbo: 8 steps, CFG 1; Anima: 30 steps, CFG 4).
        const defaults = modeDefaults(modelMode).comfy;
        const values = {
            prompt: data.prompt,
            negative_prompt: data.negative || '',
            width,
            height,
            seed,
            steps: Number(comfy.steps) || defaults.steps,
            cfg: Number(comfy.cfg) || defaults.cfg,
            scale: Number(comfy.cfg) || defaults.cfg,
            sampler: comfy.sampler || defaults.sampler,
            scheduler: comfy.scheduler || defaults.scheduler,
            denoise: 1,
            unet: comfy.unet,
            model: comfy.unet,
            clip: comfy.clip,
            vae: comfy.vae,
            lora: plan.styleLora,
            lora_strength: plan.styleLoraStrength,
            char_lora: plan.charLora,
            char_lora_strength: plan.charLoraStrength,
            // Text-encoder strength of the LoRA loaders (0 = model only, like "LoraLoaderModelOnly").
            lora_clip_strength: plan.loraClip ? plan.styleLoraStrength : 0,
            char_lora_clip_strength: plan.loraClip ? plan.charLoraStrength : 0,
            filename_prefix: comfy.filenamePrefix || defaults.filenamePrefix,
            batch_size: 1,
        };

        const template = await getWorkflowTemplate(comfy, profile, modelMode);
        assertMode(modelMode);
        const { workflow, notes } = prepareWorkflow(template.text, values);
        addExtraLoras(workflow, plan.extraLoras, plan.loraClip, notes);
        data.debug.notes.push(...notes);
        if (template.refine) {
            data.debug.notes.push(comfy.mode === 'direct'
                ? 'ComfyUI 端提示词扩写已开启：实际用来出图的是扩写后的文字（见下方）'
                : 'ComfyUI 端提示词扩写已开启：实际用来出图的是扩写后的文字（「酒馆后端代理」模式拿不到扩写结果，切到「浏览器直连」可以在调试里看到）');
        }
        data.params = {
            modelMode,
            renderProfile: profile?.name || '',
            refine: !!template.refine,
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
            extraLoras: plan.extraLoras.map(lora => `${lora.name} @ ${lora.strength}`).join('、'),
            loraClip: plan.loraClip,
        };
        if (settings.debug) data.debug.workflow = workflow;
        else delete data.debug.workflow;

        const started = performance.now();
        const image = await runWorkflow(workflow, signal, text => setStage(job, message, 'drawing', text));
        assertMode(modelMode);
        data.comfyMs = Math.round(performance.now() - started);
        data.refinedPrompt = template.refine && image.texts?.length ? truncate(image.texts.join('\n'), 4000) : '';

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
        // A switch during the upload cancelled this picture: the floor is not touched.
        assertMode(modelMode);

        data.images.push({ src, path, seed, width, height, prompt: data.prompt, negative: data.negative || '', refined: data.refinedPrompt || undefined, mode: modelMode, time: Date.now() });
        data.modelMode = modelMode;
        const maxVersions = Math.max(1, Number(settings.maxVersions) || 10);
        while (data.images.length > maxVersions) data.images.shift();
        data.index = data.images.length - 1;
        if (commit(message, job.swipeId, data) && (message.swipe_id ?? 0) === job.swipeId) {
            imageAdded(ctx().chat.indexOf(message));
        }
        log(`#${mesId} 完成`, data);
    } catch (error) {
        if (isAbortError(error)) {
            toastr.info(error.modeChanged || currentMode() !== modelMode ? '切换了模型模式，已取消这次配图' : '已取消配图');
            return;
        }
        console.error('[ComfyPortrait]', error);
        // A failure in this mode leaves the other mode's picture state usable there.
        if (!converted) restoreFloorState(data, previous);
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
    const modelMode = currentMode();
    let target = resolveTarget(message, targetOverride);
    const parserPrompt = await buildParserPrompt(mesId, target);
    const { reply, parsed: raw } = await requestParse(parserPrompt.system, parserPrompt.user);
    if (currentMode() !== modelMode) throw new Error('试运行期间切换了模型模式，结果已丢弃');
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
