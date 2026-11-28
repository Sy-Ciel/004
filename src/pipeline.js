import { EXTRA_KEY, modeDefaults } from './constants.js';
import { addExtraLoras, addUpscale, deferUpscale, getWorkflowTemplate, prepareWorkflow, runWorkflow, saveImage, upscaleWorkflow } from './comfy.js';
import { comparable, findQuote } from './anchors.js';
import { comicPages, comicPanelCount, fitLayout, isComicPreset } from './comic.js';
import { currentMode, floorMode, imageMode, modeLabel } from './modes.js';
import { buildParserPrompt, floorParagraphs, lastInstructionSent, parserLabel, readPartialReply, readReplyPictures, replyParserPrompt, requestParse, storyParagraphs, usesStream } from './parser.js';
import { ReplyScanner } from './partial.js';
import { findPromptBlocks, promptsInReply, replyStream, replyTrace } from './inReply.js';
import { replyProblem } from './replyCheck.js';
import { activeParserPreset, findParserPreset, parseFixedFields, presetResolution, sceneLimit } from './parserPresets.js';
import { buildImagePrompt, buildNegativePrompt, finishPrompt } from './prompt.js';
import { modeForRating, readRating } from './rating.js';
import { baseSize, parserPicksAspect } from './resolution.js';
import { effectiveComfy, renderProfileFor } from './renderProfiles.js';
import { slgSettings } from './slg.js';
import { findPresetById, presetForName, resolveTarget, settleAutoTarget, substituteTarget } from './targets.js';
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
    sleep,
    toSrc,
    truncate,
    warn,
} from './utils.js';

/** In-flight jobs, keyed by the chat message object so index shifts cannot misplace results. */
const jobs = new WeakMap();
const activeJobs = new Set();
let rerender = () => {};
let imageAdded = () => {};
let modeSwitcher = () => false;
let parserReviewer = null;

const FORCE_NOTE = '\n\n注意：用户手动要求为本楼出图。即使信息不足也不要输出 skip，请根据上下文合理推断。';

/**
 * The parser preset's fixed fields always win over what the model wrote, so e.g. a fixed pose stays.
 * @returns {{ parsed: object, forced: string[] }}
 */
function applyFixedFields(parsed, parserPreset) {
    const fixed = parseFixedFields(parserPreset?.fixedFields);
    return { parsed: { ...parsed, ...fixed }, forced: Object.keys(fixed) };
}

/**
 * 画谁不在画面里: who the pictures of a parse show. `chosen` is the target the floor was parsed for; when the
 * parser says that target is not in the scene, someone else (or nobody, only the scenery) is drawn instead.
 * @returns {{ subject: object, sceneSubject: (scene: object) => object }} subject: the end of the floor's picture
 */
function subjectsOf(chosen, parsed, parserPrompt, message, notes) {
    const original = chosen.auto ? settleAutoTarget(chosen, parsed.target, message) : chosen;
    let subject = original;
    if (parserPrompt.absent && parsed.absent) {
        subject = substituteTarget(parsed.target, parsed.looks);
        const who = chosen.auto ? '候选角色都' : `「${chosen.name}」`;
        notes.push(subject.nobody
            ? `${who}不在这一楼的画面里，画面里也没有别人：只画场景`
            : `${who}不在这一楼的画面里，改画「${subject.name}」${subject.preset ? '（用 ta 的角色预设）' : '（按解析模型写的外貌）'}`);
    }
    // 多张图: each part shows its own target, someone else when the target is not in that part.
    const sceneSubject = scene => {
        if (parserPrompt.absent && scene.absent) return substituteTarget(scene.target, scene.looks);
        if (chosen.auto) return scene.target ? settleAutoTarget(chosen, scene.target, message) : subject;
        return chosen;
    };
    return { subject, sceneSubject };
}

/** A paragraph number in Chinese numerals (三, 十二, 二十一 …), NaN for anything else. */
function chineseNumber(text) {
    const digits = { 〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    const match = /^([一二两三四五六七八九]?)(十?)([〇零一二三四五六七八九]?)$/.exec(text);
    if (!match || !text) return NaN;
    const [, tens, ten, ones] = match;
    if (!ten) return tens && !ones ? digits[tens] : NaN;
    return (tens ? digits[tens] : 1) * 10 + (ones ? digits[ones] : 0);
}

/**
 * The paragraph number in what the parser wrote: 3, "3", "[3]", "3.", "3-4" (the first), "第3段", "第三段", "3段之后",
 * "段落 3", "paragraph 3", "after [3]", or the numbered line copied whole ("[3] 她推开门……"). NaN for a quote (a
 * short sentence with a digit in it is one too).
 */
function paragraphNumber(value) {
    const text = String(value ?? '').trim();
    const line = /^[[【]\s*(\d+)\s*[\]】]/.exec(text);
    if (line) return Number(line[1]);
    if (!text || text.length > 20) return NaN;
    const chinese = /^(?:第\s*)?([一二两三四五六七八九十]+)\s*(?:段|$)/.exec(text);
    if (chinese) return chineseNumber(chinese[1]);
    const words = /paragraphs?|para|after|no|p|第|段落?|之?[后後]面?|[\s[\]【】()（）.,，、:：;；~～#-]/gi;
    if (text.replace(/\d+/g, '').replace(words, '')) return NaN;
    const digits = /\d+/.exec(text);
    return digits ? Number(digits[0]) : NaN;
}

/**
 * 图片插在正文中间 / 多张图: the parser names paragraphs of the floor by number ([1], [2] … as it saw them, see
 * floorParagraphs; `paragraphs` is the whole story, storyParagraphs). An anchor becomes that paragraph's opening
 * words (the paragraph is found by them in the shown text) and its share of the story (where the picture goes when
 * it is not found). A quote the parser wrote instead is kept.
 * @param {'after'|'start'} side after: the picture follows that paragraph; start: a part begins with it
 * @returns {{ text: string, at: number | undefined }}
 */
function paragraphAnchor(value, paragraphs, side) {
    const text = String(value ?? '').trim();
    const number = paragraphNumber(text);
    if (Number.isNaN(number)) return { text, at: undefined };
    if (number < 1 || !paragraphs.length) return { text: '', at: undefined };
    return paragraphAt(paragraphs, Math.min(number - 1, paragraphs.length - 1), side);
}

/** The anchor of paragraph `index`: its opening words and its share of the story. */
function paragraphAt(paragraphs, index, side) {
    // The share is counted in letters and digits, like the shown text is measured (see placeAnchors).
    const size = paragraphs.map(paragraph => comparable(paragraph).length);
    const total = size.reduce((sum, length) => sum + length, 0) || 1;
    const before = size.slice(0, side === 'after' ? index + 1 : index).reduce((sum, length) => sum + length, 0);
    return { text: paragraphs[index].slice(0, 40), at: before / total };
}

/**
 * 图片插在正文中间 without a usable paragraph from the parser: the paragraph its now_doing (what the picture shows,
 * in the story's own words) has most in common with, a later one when two tie; -1 when none shares enough. Only the
 * paragraphs the parser was shown count.
 */
function guessPlace(doing, paragraphs) {
    const pairs = text => new Set(Array.from({ length: Math.max(0, text.length - 1) }, (_, i) => text.slice(i, i + 2)));
    const wanted = pairs(comparable(doing));
    let best = -1;
    let most = Math.max(3, Math.ceil(wanted.size / 4));
    paragraphs.forEach((paragraph, index) => {
        const own = comparable(paragraph);
        const shared = [...wanted].filter(pair => own.includes(pair)).length;
        if (shared >= most) {
            best = index;
            most = shared;
        }
    });
    return best;
}

/**
 * The story's first and last words, so pictures without a spot of their own stay inside it (see placeAnchors).
 * storyEnding: its last words when the pictures were made, always of the whole story (storyEnd of versions from
 * v1.36 to v1.39 may be where the parser's view was cut off); the story ends there even when text is added to it
 * later.
 */
function storyBounds(paragraphs) {
    if (!paragraphs.length) return {};
    const ending = paragraphs.at(-1).slice(-24);
    return { storyStart: paragraphs[0].slice(0, 40), storyEnd: ending, storyEnding: ending };
}

/** The preset a subject's looks come from: its character preset, else what the parser wrote about them. */
function subjectPreset(subject) {
    if (subject.preset || !subject.looks) return subject.preset ?? null;
    return { id: null, name: subject.name, appearance: subject.looks, trigger: '', negative: '' };
}

function sameSubject(a, b) {
    return a === b || (a.name === b.name && !!a.nobody === !!b.nobody);
}

/** Builds the prompt of one earlier part of the floor (多张图), with its own subject. */
function scenePrompt(scene, who, mainSubject, mainParsed, parserPrompt) {
    const { label, start, place, absent, target, looks, ...fields } = scene;
    // A field the parser left out is taken from the end of the floor (usually the same outfit) when the part
    // shows the same person. 提示词和正文一起出: each block is a whole picture already (what it left out was taken
    // from the block before it), drawn the same whether it turns out to be the end of the floor or not.
    const filled = Object.fromEntries(Object.entries(fields).filter(([, value]) => value));
    const base = !parserPrompt.inReply && sameSubject(who, mainSubject) ? { ...mainParsed, prompt: '', negative: '', others: '' } : {};
    return promptFromParse(subjectPreset(who), { ...base, ...filled }, parserPrompt, [], { nobody: !!who.nobody });
}

/**
 * The size a picture parsed with this parser preset is drawn at, without edit-dialog choices (as renderPlan
 * works it out: the parser preset's own size, else the global one, or the resolution selector's ratio).
 */
function plannedSize(parserPreset, aspect, fromReply = false) {
    const presetSize = presetResolution(parserPreset);
    const { comfy } = getSettings();
    const base = baseSize(comfy, aspect, parserPicksAspect(comfy) || fromReply);
    const defaults = modeDefaults(currentMode()).comfy;
    return {
        width: roundTo16(presetSize?.width || base.width, defaults.width),
        height: roundTo16(presetSize?.height || base.height, defaults.height),
    };
}

/**
 * Builds the final prompt for a parse result; shared by real runs and the dry run. canvas: the size a comic page's
 * layout was written for (漫画模式), else null.
 */
function promptFromParse(characterPreset, parsed, parserPrompt, notes, { nobody = false } = {}) {
    const { parsed: final, forced } = applyFixedFields(parsed, parserPrompt.preset);
    if (forced.length) notes.push(`固定内容覆盖了：${forced.join(', ')}`);
    const comic = isComicPreset(parserPrompt.preset);
    // 漫画模式 always draws MOSS-Image's JSON layout, never a written-out prompt.
    if (comic && !final.page) throw new Error('解析模型没有画出这一页漫画的版面（layout），没有出图');
    const canvas = comic ? plannedSize(parserPrompt.preset, final.aspect, !!parserPrompt.inReply) : null;
    if (canvas) {
        const panels = comicPanelCount(final.page);
        const texts = final.page.items.filter(item => item.label === 'text').length;
        notes.push(`漫画：${panels ? `${panels} 格、` : ''}${final.page.items.length} 项${texts ? `（${texts} 个文字框）` : ''}，坐标按 ${canvas.width}×${canvas.height} 换算成 MOSS-Image 的 JSON 版面`);
        if (final.partial) notes.push('解析模型的输出不是完整的 JSON（可能被最大输出截断），漫画只用了能读出来的部分');
    } else if (parserPrompt.mode === 'ai' && !final.prompt) {
        notes.push('解析模型没有返回 prompt 字段，已改用「固定外貌 + AI 补充」的模板拼接');
    }
    if (parserPrompt.preset?.allowOthers && final.others) notes.push('画面里有其他人物（others）');
    return {
        parsed: final,
        canvas,
        prompt: buildImagePrompt(characterPreset, final, { parserPreset: parserPrompt.preset, mode: parserPrompt.mode, nobody, canvas }),
    };
}

export function setRenderer(fn) {
    rerender = fn;
}

/** 「发送前检查解析输入」: shows the parser input before it is sent; resolves to { system, user } or null (set by the UI). */
export function setParserReviewer(fn) {
    parserReviewer = fn;
}

/** Switches the image model mode for 按画面自动切换模型 without cancelling the job that asked (set by the UI). */
export function setModeSwitcher(fn) {
    modeSwitcher = fn;
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

function abortError() {
    return new DOMException('Aborted', 'AbortError');
}

/*
 * How jobs share the work: each one parses at once, side by side with the others (no queue for the parser), and
 * ComfyUI draws one job's pictures at a time, in the order the jobs got there — parsed first, drawn first. Jobs
 * that do not parse (🎲, ✏️) go straight to that line.
 */

/**
 * What ComfyUI works on now: a job drawing, or a picture being enlarged ({ task, start }, see queueUpscales); the
 * jobs waiting to draw ({ job, start, place }); the pictures waiting for the upscale model (先画完所有图，再统一放大),
 * which only start when no job waits to draw.
 */
let drawingNow = null;
const drawingLine = [];
const upscaleLine = [];

function startNextDrawing() {
    if (drawingNow) return;
    if (drawingLine.length) {
        drawingNow = drawingLine.shift();
        drawingNow.start();
        drawingLine.forEach((entry, index) => entry.place(index + 1));
    } else if (upscaleLine.length) {
        drawingNow = upscaleLine.shift();
        drawingNow.start();
    }
}

/**
 * Waits for the job's turn at ComfyUI; resolves to the function that ends it (the job calls it when its pictures are
 * done, or it fails or is cancelled). Cancelling while waiting leaves the line.
 */
function drawingTurn(job, message) {
    return new Promise((resolve, reject) => {
        const signal = job.controller.signal;
        if (signal.aborted) {
            reject(abortError());
            return;
        }
        const leaveLine = () => {
            const index = drawingLine.indexOf(entry);
            if (index < 0) return;
            drawingLine.splice(index, 1);
            drawingLine.forEach((other, at) => other.place(at + 1));
            reject(abortError());
        };
        const entry = {
            job,
            start() {
                signal.removeEventListener('abort', leaveLine);
                resolve(() => {
                    if (drawingNow !== entry) return;
                    drawingNow = null;
                    startNextDrawing();
                });
            },
            place(ahead) {
                setStage(job, message, 'waiting', `等 ComfyUI 出图，前面还有 ${ahead} 个…`);
            },
        };
        signal.addEventListener('abort', leaveLine, { once: true });
        // A job that ends while still waiting (failed, or nothing left to draw) leaves the line too.
        job.leaveLine = leaveLine;
        drawingLine.push(entry);
        if (drawingNow) entry.place(drawingLine.length);
        startNextDrawing();
    });
}

/*
 * 先画完所有图，再统一放大: a picture is shown as drawn, with its upscale step on it (`upscale`: the file in ComfyUI's
 * output folder, model, factor, 文件名前缀; `error` once it failed). It waits in upscaleLine until no job waits to
 * draw, then the enlarged picture takes its place in every version of the floor and the one as drawn is deleted.
 */

/** A picture's identity in a floor (redrawing one picture copies the others into the new version). */
function pictureKey(picture) {
    return picture?.path || picture?.src || '';
}

/** Every picture of every version of a floor. */
function floorPictures(data) {
    return (data?.images ?? []).flatMap(version => [...(version.scenes ?? []), version]);
}

/** The pictures of one version that wait for the upscale model. */
function waitingPictures(version) {
    return [...(version?.scenes ?? []), version].filter(picture => picture?.upscale);
}

/**
 * Pictures enlarged in this session, by the picture they replace: a job that copied the floor before saves it with
 * them too (commit).
 */
const enlarged = new Map();

function applyEnlarged(data) {
    if (!enlarged.size) return;
    for (const picture of floorPictures(data)) {
        const done = enlarged.get(pictureKey(picture));
        if (!done) continue;
        Object.assign(picture, done);
        delete picture.upscale;
    }
}

function deleteStoredFile(path) {
    if (!path) return;
    fetch('/api/images/delete', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ path }),
    }).catch(() => {});
}

/** Puts a version's pictures that wait for the upscale model in line (not the failed ones, not twice). */
function queueUpscales(message, swipeId, version) {
    let added = 0;
    for (const picture of waitingPictures(version)) {
        const key = pictureKey(picture);
        if (picture.upscale.error || !key || [drawingNow, ...upscaleLine].some(entry => entry?.task?.key === key)) continue;
        const task = { message, swipeId, key, ...picture.upscale, width: picture.width, height: picture.height, controller: new AbortController() };
        const entry = { task };
        entry.start = () => {
            render(message);
            runUpscale(task).finally(() => {
                if (drawingNow === entry) drawingNow = null;
                startNextDrawing();
            });
        };
        upscaleLine.push(entry);
        added++;
    }
    if (!added) return;
    startNextDrawing();
    render(message);
}

/** Enlarges one picture (its turn at ComfyUI came) and puts the result in its place. */
async function runUpscale(task) {
    const { message, swipeId, key } = task;
    const floor = () => (ctx().chat.indexOf(message) >= 0 ? swipeData(message, swipeId) : null);
    const pictures = () => floorPictures(floor()).filter(picture => pictureKey(picture) === key);
    // Gone meanwhile (its version deleted, 不放大了, another chat): nothing to do.
    if (task.controller.signal.aborted || !pictures().some(picture => picture.upscale)) return;
    try {
        const image = await runWorkflow(upscaleWorkflow(task.file, task, task.width, task.height, task.prefix), task.controller.signal);
        const stored = await storePicture(image, [], task.prefix);
        if (task.controller.signal.aborted || !pictures().length) {
            deleteStoredFile(stored.path);
            return;
        }
        const drawn = pictures()[0].path;
        enlarged.set(key, stored);
        commit(message, swipeId, floor());
        deleteStoredFile(drawn);
    } catch (error) {
        if (isAbortError(error)) return;
        warn(error);
        const reason = truncate(errorMessage(error), 300);
        for (const picture of pictures()) if (picture.upscale) picture.upscale = { ...picture.upscale, error: reason };
        if (floor()) commit(message, swipeId, floor());
        toastr.error(reason, '放大失败（原图保留）');
    } finally {
        render(message);
    }
}

/**
 * 先画完再放大 for the pictures of a version: how many wait, whether one of them is being enlarged, why one failed.
 * null when none waits.
 */
export function upscaleStatus(message, version) {
    const pictures = waitingPictures(version);
    if (!pictures.length) return null;
    const keys = new Set(pictures.map(pictureKey));
    return {
        count: pictures.length,
        running: drawingNow?.task?.message === message && keys.has(drawingNow.task.key),
        error: pictures.find(picture => picture.upscale.error)?.upscale.error ?? '',
    };
}

/** The shown version of a floor, with the pictures of it that wait for the upscale model (by key). */
function shownWaiting(mesId) {
    const message = ctx().chat[mesId];
    const swipeId = message?.swipe_id ?? 0;
    const data = message ? swipeData(message, swipeId) : null;
    const version = data?.images?.[Math.min(Math.max(0, data.index ?? 0), data.images.length - 1)];
    return version ? { message, swipeId, data, version, keys: new Set(waitingPictures(version).map(pictureKey)) } : null;
}

/** 放大失败 → 重试: the shown version's pictures go back into the line. */
export function retryUpscales(mesId) {
    const shown = shownWaiting(mesId);
    if (!shown?.keys.size) return;
    for (const picture of floorPictures(shown.data)) if (shown.keys.has(pictureKey(picture)) && picture.upscale) delete picture.upscale.error;
    commit(shown.message, shown.swipeId, shown.data);
    queueUpscales(shown.message, shown.swipeId, shown.version);
}

/** 不放大了: the shown version's pictures stay as drawn. */
export function dropUpscales(mesId) {
    const shown = shownWaiting(mesId);
    if (!shown?.keys.size) return;
    for (const picture of floorPictures(shown.data)) if (shown.keys.has(pictureKey(picture))) delete picture.upscale;
    for (let index = upscaleLine.length - 1; index >= 0; index--) {
        if (upscaleLine[index].task.message === shown.message && shown.keys.has(upscaleLine[index].task.key)) upscaleLine.splice(index, 1);
    }
    if (drawingNow?.task?.message === shown.message && shown.keys.has(drawingNow.task.key)) drawingNow.task.controller.abort();
    commit(shown.message, shown.swipeId, shown.data);
    render(shown.message);
}

/** Another chat opens, or 配图 is switched off: the pictures stop waiting, marked as they are (see resumeUpscales). */
export function cancelUpscales() {
    upscaleLine.length = 0;
    drawingNow?.task?.controller.abort();
}

/** The open chat's pictures still waiting for the upscale model get in line again (chat opened, page reloaded, 配图 on). */
export function resumeUpscales() {
    if (!getSettings().enabled) return;
    for (const message of ctx().chat ?? []) {
        if (!message) continue;
        const swipeId = message.swipe_id ?? 0;
        for (const version of swipeData(message, swipeId)?.images ?? []) queueUpscales(message, swipeId, version);
    }
}

/*
 * 按画面自动切换模型: a job runs in one image model mode from start to end, and the settings are the active mode's,
 * so jobs of one mode run side by side and a job for the other mode waits until they are done, then the mode
 * switches. Every job behind a waiting one waits too, so none waits for good. Without the automatic switch all jobs
 * are in the current mode and start at once.
 */
const modeLine = [];
let modeJobs = 0;
let jobsMode = null;

function admitJobs() {
    while (modeLine.length) {
        const next = modeLine[0];
        const wanted = next.mode ?? currentMode();
        if (modeJobs > 0 && wanted !== jobsMode) return;
        modeLine.shift();
        if (wanted !== currentMode()) modeSwitcher(wanted);
        jobsMode = currentMode();
        modeJobs++;
        next.start();
    }
}

/** Waits until the job may run in `mode` (null: the current one), switching to it when no other job is running. */
function enterMode(job, message, mode) {
    return new Promise((resolve, reject) => {
        const signal = job.controller.signal;
        if (signal.aborted) {
            reject(abortError());
            return;
        }
        const leaveLine = () => {
            const index = modeLine.indexOf(entry);
            if (index < 0) return;
            modeLine.splice(index, 1);
            reject(abortError());
            admitJobs();
        };
        const entry = {
            mode,
            start() {
                signal.removeEventListener('abort', leaveLine);
                resolve();
            },
        };
        signal.addEventListener('abort', leaveLine, { once: true });
        modeLine.push(entry);
        admitJobs();
        if (!modeLine.includes(entry)) return;
        const wanted = mode ?? currentMode();
        setStage(job, message, 'queued', wanted !== jobsMode
            ? `等 ${modeLabel(jobsMode)} 模式的配图画完，再切到 ${modeLabel(wanted)} 模式…`
            : '排队中：前面的配图要先切换模型模式…');
    });
}

function leaveMode() {
    modeJobs = Math.max(0, modeJobs - 1);
    if (!modeJobs) jobsMode = null;
    admitJobs();
}

/** 「发送前检查解析输入」: one review popup at a time, also when several floors parse at once. */
let reviewLine = Promise.resolve();

function oneReviewAtATime(review) {
    const turn = reviewLine.then(review, review);
    reviewLine = turn.catch(() => {});
    return turn;
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
    job.own = text;
    // 边解析边出图: while ComfyUI draws a floor's first pictures, the parser may still be writing the others.
    job.text = stage !== 'parsing' && job.parseNote ? `${text}（${job.parseNote}）` : text;
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
    applyEnlarged(data);
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
 * @param {'reparse'|'reroll'|'edit'|'resend'} [options.mode='reparse'] reparse = ask the parser again; reroll = same prompt, new seed;
 *   edit = use options.prompt; resend = 重新发送提示词: the floor's prompts sent to ComfyUI again as they are (after
 *   ComfyUI failed), seeds as for a first drawing
 * @param {string} [options.target] Target override
 * @param {string} [options.prompt] Prompt for edit mode
 * @param {string} [options.negative] Negative prompt for edit mode (default: the floor's)
 * @param {{ width: number, height: number }} [options.canvas] Edit mode: the size the prompt was drawn at (a JSON
 *   layout's boxes are fitted to the size it is drawn at now)
 * @param {boolean} [options.force] Tell the parser not to skip
 * @param {number} [options.scene] 多张图: with reroll / edit, redraw only this picture of the version (-1 = the end)
 * @param {number} [options.version] The version that picture belongs to (default: the shown one)
 */
export function enqueue(mesId, options = {}) {
    const message = ctx().chat[mesId];
    if (!message) return Promise.resolve();
    // 「启用」 off (the 🖼 switch by the chat input): no picture at all, whichever button asked for it.
    if (!getSettings().enabled) {
        toastr.info('配图已关闭。点输入框左边的 🖼 开关（或设置里的「启用」）打开后再生成。', 'ComfyUI 角色配图');
        return Promise.resolve();
    }
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
    // No queue: the job parses at once; only ComfyUI takes the jobs one at a time (see drawingTurn).
    return runJob(message, job, options).catch(error => warn(error));
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
    // Resolution: the edit dialog, else the parser preset this floor was parsed with, else the global size
    // (fixed width × height, or the resolution selector's ratio — the parser's pick when it chooses one).
    const presetSize = presetResolution(findParserPreset(data?.parserPresetId) ?? activeParserPreset());
    // 提示词和正文一起出: the main AI chose the picture's 横 / 竖 (with a fixed size too, its pixel count kept).
    const base = baseSize(comfy, data?.parsed?.aspect, parserPicksAspect(comfy) || !!data?.fromReply);
    const fromBase = !overrides?.width && !presetSize;
    const defaults = modeDefaults(currentMode()).comfy;
    const width = roundTo16(overrides?.width || presetSize?.width || base.width, defaults.width);
    const height = roundTo16(overrides?.height || presetSize?.height || base.height, defaults.height);
    return {
        preset,
        profile,
        boundProfile,
        comfy,
        width,
        height,
        sizeFromPreset: !overrides?.width && !!presetSize,
        aspect: fromBase ? base.aspect : '',
        aspectFromParser: fromBase && base.fromParser,
        charLora: overrides?.charLora === false ? '' : preset?.lora || '',
        charLoraStrength: Number(preset?.loraStrength) || 0,
        styleLora: overrides?.styleLora === false ? '' : comfy.lora || '',
        styleLoraStrength: Number(comfy.loraStrength) || 0,
        // "更多 LoRA": the ones for every picture plus this character's.
        extraLoras: overrides?.extraLoras === false ? [] : extraLorasFor(preset),
        loraClip: !!getSettings().comfy.loraClip,
        upscale: overrides?.upscale === false ? null : upscaleOf(comfy),
    };
}

/**
 * 放大: the upscale model and the final size factor, or null when it is off (or no model is set). later: 先画完所有图，
 * 再统一放大 (the picture is shown as drawn and enlarged once ComfyUI has no more drawing to do).
 */
function upscaleOf(comfy) {
    const model = String(comfy.upscaleModel || '').trim();
    if (!comfy.upscale || !model) return null;
    const factor = Number(comfy.upscaleFactor);
    return { model, factor: Number.isFinite(factor) && factor >= 1 && factor <= 8 ? factor : 2, later: comfy.upscaleLater !== false };
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
    if (overrides.upscale === false) parts.push('不放大');
    return parts.length ? `按编辑窗口的设置出图：${parts.join('、')}` : '';
}

/** The text of the swipe a job draws. */
function swipeText(message, swipeId) {
    if ((message.swipe_id ?? 0) === swipeId) return message.mes;
    return message.swipes?.[swipeId] ?? message.mes;
}

/**
 * The mode the floor's rating marker asks for (when 按画面自动切换模型 is on), with a debug note; mode null = the
 * current one. The switch itself waits for the other jobs (see enterMode).
 */
function floorRating(message, swipeId) {
    const settings = getSettings();
    if (!settings.enabled || !settings.autoModelByRating) return { mode: null, note: '' };
    const rating = readRating(swipeText(message, swipeId));
    const target = modeForRating(rating);
    if (!target) return { mode: null, note: '按画面自动切换模型：这一楼没有分级标记，用当前模式' };
    return { mode: target, note: `画面分级：${rating.toUpperCase()}（正文 AI 标记）→ ${modeLabel(target)} 模式` };
}

/**
 * A floor's picture state: what 🔄 and ✏️ reuse and what continuity reads. All of it belongs to one image model
 * mode, data.modelMode (a Krea 2 sentence prompt or preset id means nothing to Anima, and the other way round).
 */
const FLOOR_STATE_KEYS = ['modelMode', 'target', 'presetId', 'fixed', 'subject', 'parsed', 'prompt', 'canvas', 'negative', 'scenes', 'endStart', 'endStartAt', 'place', 'placeAt', 'storyStart', 'storyEnd', 'storyEnding', 'parserPresetId', 'parserPresetName', 'promptMode', 'editOverrides', 'promptEdited', 'fromReply', 'endBlock'];

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

/** The values a workflow template is filled with for one picture: the plan's model, LoRAs and sampling. */
function workflowValues(plan, modelMode, { prompt, negative, width, height, seed }) {
    const { comfy } = plan;
    // A cleared field falls back to the mode's default (Krea 2 Turbo: 8 steps, CFG 1; Anima: 30 steps, CFG 4;
    // MOSS-Image: 25 steps, CFG 2.5).
    const defaults = modeDefaults(modelMode).comfy;
    const slg = slgSettings(comfy);
    return {
        prompt,
        negative_prompt: negative || '',
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
        filename_prefix: filenamePrefix(comfy.filenamePrefix) || filenamePrefix(defaults.filenamePrefix),
        batch_size: 1,
        // MOSS-Image's skip layer guidance: the layers it skips, '' = off (the node then passes the model on), and
        // the part of the sampling it works in.
        slg_layers: comfy.slg ? slg.layers.join(', ') : '',
        slg_start: slg.start,
        slg_end: slg.end,
    };
}

/** 跳层引导 of a drawing for the debug view ('' when it is off or the workflow has no place for it). */
function slgSummary(text, values) {
    if (!values.slg_layers || !text.includes('%slg_layers%')) return '';
    const ranged = text.includes('%slg_start%') || text.includes('%slg_end%');
    return `跳过第 ${values.slg_layers} 层${ranged ? `，采样进度 ${values.slg_start} → ${values.slg_end}` : '（开始 / 结束按工作流里写的）'}`;
}

/**
 * 文件名前缀 with SillyTavern's macros filled in ({{user}}, {{char}}, {{date}} …), safe for a file name: characters
 * a file name cannot have become "_"; "/" stays (ComfyUI makes subfolders of it), without empty or ".." parts.
 */
export function filenamePrefix(text) {
    return resolveMacros(String(text ?? ''))
        .replace(/[\\:*?"<>|\u0000-\u001f]/g, '_')
        .split('/')
        .map(part => part.trim().replace(/^\.+$/, '_'))
        .filter(Boolean)
        .join('/');
}

/**
 * The workflow for one picture: the template filled in, plus the "更多 LoRA" chain and the 放大 step — or, with 先画完
 * 所有图，再统一放大, the picture saved for enlarging later (`later`, see laterMark and queueUpscales).
 * @returns {{ workflow: object, later: { file: string, model: string, factor: number, prefix: string } | null }}
 */
function buildWorkflow(template, values, plan, notes = []) {
    const { workflow, notes: prepared } = prepareWorkflow(template.text, values);
    addExtraLoras(workflow, plan.extraLoras, plan.loraClip, prepared);
    let later = null;
    if (plan.upscale) {
        const saved = plan.upscale.later ? deferUpscale(workflow, plan.upscale, values.width, values.height, prepared) : null;
        if (saved) later = { file: saved.file, model: plan.upscale.model, factor: plan.upscale.factor, prefix: values.filename_prefix };
        else addUpscale(workflow, plan.upscale, values.width, values.height, prepared);
        if (plan.upscale.later && !saved) prepared.push('这个工作流的输出不是单独一个 SaveImage，放大照旧在出图时一起做');
    }
    notes.push(...prepared);
    return { workflow, later };
}

/** A picture to enlarge later: its upscale step, with the file ComfyUI reported (direct mode), else the one it was given. */
function laterMark(later, image) {
    return later ? { upscale: { file: image.file || later.file, model: later.model, factor: later.factor, prefix: later.prefix } } : {};
}

/** The latest drawing's settings, for the debug view. */
function drawingParams(plan, template, values, modelMode) {
    return {
        modelMode,
        renderProfile: plan.profile?.name || '',
        refine: !!template.refine,
        workflow: template.name,
        seed: values.seed,
        width: values.width,
        height: values.height,
        aspect: plan.aspect ? `${plan.aspect}${plan.aspectFromParser ? '（解析模型选的）' : ''}` : '',
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
        upscale: plan.upscale ? `${plan.upscale.model} → ×${plan.upscale.factor}（${Math.round(values.width * plan.upscale.factor)}×${Math.round(values.height * plan.upscale.factor)}）` : '',
        slg: slgSummary(String(template.text), values),
    };
}

/** What ComfyUI's refine step turned the prompt into ('' without it). */
function refinedText(template, image) {
    return template.refine && image.texts?.length ? truncate(image.texts.join('\n'), 4000) : '';
}

/**
 * Saves a picture on the SillyTavern server (in the character's image folder, named after the 文件名前缀 of the
 * workflow, `prefix`); when that fails it is kept in the chat as base64.
 */
async function storePicture(image, notes, prefix = '') {
    try {
        const name = String(prefix).replace(/\//g, '_') || 'ctp';
        const path = await saveImage(image, imageFolder(), `${name}${/[_-]$/.test(name) ? '' : '_'}${Date.now()}`);
        return { src: toSrc(path), path };
    } catch (error) {
        warn(error);
        notes.push(`${error.message}，图片改为 base64 内嵌在聊天记录中`);
        return { src: `data:image/${image.format};base64,${image.data}`, path: '' };
    }
}

/** Adds a version of the floor's picture and shows it; the oldest go beyond the setting's limit. */
function addVersion(data, version) {
    data.images.push(version);
    const maxVersions = Math.max(1, Number(getSettings().maxVersions) || 10);
    while (data.images.length > maxVersions) data.images.shift();
    data.index = data.images.length - 1;
}

/**
 * Sends a parser prompt (shown first with 发送前检查解析输入) and keeps the reply for the debug view.
 * @returns {Promise<object>} The parsed reply
 */
async function askParser(message, job, data, parserPrompt, target, modelMode, watch = null) {
    const settings = getSettings();
    const signal = job.controller.signal;
    const mesId = ctx().chat.indexOf(message);
    data.debug.notes.push(...parserPrompt.notes);
    if (settings.reviewParserInput && parserReviewer) {
        const stage = job.text;
        setStage(job, message, 'parsing', '等待检查解析输入…');
        const reviewed = await oneReviewAtATime(() => (signal.aborted ? null : parserReviewer(ctx().chat.indexOf(message), parserPrompt, target)));
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        assertMode(modelMode);
        if (!reviewed) {
            job.controller.abort();
            throw new DOMException('Aborted', 'AbortError');
        }
        if (reviewed.system !== parserPrompt.system || reviewed.user !== parserPrompt.user) {
            data.debug.notes.push('解析输入在发送前被手动修改过（只影响这一次）');
        }
        parserPrompt.system = reviewed.system;
        parserPrompt.user = reviewed.user;
        setStage(job, message, 'parsing', stage);
    }
    // Kept on failure for diagnosis; dropped after a success unless debug mode is on.
    data.debug.parserSystem = parserPrompt.system;
    data.debug.parserUser = parserPrompt.user;
    data.parser = parserLabel();
    data.parserRaw = '';
    data.parserReasoning = '';
    data.parserFinish = '';

    const started = performance.now();
    assertMode(modelMode);
    // 流式传输: what has come in so far, under the stage's own words (at most a few times a second). 边解析边出图: once
    // ComfyUI draws the first pictures, beside what it draws.
    let stageText = job.text;
    let shownAt = 0;
    const request = requestParse(parserPrompt.system, parserPrompt.user, signal, {
        minTokens: parserPrompt.minTokens,
        comic: parserPrompt.comic,
        onProgress: ({ text, reasoning, answer }) => {
            if (watch && typeof answer === 'function' && !signal.aborted) watch.read(answer());
            if (performance.now() - shownAt < 250 || signal.aborted) return;
            shownAt = performance.now();
            const received = `已收到 ${text} 字${reasoning ? `，思考 ${reasoning} 字` : ''}`;
            if (job.stage === 'parsing') {
                setStage(job, message, 'parsing', `${stageText}（${received}）`);
            } else {
                job.parseNote = `解析中，${received}`;
                setStage(job, message, job.stage, job.own);
            }
        },
        onReply: reply => {
            // 用工具调用返回结果: what the debug view shows is the tool call's arguments.
            data.parserRaw = truncate(`${reply.tool ? '（工具调用 submit_picture 的参数）\n' : ''}${reply.content}`, 6000);
            data.parserReasoning = truncate(reply.reasoning, 4000);
            data.parserFinish = reply.finish || '';
            if (parserPrompt.notes.some(note => note.startsWith('用工具调用返回结果')) && !reply.tool) {
                data.debug.notes.push('解析模型没有调用工具，读的是它在正文里写的 JSON');
            }
            // Flex 模式: what the provider says it served the request at, and a model it has no Flex for.
            if (reply.note) data.debug.notes.push(reply.note);
            if (reply.tier && parserPrompt.notes.some(note => note.startsWith('Flex 模式'))) data.debug.notes.push(`这次解析实际的服务档：${reply.tier}`);
            log(`#${mesId} 解析输出`, reply);
        },
        onRetry: (attempt, max, error) => {
            // The pictures drawn from the failed reply are given up: the new reply draws its own.
            watch?.reset();
            job.parseNote = '';
            data.debug.notes.push(`解析第 ${attempt} 次失败，已自动重试：${truncate(errorMessage(error), 300)}`);
            stageText = `解析失败，正在重试（${attempt}/${max}）…`;
            setStage(job, message, 'parsing', stageText);
        },
    });
    let parsed;
    job.parsing = true;
    try {
        ({ parsed } = await request);
    } catch (error) {
        // The job failed at the parser, even while ComfyUI was drawing its first pictures.
        if (error && typeof error === 'object') error.parsing = true;
        throw error;
    } finally {
        job.parsing = false;
        if (job.parseNote) {
            job.parseNote = '';
            setStage(job, message, job.stage, job.own);
        }
    }
    data.parserMs = Math.round(performance.now() - started);
    assertMode(modelMode);
    if (!settings.debug) {
        delete data.debug.parserSystem;
        delete data.debug.parserUser;
    }
    return parsed;
}

/**
 * 多张图: 🔄 on one picture: the parser writes that part again (kept where it is in the text), giving its new
 * prompt and who it shows.
 */
async function parsePicture(message, job, data, base, scene, label, modelMode) {
    const mesId = ctx().chat.indexOf(message);
    const picture = scene >= 0 ? base.scenes[scene] : base;
    const count = (base.scenes?.length ?? 0) + 1;
    const focus = { label, start: picture.start || '', place: picture.place || '', index: scene >= 0 ? scene : count - 1, count, end: scene < 0 && !base.promoted };
    // The floor's target as set (not who the last parse drew instead).
    const chosen = resolveTarget(message);
    setStage(job, message, 'parsing', `正在重新解析「${label}」…`);
    const parserPrompt = await buildParserPrompt(mesId, chosen, { focus });
    parserPrompt.user += FORCE_NOTE;
    assertMode(modelMode);
    const parsed = await askParser(message, job, data, parserPrompt, chosen, modelMode);
    if (parsed.skip) throw new Error(`解析模型认为「${label}」这一段没有可以画的内容${parsed.reason ? `：${parsed.reason}` : ''}`);
    const { subject } = subjectsOf(chosen, parsed, parserPrompt, message, data.debug.notes);
    const built = promptFromParse(subjectPreset(subject), parsed, parserPrompt, data.debug.notes, { nobody: !!subject.nobody });
    return { subject, parsed: built.parsed, prompt: built.prompt, negative: buildNegativePrompt(subject.preset, built.parsed, built.prompt) };
}

/**
 * 多张图: 🎲 / ✏️ on one picture of a version. Only that picture is drawn, and a new version is added: a copy of
 * the version it was clicked in with that one picture replaced, so the other parts stay as they are and the old
 * picture is one version back.
 */
async function redrawPicture(message, job, data, options, modelMode, otherMode) {
    const signal = job.controller.signal;
    const versionIndex = Number.isInteger(options.version) ? options.version : data.index ?? 0;
    const base = data.images[Math.min(Math.max(0, versionIndex), data.images.length - 1)];
    if (!base) throw new Error('这一楼还没有图，不能单独重画');
    if (imageMode(base) !== modelMode) {
        throw new Error(`这一版是 ${modeLabel(imageMode(base))} 模式画的，切回 ${modeLabel(imageMode(base))} 模式再单独重画`);
    }
    const scene = options.scene;
    const picture = scene >= 0 ? base.scenes?.[scene] : base;
    if (!picture) throw new Error('没有找到要重画的这一张');
    // A version whose end-of-floor picture was deleted shows an earlier part as its own picture (promoted).
    const label = scene >= 0 ? picture.label || `第 ${scene + 1} 段` : base.label || (base.scenes?.length ? '结束时' : '这一张');
    const edit = options.mode === 'edit';
    // 🔄 on the picture: the parser writes this part again; 🎲 / ✏️ keep (or take) a prompt. 提示词和正文一起出: no
    // parser is asked, so 🔄 draws the main AI's prompt again.
    const reparse = !edit && options.mode !== 'reroll' && !promptsInReply();
    if (!edit && options.mode !== 'reroll' && !reparse) data.debug.notes.push('提示词和正文一起出：不调用解析模型，按正文 AI 写的提示词重画');
    const overrides = edit ? options.overrides ?? null : null;
    const fresh = reparse ? await parsePicture(message, job, data, base, scene, label, modelMode) : null;
    const prompt = fresh ? fresh.prompt : edit ? String(options.prompt ?? '') : String(picture.prompt ?? '');
    if (!prompt.trim()) throw new Error('提示词是空的');
    const negative = fresh ? fresh.negative : edit && typeof options.negative === 'string' ? options.negative : picture.negative || '';
    // Whose character LoRA: a part showing someone else than the floor's subject keeps that person's.
    const who = fresh
        ? { presetId: fresh.subject.preset?.id ?? null, target: fresh.subject.name }
        : 'presetId' in picture ? { presetId: picture.presetId, target: picture.target } : null;
    const own = !!who && who.presetId !== (data.presetId ?? null);
    const plan = renderPlan(own ? { ...data, ...who } : data, overrides);
    const width = overrides?.width ? plan.width : picture.width || plan.width;
    const height = overrides?.height ? plan.height : picture.height || plan.height;
    const seed = Number.isFinite(overrides?.seed) && overrides.seed >= 0 ? overrides.seed : randomSeed();
    data.debug.notes.push(`只重画「${label}」这一张（${fresh ? '重新解析' : edit ? '用编辑过的提示词' : '换了种子'}），这一版的其他几张不变`);
    if (overrides) {
        const described = describeOverrides(overrides);
        if (described) data.debug.notes.push(described);
    }

    job.endDrawing = await drawingTurn(job, message);
    assertMode(modelMode);
    setStage(job, message, 'drawing', `ComfyUI 生成中：「${label}」…`);
    const values = workflowValues(plan, modelMode, { prompt, negative, width, height, seed });
    const template = await getWorkflowTemplate(plan.comfy, plan.profile, modelMode);
    assertMode(modelMode);
    const { workflow, later } = buildWorkflow(template, values, plan, data.debug.notes);
    data.params = drawingParams(plan, template, values, modelMode);
    if (getSettings().debug) data.debug.workflow = workflow;
    else delete data.debug.workflow;
    const started = performance.now();
    const image = await runWorkflow(workflow, signal, text => setStage(job, message, 'drawing', `「${label}」${text}`));
    assertMode(modelMode);
    data.comfyMs = Math.round(performance.now() - started);
    const stored = { ...await storePicture(image, data.debug.notes, values.filename_prefix), ...laterMark(later, image) };
    assertMode(modelMode);

    const version = structuredClone(base);
    const replaced = scene >= 0 ? version.scenes[scene] : version;
    Object.assign(replaced, { ...stored, seed, width, height, prompt, negative, refined: refinedText(template, image) || undefined });
    if (!stored.upscale) delete replaced.upscale;
    // A part parsed again records who it shows now (the end of the floor's subject is the floor's, below).
    if (fresh && scene >= 0) Object.assign(replaced, who);
    version.time = Date.now();
    addVersion(data, version);
    // A part parsed again is also what 🎲 on the whole set draws next, and what later floors continue from.
    if (fresh && !otherMode) {
        const subject = fresh.subject;
        const subjectState = subject.nobody ? 'nobody' : subject.substitute ? 'substitute' : undefined;
        if (scene < 0 && base.promoted) {
            // Not the end of the floor: what the floor ended in stays as it was parsed.
        } else if (scene < 0) {
            Object.assign(data, { parsed: fresh.parsed, prompt, negative, target: subject.auto ? '' : subject.name, presetId: subject.preset?.id ?? null });
            data.fixed = {
                appearance: resolveMacros(subject.preset?.appearance || subject.looks || ''),
                trigger: resolveMacros(subject.preset?.trigger || ''),
                preset: subject.preset ? resolveMacros(subject.preset.name) : '',
            };
            if (subjectState) data.subject = subjectState;
            else delete data.subject;
            delete data.promptEdited;
            delete data.editOverrides;
        } else if (data.scenes?.[scene] && data.scenes[scene].label === picture.label) {
            Object.assign(data.scenes[scene], { parsed: fresh.parsed, prompt, negative, ...who, subject: subjectState });
        }
    }
    // An edited prompt is also what 🎲 on the whole set draws next time (when the floor's state is this mode's).
    if (edit && !otherMode) {
        if (scene < 0 && base.promoted) {
            // Not the end of the floor (see above).
        } else if (scene < 0) {
            data.prompt = prompt;
            data.negative = negative;
            data.promptEdited = true;
            data.editOverrides = overrides ?? undefined;
        } else if (data.scenes?.[scene] && data.scenes[scene].label === picture.label) {
            data.scenes[scene].prompt = prompt;
            data.scenes[scene].negative = negative;
        }
    }
    data.skipped = null;
    if (commit(message, job.swipeId, data) && (message.swipe_id ?? 0) === job.swipeId) {
        imageAdded(ctx().chat.indexOf(message));
    }
    queueUpscales(message, job.swipeId, version);
}

/** Records who a floor is drawn for (the target, or who is drawn in its place) and the looks that stay fixed. */
function applyTarget(data, resolved) {
    data.target = resolved.auto ? '' : resolved.name;
    data.presetId = resolved.preset?.id ?? null;
    data.fixed = {
        appearance: resolveMacros(resolved.preset?.appearance || resolved.looks || ''),
        trigger: resolveMacros(resolved.preset?.trigger || ''),
        preset: resolved.preset ? resolveMacros(resolved.preset.name) : '',
    };
    // 画谁不在画面里: someone else, or nobody, is drawn instead of the chosen target.
    if (resolved.nobody) data.subject = 'nobody';
    else if (resolved.substitute) data.subject = 'substitute';
    else delete data.subject;
}

/**
 * A floor's picture state from a parse: who is drawn (the target, or whoever is in the scene when it is not), the end
 * of the floor's prompt, the earlier parts' (多张图; 漫画模式: its earlier pages) and where each picture goes in the
 * text. 边解析边出图 works it out on a reply still coming in too, on a copy of the floor.
 * @param {object} chosen the target the floor was parsed for
 */
function floorFromParse(message, data, parsed, parserPrompt, chosen) {
    const settings = getSettings();
    // 提示词和正文一起出: every picture goes where the main AI put its block (as 图片插在正文中间 does).
    const inStory = !!settings.placeInStory || !!parsed.fromReply;
    if (parsed.fromReply) data.fromReply = true;
    else delete data.fromReply;
    // Which of the reply's blocks the end of the floor is (see FloorLine.preview).
    if (Number.isInteger(parsed.block)) data.endBlock = parsed.block;
    else delete data.endBlock;
    // Who is drawn: the target (auto: the one the parser picked), or, when the target is not in the scene, whoever
    // is (画谁不在画面里).
    const { subject: target, sceneSubject } = subjectsOf(chosen, parsed, parserPrompt, message, data.debug.notes);
    applyTarget(data, target);
    if (!target.preset && !target.looks && !target.nobody) {
        data.debug.notes.push(`没有找到「${target.name}」的角色预设，固定外貌为空`);
    }
    const built = promptFromParse(subjectPreset(target), parsed, parserPrompt, data.debug.notes, { nobody: !!target.nobody });
    data.parsed = built.parsed;
    data.prompt = built.prompt;
    // 漫画模式: the canvas the layout's pixel boxes are for (fitted to the size it is drawn at, see floorDrawings).
    if (built.canvas) data.canvas = built.canvas;
    else delete data.canvas;
    data.negative = buildNegativePrompt(target.preset, built.parsed, built.prompt);
    // 多张图: the earlier parts of the floor (another time or place), drawn before the end in the floor. 漫画模式:
    // its earlier pages (up to its own page limit).
    const limit = isComicPreset(parserPrompt.preset) ? comicPages(parserPrompt.preset) : sceneLimit(settings.parser);
    const scenes = limit > 1 ? (parsed.earlierScenes ?? []).slice(0, limit - 1) : [];
    // Where pictures go: the paragraphs the parser named, as their words and share of the whole story.
    const paragraphs = storyParagraphs(message);
    Object.assign(data, storyBounds(paragraphs));
    data.scenes = scenes.map((scene, index) => {
        const who = sceneSubject(scene);
        const sceneBuilt = scenePrompt(scene, who, target, built.parsed, parserPrompt);
        const label = scene.label || `第 ${index + 1} 段`;
        if (!sameSubject(who, target)) data.debug.notes.push(`「${label}」这一张画的是${who.nobody ? '场景（没有人）' : `「${who.name}」`}`);
        const start = paragraphAnchor(scene.start, paragraphs, 'start');
        const place = paragraphAnchor(scene.place, paragraphs, 'after');
        return {
            label,
            // Where the part begins in the text, and the paragraph its picture goes after (see anchors.js).
            start: start.text,
            startAt: start.at,
            place: place.text,
            placeAt: place.at,
            // Who this part shows: its own character preset (and LoRA) when it is not the end's.
            target: who.name,
            presetId: who.preset?.id ?? null,
            subject: who.nobody ? 'nobody' : who.substitute ? 'substitute' : undefined,
            parsed: sceneBuilt.parsed,
            prompt: sceneBuilt.prompt,
            negative: buildNegativePrompt(who.preset, sceneBuilt.parsed, sceneBuilt.prompt),
            // 提示词和正文一起出: its own 横 / 竖, and which of the reply's blocks it is.
            ...(scene.aspect ? { aspect: scene.aspect } : {}),
            ...(Number.isInteger(scene.block) ? { block: scene.block } : {}),
        };
    });
    const story = comparable(paragraphs.join('\n'));
    const missing = quotes => quotes.some(quote => !quote || findQuote(story, quote) < 0);
    if (!data.scenes.length) {
        delete data.scenes;
        delete data.endStart;
        delete data.endStartAt;
    } else {
        const endStart = paragraphAnchor(parsed.start, paragraphs, 'start');
        data.endStart = endStart.text;
        data.endStartAt = endStart.at;
        data.debug.notes.push(`正文分成了 ${data.scenes.length + 1} 段，画 ${data.scenes.length + 1} 张：${[...data.scenes.map(scene => scene.label), '结束时'].join(' → ')}`);
        if (!inStory && missing([...data.scenes.slice(1).map(scene => scene.start), data.endStart])) {
            data.debug.notes.push('解析模型没给全每一段从第几段开始（或给的对不上），缺的按比例插进正文');
        }
    }
    if ((parsed.earlierScenes?.length ?? 0) > scenes.length) data.debug.notes.push(`解析模型多写了 ${parsed.earlierScenes.length - scenes.length} 段，超过「最多几张」的没有画`);
    if (parsed.partial && !data.canvas) data.debug.notes.push('解析模型的输出不是完整的 JSON（可能被最大输出截断）：只画了写完整的几张');
    // 图片插在正文中间: the paragraph the end of the floor's picture goes after. Without one (none given, 0, or
    // words not in the story), the paragraph that tells what the picture shows (now_doing), rather than the
    // end of the story.
    let place = paragraphAnchor(parsed.place, paragraphs, 'after');
    if (inStory && (!place.text || missing([place.text]))) {
        const guess = guessPlace(parsed.now_doing, paragraphs.slice(0, floorParagraphs(message).length));
        if (guess >= 0) {
            place = paragraphAt(paragraphs, guess, 'after');
            data.debug.notes.push(`解析模型没给出能用的插图位置（写的是「${parsed.place || '空'}」），按它写的 now_doing 放在第 ${guess + 1} 段后面`);
        }
    }
    if (place.text) {
        data.place = place.text;
        data.placeAt = place.at;
    } else {
        delete data.place;
        delete data.placeAt;
    }
    if (inStory && missing([...(data.scenes ?? []).map(scene => scene.place), data.place])) {
        data.debug.notes.push('解析模型没给出插图位置（或给的对不上），缺的按比例插进正文（只有一张图时放在正文最后）');
    }
    data.parserPresetId = parserPrompt.preset.id;
    data.parserPresetName = parserPrompt.preset.name;
    data.promptMode = parserPrompt.mode;
}

/**
 * What a floor draws: the end of the floor, then its earlier parts (多张图, 漫画 pages), each with the plan it is drawn
 * with (a part showing someone else: their character LoRA and render profile), its size, prompt and seed, and a key —
 * the same key draws the same picture (边解析边出图 keeps a picture drawn from a reply still coming in when the whole
 * reply asks for that same picture).
 * @param {(slot: 'end' | number, comfy: object) => number} seedOf a picture's seed, by its place in the floor
 * @param {boolean} several the floor may have more than one picture (only for what the drawing is called)
 */
function floorDrawings(data, overrides, seedOf, several = !!data.scenes?.length) {
    // The character's render profile swaps in its own model / LoRA / sampling settings.
    const plan = renderPlan(data, overrides);
    // 提示词和正文一起出: each picture is a block of its own — its turn in the reply is its slot, and it has its own
    // 横 / 竖 — so a block is drawn the same whether it turns out to be the end of the floor or an earlier part.
    const inline = !!data.fromReply;
    const scenes = data.scenes ?? [];
    const drawing = (slot, role, label, own, picture, size) => {
        const seed = seedOf(slot, plan.comfy);
        const who = own ? [own.presetId, own.target] : [data.presetId ?? null, data.target ?? ''];
        const negative = picture.negative || '';
        return {
            slot,
            role,
            label,
            plan: own ? own.plan : plan,
            prompt: picture.prompt,
            negative,
            width: size.width,
            height: size.height,
            seed,
            key: JSON.stringify([picture.prompt, negative, size.width, size.height, seed, ...who]),
        };
    };
    // A JSON layout (漫画模式) is in pixels of the canvas it was written for: drawn at another size, it is scaled.
    const prompt = data.canvas ? fitLayout(data.prompt, data.canvas, { width: plan.width, height: plan.height }) : data.prompt;
    return {
        plan,
        end: drawing(inline ? scenes.length : 'end', 'end', several ? '结束时这一张' : '', null, { prompt, negative: data.negative }, plan),
        // The earlier parts: the same model, LoRAs and size, unless a part shows someone else (and, drawn from the
        // reply's blocks, its own 横 / 竖).
        scenes: scenes.map((scene, index) => {
            const other = 'presetId' in scene && scene.presetId !== (data.presetId ?? null) ? { ...data, presetId: scene.presetId, target: scene.target } : null;
            const own = other ? { presetId: scene.presetId, target: scene.target, plan: renderPlan(other, overrides) } : null;
            const size = inline ? renderPlan({ ...(other ?? data), parsed: { ...data.parsed, aspect: scene.aspect || '' } }, overrides) : plan;
            return drawing(index, 'scene', `「${scene.label}」`, own, scene, size);
        }),
    };
}

/** Adds the notes that are not there yet (each picture of a floor reports the same workflow notes). */
function addNotes(notes, more) {
    for (const note of more) if (!notes.includes(note)) notes.push(note);
}

/** An AbortController that also aborts with `parent`: one picture of a job, given up alone or with the whole job. */
function childController(parent) {
    const controller = new AbortController();
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener('abort', () => controller.abort(parent.reason), { once: true });
    return controller;
}

/**
 * A job's pictures at ComfyUI, drawn one at a time in the job's turn (see drawingTurn), each as soon as it is known —
 * 边解析边出图 hands them over while the parser is still writing the others — and the next one sent while the last one
 * is saved. A picture keeps its place in the floor (the end, or an earlier part's index) and is only drawn again when
 * what it draws changes; one given up is stopped (at ComfyUI too) and deleted once saved.
 */
class FloorLine {
    constructor(job, message, modelMode) {
        this.job = job;
        this.message = message;
        this.modelMode = modelMode;
        /**
         * The pictures by their place: { slot, key, drawing, controller, notes, result, dropped }, and for the display
         * started (at ComfyUI now), done (saved: { src, path }) or failed (why).
         */
        this.entries = new Map();
        /** The floor's state the pictures belong to (where each goes in the text): the reply so far, then the whole. */
        this.state = null;
        /** The end of the floor's slot ('end'; with a reply's blocks, the last block's turn). */
        this.endSlot = 'end';
        /**
         * 提示词和正文一起出: the main AI's reply is still streaming in (its pictures are shown at their blocks, see the
         * display's streamPictures), and whether it was followed while it did.
         */
        this.streaming = false;
        this.followed = false;
        this.chain = Promise.resolve();
        this.turn = null;
        /** Pictures begun and drawn so far, how many wait for ComfyUI, and how many the floor has (known once the whole reply is read). */
        this.begun = 0;
        this.drawn = 0;
        this.pending = 0;
        this.total = 0;
    }

    /** Draws a picture (see floorDrawings), unless the same one is drawn, or on its way, at its place already. */
    offer(drawing) {
        const current = this.entries.get(drawing.slot);
        if (current?.key === drawing.key) return current;
        if (current) this.drop(current);
        const entry = { slot: drawing.slot, key: drawing.key, drawing, controller: childController(this.job.controller.signal), notes: [], dropped: false, started: false, done: null, failed: '' };
        this.pending++;
        const drawn = this.chain.then(() => this.draw(entry));
        const settled = () => {
            this.pending--;
            // 边解析边出图: ComfyUI has drawn what is written so far, the parser is still writing.
            if (!this.pending && this.drawn && this.job.parsing && !this.job.controller.signal.aborted) {
                setStage(this.job, this.message, 'waiting', `ComfyUI 画完了已经写好的 ${this.drawn} 张，等下一张的提示词…`);
            }
        };
        // The next picture goes to ComfyUI once this one is drawn; saving this one happens meanwhile.
        this.chain = drawn.then(settled, settled);
        entry.result = drawn.then(async result => {
            if (entry.dropped) throw abortError();
            return { ...result, stored: await storePicture(result.image, entry.notes, result.values.filename_prefix) };
        });
        // 画好一张显示一张: shown as soon as it is saved (read again when the floor's pictures are put together; a
        // picture given up before that is nobody's).
        entry.result.then(result => {
            if (entry.dropped) return;
            const first = ![...this.entries.values()].some(other => other.done);
            entry.done = result.stored;
            render(this.message);
            // The floor's first new picture, like a finished floor's, is brought into view (the side panel).
            if (first && (this.message.swipe_id ?? 0) === this.job.swipeId) imageAdded(ctx().chat.indexOf(this.message));
        }, error => {
            if (entry.dropped || isAbortError(error)) return;
            entry.failed = errorMessage(error);
            render(this.message);
        });
        this.entries.set(drawing.slot, entry);
        return entry;
    }

    async draw(entry) {
        if (entry.dropped) throw abortError();
        this.turn ??= drawingTurn(this.job, this.message).then(end => {
            this.job.endDrawing = end;
        });
        await this.turn;
        if (entry.dropped) throw abortError();
        assertMode(this.modelMode);
        const { drawing } = entry;
        // Which picture of how many (while the parser is still writing, how many is not known yet).
        const number = ++this.begun;
        const count = this.total > 1 ? `（${Math.min(number, this.total)}/${this.total}）` : !this.total && number > 1 ? `（第 ${number} 张）` : '';
        // (Its turn at ComfyUI: shown as being drawn from here on.)
        entry.started = true;
        setStage(this.job, this.message, 'drawing', drawing.label ? `ComfyUI 生成中：${drawing.label}${count}…` : `ComfyUI 生成中${count}…`);
        const template = await getWorkflowTemplate(drawing.plan.comfy, drawing.plan.profile, this.modelMode);
        if (entry.dropped) throw abortError();
        assertMode(this.modelMode);
        const values = workflowValues(drawing.plan, this.modelMode, { prompt: drawing.prompt, negative: drawing.negative, width: drawing.width, height: drawing.height, seed: drawing.seed });
        const { workflow, later } = buildWorkflow(template, values, drawing.plan, entry.notes);
        const started = performance.now();
        const status = drawing.role === 'end' ? '' : drawing.label;
        const image = await runWorkflow(workflow, entry.controller.signal, text => setStage(this.job, this.message, 'drawing', `${status}${text}`));
        assertMode(this.modelMode);
        this.drawn++;
        return { image, values, template, workflow, later, ms: Math.round(performance.now() - started) };
    }

    /** Gives a picture up: stops it (at ComfyUI too, see runWorkflow) and deletes it once it is saved. */
    drop(entry) {
        if (entry.dropped) return;
        entry.dropped = true;
        entry.controller.abort();
        entry.result.then(result => deleteStoredFile(result.stored.path), () => {});
        if (this.entries.get(entry.slot) === entry) this.entries.delete(entry.slot);
    }

    dropAll() {
        for (const entry of [...this.entries.values()]) this.drop(entry);
    }

    /**
     * The floor's pictures once the whole reply is read (or without a parse, right away): one drawn already (or on
     * its way) is kept when it draws the same, the others are drawn now; pictures the floor no longer has are given up.
     * @returns {object[]} their entries, the end of the floor first
     */
    settle(drawings) {
        const wanted = [...drawings.scenes, drawings.end];
        this.total = wanted.length;
        this.endSlot = drawings.end.slot;
        const slots = new Set(wanted.map(drawing => drawing.slot));
        for (const entry of [...this.entries.values()]) if (!slots.has(entry.slot)) this.drop(entry);
        // The end of the floor first (it is the one a parse settles first), then the earlier parts; with a reply's
        // blocks, in their order.
        const order = drawings.end.slot === 'end' ? [drawings.end, ...drawings.scenes] : wanted;
        const entries = order.map(drawing => this.offer(drawing));
        return [entries[order.indexOf(drawings.end)], ...drawings.scenes.map(drawing => entries[order.indexOf(drawing)])];
    }

    /** The pictures are the floor's now: nothing is given up when the job ends. */
    keep() {
        this.entries.clear();
    }

    /**
     * 画好一张显示一张: the floor while its pictures are drawn, as a version (see addVersion) the display can show: the
     * pictures done so far, and a box for each one still on its way, at their places in the text. null until the
     * first one is done (a reply followed while it streams in: until its first block is read).
     */
    preview() {
        const floor = this.state;
        // A reply followed while it streamed in shows a picture on its way too (a line at its block: it was sent), and
        // keeps showing it once the reply is done.
        if (!floor || !(this.followed || [...this.entries.values()].some(entry => entry.done))) return null;
        const picture = slot => {
            const entry = this.entries.get(slot);
            return {
                src: entry?.done?.src ?? '',
                state: entry?.done ? 'done' : entry?.failed ? 'failed' : entry?.started ? 'drawing' : 'waiting',
                width: entry?.drawing.width ?? 0,
                height: entry?.drawing.height ?? 0,
            };
        };
        const scenes = (floor.scenes ?? []).map((scene, index) => ({
            ...picture(index),
            label: scene.label,
            start: scene.start || '',
            place: scene.place || '',
            startAt: scene.startAt,
            placeAt: scene.placeAt,
            block: scene.block,
        }));
        return {
            ...picture(this.endSlot),
            block: floor.endBlock,
            start: scenes.length ? floor.endStart || '' : undefined,
            startAt: scenes.length ? floor.endStartAt : undefined,
            place: floor.place || undefined,
            placeAt: floor.placeAt,
            ...(floor.storyStart ? { storyStart: floor.storyStart, storyEnd: floor.storyEnd, storyEnding: floor.storyEnding } : {}),
            scenes: scenes.length ? scenes : undefined,
            // Drawn from the reply's blocks: in the story where the blocks are (while the reply still streams in: right
            // after each block as it is shown).
            ...(floor.fromReply ? { inStory: true } : {}),
            ...(this.streaming ? { streaming: true } : {}),
            live: true,
        };
    }
}

/**
 * 边解析边出图: follows the parser's reply while it streams in and hands the line each picture as soon as it is settled
 * — with 多张图 the end of the floor once the fields in front of earlier_scenes are written, then each earlier part; in
 * 漫画模式 each page once the next one begins, and the last page (the end of the floor) once the list is complete. The
 * whole reply has the last word (FloorLine.settle).
 * @returns {{ read: (text: string) => void, reset: () => void } | null} null when the pictures wait for the whole reply
 */
function earlyDrawing(message, modelMode, parserPrompt, chosen, force, line, overrides, seedOf) {
    if (getSettings().parser.earlyDraw === false || !usesStream()) return null;
    const comic = !!parserPrompt.comic;
    const scanner = new ReplyScanner(comic ? ['pages'] : ['earlier_scenes', 'earlierScenes']);
    const several = comic ? comicPages(parserPrompt.preset) > 1 : sceneLimit(getSettings().parser) > 1;
    return {
        read(text) {
            try {
                if (!scanner.read(text)) return;
                const partial = readPartialReply(scanner, { comic });
                if (!partial || (partial.parsed.skip && !force)) return;
                // Worked out on a copy: the floor itself takes the whole reply.
                const scratch = { modelMode, debug: { notes: [] } };
                floorFromParse(message, scratch, partial.parsed, parserPrompt, chosen);
                if (!String(scratch.prompt ?? '').trim()) return;
                const drawings = floorDrawings(scratch, overrides, seedOf, several);
                if (!comic) line.offer(drawings.end);
                for (const drawing of drawings.scenes) line.offer(drawing);
                if (comic && partial.done) line.offer(drawings.end);
                line.state = scratch;
                line.endSlot = drawings.end.slot;
            } catch (error) {
                // Not drawable yet (or not like this): the whole reply decides.
                log('边解析边出图：这一段还不能画', error);
            }
        },
        reset() {
            scanner.reset();
            line.dropAll();
            line.state = null;
            line.begun = 0;
            line.drawn = 0;
        },
    };
}

/**
 * 提示词和正文一起出: the floor's pictures from the main AI's own blocks, without asking a parser model. While its
 * reply is still streaming in, each complete block goes to ComfyUI at once (边解析边出图); the whole reply has the last
 * word. A reply that was stopped gets no pictures; one cut off or blocked neither, when the floor was started by
 * 自动配图 (as it checks every reply).
 * @returns {Promise<object>} the parse, as the parser's reply is read (see readReplyPictures)
 */
async function readReply(message, job, data, parserPrompt, chosen, modelMode, { auto, force, line, seedOf }) {
    const settings = getSettings();
    const signal = job.controller.signal;
    const comic = !!parserPrompt.comic;
    data.debug.notes.push(...parserPrompt.notes);
    data.parser = '正文 AI（提示词和正文一起出）';
    // Whether the main AI was told: the last prompt that went out to it.
    const sent = lastInstructionSent();
    if (sent?.active) {
        data.debug.notes.push(sent.included
            ? `发给正文 AI 的请求里有配图说明（${sent.byMacro ? '预设里的 {{comfyRules}}' : '自动插在聊天记录最后'}）`
            : '发给正文 AI 的请求里没有找到配图说明（可能被预设或别的扩展改掉了）');
    }
    const stream = replyStream(message);
    // The reply's text when the message does not have all of it (see below).
    let finalText = null;
    if (!stream) setStage(job, message, 'parsing', '读取正文 AI 写的配图提示词…');
    // Which way this floor went, with how its reply streamed in: what to look at when a floor did not draw early.
    if (!stream) data.debug.notes.push(replyTrace(message));
    if (stream) {
        line.streaming = true;
        line.followed = true;
        const several = comic ? comicPages(parserPrompt.preset) > 1 : sceneLimit(settings.parser) > 1;
        // Worked out again only when another block is complete (the text before a block does not change after it).
        let complete = -1;
        const read = text => {
            try {
                const count = findPromptBlocks(text).filter(block => block.complete).length;
                if (count === complete) return;
                complete = count;
                // The reply so far: its story as written up to now, its complete blocks.
                const now = { ...message, mes: text };
                const partial = readReplyPictures(now, text, { comic, done: false });
                if (!partial) return;
                const scratch = { modelMode, debug: { notes: [] } };
                floorFromParse(now, scratch, partial, parserPrompt, chosen);
                if (!String(scratch.prompt ?? '').trim()) return;
                const drawings = floorDrawings(scratch, null, seedOf, several);
                for (const drawing of [...drawings.scenes, drawings.end]) line.offer(drawing);
                line.state = scratch;
                line.endSlot = drawings.end.slot;
                // (A block that waits for the picture before it is shown as waiting at once.)
                render(message);
            } catch (error) {
                log('提示词和正文一起出：这一块还不能画', error);
            }
        };
        setStage(job, message, 'parsing', '正文 AI 还在写：写好一张图的提示词就先画…');
        read(stream.text);
        const stop = stream.listen(read);
        let ended;
        job.parsing = true;
        try {
            ended = await new Promise((resolve, reject) => {
                stream.done.then(resolve);
                if (signal.aborted) reject(abortError());
                signal.addEventListener('abort', () => reject(abortError()), { once: true });
            });
        } finally {
            stop();
            job.parsing = false;
            line.streaming = false;
        }
        data.debug.notes.push(replyTrace(message));
        // Stopped part way: no pictures, as for any reply that was stopped.
        if (ended.stopped) throw abortError();
        assertMode(modelMode);
        // SillyTavern puts the whole text into the message when the stream is over: every block that streamed in is
        // waited for there (a moment at most; the stream's own text is read otherwise).
        const written = text => findPromptBlocks(text).filter(block => block.complete).length;
        const streamed = written(ended.text);
        for (let waited = 0; waited < 2000 && written(swipeText(message, job.swipeId)) < streamed; waited += 50) await sleep(50, signal);
        if (written(swipeText(message, job.swipeId)) < streamed) finalText = ended.text;
        if (auto && !force && settings.skipBadReplies !== false) {
            const problem = await replyProblem(message);
            if (problem) {
                const error = new Error(problem);
                error.replyProblem = true;
                throw error;
            }
        }
    }
    const text = finalText ?? swipeText(message, job.swipeId);
    const blocks = findPromptBlocks(text).filter(block => block.complete);
    data.parserRaw = truncate(blocks.map(block => block.json).join('\n\n'), 6000);
    data.parserReasoning = '';
    data.parserFinish = '';
    const parsed = readReplyPictures(message, text, { comic });
    if (parsed) return parsed;
    // Said, not only noted: the main AI not writing them is what to look at.
    const why = sent?.active && !sent.included ? '（这次发给正文 AI 的请求里没有找到配图说明）' : '';
    if (!force) toastr.info(`#${ctx().chat.indexOf(message)} 正文 AI 没有写${blocks.length ? '能读出来的' : ''}配图提示词块，这一楼没有配图${why}。可以重新生成这一楼。`, 'ComfyUI 角色配图', { timeOut: 8000 });
    if (force) {
        const error = new Error('这一楼的正文里没有能用的配图提示词块（正文 AI 没写，或者写的不是 JSON）。可以重新生成这一楼，或者关掉「提示词和正文一起出」改用解析模型');
        error.fromReply = true;
        throw error;
    }
    return { skip: true, reason: blocks.length ? '正文 AI 写的配图提示词块读不出来（不是 JSON）' : '正文 AI 这一楼没有写配图提示词' };
}

async function runJob(message, job, options) {
    // 按画面自动切换模型: the main AI's rating marker picks the mode before anything else happens (an edited
    // prompt was written for the mode it was edited in, so it is drawn there).
    const rating = options.mode === 'edit' ? { mode: null, note: '' } : floorRating(message, job.swipeId);
    try {
        await enterMode(job, message, rating.mode);
    } catch (error) {
        // Cancelled while waiting for the other mode's pictures.
        jobs.delete(message);
        activeJobs.delete(job);
        render(message);
        if (isAbortError(error)) toastr.info('已取消配图');
        else warn(error);
        return;
    }
    try {
        await runJobInMode(message, job, options, rating.note);
    } finally {
        leaveMode();
    }
}

/** One job, in the image model mode it was let in with. */
async function runJobInMode(message, job, options, ratingNote) {
    const settings = getSettings();
    const signal = job.controller.signal;
    const previous = swipeData(message, job.swipeId);
    const data = previous ? structuredClone(previous) : { v: 1, images: [], index: 0 };
    data.images ??= [];
    const mode = ['edit', 'reroll', 'resend'].includes(options.mode) ? options.mode : 'reparse';
    // 🎲, and 重新发送提示词 (the floor's prompts drawn again without asking the parser).
    const again = mode === 'reroll' || mode === 'resend';
    // The whole job uses one image model mode; switching modes cancels it (see assertMode).
    const modelMode = currentMode();
    // The floor's state was made in the other mode: 🔄 parses it again instead of reusing that model's prompt, and
    // the state only changes over to this mode once this run has replaced it (`converted`).
    const otherMode = !!previous && floorMode(previous) !== modelMode && hasFloorState(previous);
    let converted = !otherMode;
    if (converted) data.modelMode = modelMode;
    // The user asked for a picture: a 🔄 that has to parse again must not be skipped.
    const force = !!options.force || (again && otherMode);
    // The floor's pictures at ComfyUI (see FloorLine), shown as they are done (画好一张显示一张).
    const line = new FloorLine(job, message, modelMode);
    job.preview = () => line.preview();
    // The prompts were there when it failed: ComfyUI's step failed (重新发送提示词 can send them again).
    let prompted = false;

    try {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const mesId = ctx().chat.indexOf(message);
        if (mesId < 0) return;

        data.error = null;
        delete data.failedAt;
        data.debug = { ...(data.debug || {}), notes: [] };
        if (ratingNote) data.debug.notes.push(ratingNote);
        // 多张图: 🎲 / ✏️ on one picture of a version redraws only that picture.
        if (Number.isInteger(options.scene)) {
            await redrawPicture(message, job, data, options, modelMode, otherMode);
            log(`#${mesId} 单独重画完成`, data);
            return;
        }
        // Edit-dialog choices stay with the floor for 🔄 (new seed, same settings) until it is parsed again.
        let overrides = mode === 'edit' ? options.overrides ?? null : again ? data.editOverrides ?? null : null;
        // Each picture's seed, by its place in the floor: a picture drawn while the parser was still writing (边解析边
        // 出图) is the same picture when the whole reply asks for it.
        const randomSeeds = new Map();
        const seedOf = (slot, comfy) => {
            if (slot === 'end' && (mode === 'edit' || mode === 'resend') && Number.isFinite(overrides?.seed) && overrides.seed >= 0) return overrides.seed;
            const fixedSeed = Number(comfy.seed);
            if (mode !== 'reroll' && fixedSeed >= 0) return fixedSeed;
            if (!randomSeeds.has(slot)) randomSeeds.set(slot, randomSeed());
            return randomSeeds.get(slot);
        };

        if (mode === 'resend' && data.prompt && !otherMode) data.debug.notes.push('没有重新解析：把这一楼解析好的提示词重新发给了 ComfyUI');
        if (mode === 'reparse' || !data.prompt || (again && otherMode)) {
            overrides = null;
            delete data.editOverrides;
            delete data.promptEdited;
            if (again && otherMode) data.debug.notes.push(`这一楼上次是 ${modeLabel(floorMode(previous))} 模式画的，已按 ${modeLabel(modelMode)} 模式重新解析`);
            setStage(job, message, 'parsing', '正在解析角色状态…');
            const target = resolveTarget(message, options.target);
            // Recorded before the request so a failed floor still shows who it was for.
            applyTarget(data, target);
            // 提示词和正文一起出: the main AI wrote the pictures into its reply; no parser model is asked.
            const inline = promptsInReply(settings);
            const parserPrompt = inline ? replyParserPrompt(target) : await buildParserPrompt(mesId, target);
            let parsed;
            if (inline) {
                parsed = await readReply(message, job, data, parserPrompt, target, modelMode, { auto: !!options.auto, force, line, seedOf });
            } else {
                if (force) parserPrompt.user += FORCE_NOTE;
                // 边解析边出图: the pictures the reply settles while it streams in go to ComfyUI at once.
                const early = earlyDrawing(message, modelMode, parserPrompt, target, force, line, null, seedOf);
                parsed = await askParser(message, job, data, parserPrompt, target, modelMode, early);
            }
            if (parsed.skip && !force) {
                // A skip in this mode leaves the other mode's picture state as it was.
                if (!converted) restoreFloorState(data, previous);
                data.skipped = parsed.reason || '解析模型判断本楼无需出图';
                commit(message, job.swipeId, data);
                log(`#${mesId} 跳过:`, data.skipped);
                return;
            }
            floorFromParse(message, data, parsed, parserPrompt, target);
            data.modelMode = modelMode;
            converted = true;
            // Floors parsed while this one waits for ComfyUI read its new state (outfit and scene continuity).
            data.skipped = null;
            commit(message, job.swipeId, structuredClone(data));
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
            // The dialog shows the negative prompt too and sends it as typed. Without one (/ctimg prompt=...), the
            // negative is built again so the parser's tags for this floor cannot work against the typed prompt.
            if (typeof options.negative === 'string') data.negative = options.negative;
            else if (!otherMode) data.negative = buildNegativePrompt(floorPreset(data), data.parsed, data.prompt);
            // Sent exactly as typed, so it can be compared with the same text in ComfyUI (only a JSON layout's boxes
            // are fitted when the size changes, see below).
            data.prompt = String(options.prompt ?? '');
            const canvas = options.canvas;
            if (canvas?.width > 0 && canvas?.height > 0) data.canvas = { width: Number(canvas.width), height: Number(canvas.height) };
            else delete data.canvas;
            data.promptEdited = true;
            data.editOverrides = overrides ?? undefined;
            // The edited prompt is the end of the floor only: the earlier parts are not drawn again.
            delete data.scenes;
            delete data.endStart;
            delete data.endStartAt;
            data.debug.notes.push('提示词由用户手动编辑（原样发送）');
        } else if (!data.promptEdited && !data.editOverrides) {
            // 🔄 keeps the prompt, but trigger words added or changed since then are put in (not into an edited prompt).
            const finished = finishPrompt(data.prompt);
            if (finished !== data.prompt) data.debug.notes.push('补上了本模式的触发词');
            data.prompt = finished;
            for (const scene of data.scenes ?? []) scene.prompt = finishPrompt(scene.prompt);
        }
        data.skipped = null;
        if (!String(data.prompt ?? '').trim()) throw new Error('最终提示词为空');

        // The pictures go to ComfyUI one at a time, the jobs' in the order they got there (see FloorLine); the ones drawn
        // while the parser was still writing are kept when the whole reply asks for the same picture.
        prompted = true;
        const drawings = floorDrawings(data, overrides, seedOf);
        const [endEntry, ...sceneEntries] = line.settle(drawings);
        line.state = data;
        const { plan } = drawings;
        const { preset, profile, comfy, width, height } = plan;
        if (profile) data.debug.notes.push(`渲染配置：${profile.name}（角色预设「${resolveMacros(preset.name)}」）`);
        else if (preset?.renderProfileId && !plan.boundProfile) data.debug.notes.push('角色预设选的渲染配置已被删除，使用默认 ComfyUI 设置');
        if (overrides) {
            const described = describeOverrides(overrides);
            if (described) data.debug.notes.push(described);
        }
        if (plan.sizeFromPreset) data.debug.notes.push(`分辨率来自解析预设：${width}×${height}`);
        if (plan.aspectFromParser) data.debug.notes.push(`宽高比 ${plan.aspect} 由解析模型选择：${width}×${height}`);
        // A JSON layout (漫画模式) is in pixels of the canvas it was written for: drawn at another size, it is scaled.
        if (data.canvas) {
            if (drawings.end.prompt !== data.prompt) data.debug.notes.push(`JSON 版面的坐标从 ${data.canvas.width}×${data.canvas.height} 换算到了 ${width}×${height}`);
            data.prompt = drawings.end.prompt;
            data.canvas = { width, height };
        }

        const end = await endEntry.result;
        // A switch during the upload cancelled this picture: the floor is not touched.
        assertMode(modelMode);
        addNotes(data.debug.notes, endEntry.notes);
        if (end.template.refine) {
            data.debug.notes.push(comfy.mode === 'direct'
                ? 'ComfyUI 端提示词扩写已开启：实际用来出图的是扩写后的文字（见下方）'
                : 'ComfyUI 端提示词扩写已开启：实际用来出图的是扩写后的文字（「酒馆后端代理」模式拿不到扩写结果，切到「浏览器直连」可以在调试里看到）');
        }
        data.params = drawingParams(plan, end.template, end.values, modelMode);
        if (settings.debug) data.debug.workflow = end.workflow;
        else delete data.debug.workflow;
        data.comfyMs = end.ms;
        data.refinedPrompt = refinedText(end.template, end.image);
        const { src, path } = end.stored;
        const mark = laterMark(end.later, end.image);
        const seed = drawings.end.seed;

        // 多张图: the earlier parts of the floor, with the same model, LoRAs and size. One that fails is noted and
        // left out; the end of the floor is kept.
        const scenes = [];
        for (const [index, entry] of sceneEntries.entries()) {
            const scene = data.scenes[index];
            try {
                const picture = await entry.result;
                assertMode(modelMode);
                addNotes(data.debug.notes, entry.notes);
                scenes.push({
                    ...picture.stored, ...laterMark(picture.later, picture.image), seed: entry.drawing.seed, width: entry.drawing.width, height: entry.drawing.height,
                    prompt: scene.prompt,
                    negative: scene.negative || '',
                    refined: refinedText(picture.template, picture.image) || undefined,
                    label: scene.label,
                    start: scene.start || '',
                    place: scene.place || '',
                    startAt: scene.startAt,
                    placeAt: scene.placeAt,
                    ...('presetId' in scene ? { presetId: scene.presetId, target: scene.target } : {}),
                });
            } catch (error) {
                if (isAbortError(error)) throw error;
                warn(error);
                addNotes(data.debug.notes, entry.notes);
                data.debug.notes.push(`「${scene.label}」这一张没画成：${truncate(errorMessage(error), 300)}`);
            }
        }
        // The pictures are the floor's now.
        line.keep();

        addVersion(data, {
            src, path, ...mark, seed, width, height,
            prompt: data.prompt,
            negative: data.negative || '',
            refined: data.refinedPrompt || undefined,
            // 多张图: where the end of the floor starts in the text, and the earlier parts' pictures.
            start: scenes.length ? data.endStart || '' : undefined,
            startAt: scenes.length ? data.endStartAt : undefined,
            // 图片插在正文中间: the paragraph this picture goes after.
            place: data.place || undefined,
            placeAt: data.placeAt,
            // Where the story began and ended when it was drawn: pictures go into that stretch of the text.
            ...(data.storyStart ? { storyStart: data.storyStart, storyEnd: data.storyEnd, storyEnding: data.storyEnding } : {}),
            scenes: scenes.length ? scenes : undefined,
            // 提示词和正文一起出: in the story where the main AI put the blocks, whatever 图片插在正文中间 says.
            ...(data.fromReply ? { inStory: true } : {}),
            mode: modelMode,
            time: Date.now(),
        });
        data.modelMode = modelMode;
        if (commit(message, job.swipeId, data) && (message.swipe_id ?? 0) === job.swipeId) {
            imageAdded(ctx().chat.indexOf(message));
        }
        queueUpscales(message, job.swipeId, data.images.at(-1));
        log(`#${mesId} 完成`, data);
    } catch (error) {
        // 提示词和正文一起出: a reply that came out cut off or blocked gets no picture, as 自动配图 would decide.
        if (error?.replyProblem) {
            toastr.info(`${error.message}，没有自动配图。需要的话可以手动生成。`, 'ComfyUI 角色配图', { timeOut: 5000 });
            return;
        }
        if (isAbortError(error)) {
            toastr.info(error.modeChanged || currentMode() !== modelMode ? '切换了模型模式，已取消这次配图' : '已取消配图');
            return;
        }
        console.error('[ComfyPortrait]', error);
        // A failure in this mode leaves the other mode's picture state usable there.
        if (!converted) restoreFloorState(data, previous);
        data.error = errorMessage(error);
        // 重新发送提示词: the floor's prompts are kept, so they can go to ComfyUI again without the parser.
        if (prompted && hasFloorState(data)) data.failedAt = 'comfy';
        commit(message, job.swipeId, data);
        const where = data.failedAt ? '（ComfyUI）' : error?.fromReply ? '（正文 AI 的配图提示词）' : error?.parsing || job.stage === 'parsing' ? '（解析模型）' : job.stage === 'drawing' ? '（ComfyUI）' : '';
        const resend = data.failedAt ? '。提示词已经保存：ComfyUI 好了以后点这一楼的「重新发送提示词」，不用重新解析' : '';
        toastr.error(`${truncate(data.error, 300)}${resend}`, `配图失败${where}`);
    } finally {
        // Pictures not kept (failed, cancelled, skipped) are stopped and deleted; a job still waiting for ComfyUI
        // leaves the line.
        line.dropAll();
        job.leaveLine?.();
        job.endDrawing?.();
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
    // 提示词和正文一起出: what the main AI's blocks say (no parser model).
    const inline = promptsInReply();
    const parserPrompt = inline ? replyParserPrompt(target) : await buildParserPrompt(mesId, target);
    let reply;
    let raw;
    if (inline) {
        raw = readReplyPictures(message, message.mes, { comic: parserPrompt.comic });
        if (!raw) throw new Error('这一楼的正文里没有能用的配图提示词块（正文 AI 没写，或者写的不是 JSON）');
        reply = { content: findPromptBlocks(message.mes).map(block => block.json).join('\n\n'), reasoning: '', finish: '' };
    } else {
        ({ reply, parsed: raw } = await requestParse(parserPrompt.system, parserPrompt.user, undefined, { minTokens: parserPrompt.minTokens, comic: parserPrompt.comic }));
    }
    if (currentMode() !== modelMode) throw new Error('试运行期间切换了模型模式，结果已丢弃');
    const notes = [...parserPrompt.notes];
    const chosen = target;
    const { subject, sceneSubject } = raw.skip ? { subject: target, sceneSubject: () => target } : subjectsOf(chosen, raw, parserPrompt, message, notes);
    target = subject;
    const built = raw.skip ? { parsed: raw, prompt: '' } : promptFromParse(subjectPreset(target), raw, parserPrompt, notes, { nobody: !!target.nobody });
    const limit = isComicPreset(parserPrompt.preset) ? comicPages(parserPrompt.preset) : sceneLimit(getSettings().parser);
    const scenes = raw.skip || limit < 2 ? [] : (raw.earlierScenes ?? []).slice(0, limit - 1).map((scene, index) => ({
        label: scene.label || `第 ${index + 1} 段`,
        prompt: scenePrompt(scene, sceneSubject(scene), target, built.parsed, parserPrompt).prompt,
    }));
    return {
        scenes,
        target,
        parserPrompt,
        reply,
        parsed: built.parsed,
        notes,
        prompt: built.prompt,
        negative: buildNegativePrompt(target.preset, built.parsed, built.prompt),
    };
}
