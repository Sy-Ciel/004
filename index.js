import { EXTRA_KEY, LOG_PREFIX, MODEL_LABELS, MODEL_MODES, TARGET_AUTO, TARGET_CHAR, TARGET_USER } from './src/constants.js';
import { lastFloorId, reviewParserInput, showFloorDebug } from './src/debug.js';
import { openEditDialog } from './src/editDialog.js';
import { captureHints, hintsEnabled, openHintDialog, pendingHints, removeHint, stripHints, stripOutgoingChat } from './src/hints.js';
import { injectMessageButtons } from './src/messageButtons.js';
import { resetPanelForChat, showInPanel } from './src/panel.js';
import { cancelAllJobs, cancelJob, cancelUpscales, dropUpscales, enqueue, getJob, resumeUpscales, retryUpscales, setImageAddedHandler, setModeSwitcher, setParserReviewer, setRenderer } from './src/pipeline.js';
import { currentIndex, removePicture } from './src/markup.js';
import { onLayoutChange, renderAll, renderMessage } from './src/render.js';
import { updateRatingPrompt } from './src/rating.js';
import { replyProblem } from './src/replyCheck.js';
import { setEnabled, updateQuickToggle } from './src/quickToggle.js';
import { updateStatusPrompt } from './src/statusBar.js';
import { BLOCK_LABEL, findPromptBlocks, promptsInReply, replyEnded, replyStarted, replyToken, stripOldBlocks, stripOldBlocksText } from './src/inReply.js';
import { REPLY_MACRO, dropAutomaticInstruction, dropAutomaticInstructionText, noteInstructionSent, replyInstructionMacro, updateReplyPrompt } from './src/parser.js';
import { currentMode, imageMode, modeLabel } from './src/modes.js';
import { findParserPreset } from './src/parserPresets.js';
import { findPresetByName, findPresetById, initPersonaTracking } from './src/targets.js';
import { autoSwitchModelMode, initSettingsUi, onPersonaChanged, refreshTargetSelect, switchModelMode, syncPersonaProfile, syncSettingsUi } from './src/ui.js';
import { applyCardParamPreset } from './src/ui-param-presets.js';
import { ctx, getMessageData, getSettings, log, saveSettings, setMessageData } from './src/utils.js';

let lastStoppedAt = 0;

/* ---------------- automatic trigger ---------------- */

function aiFloorNumber(mesId) {
    let count = 0;
    const chat = ctx().chat;
    for (let i = 0; i <= mesId; i++) {
        if (chat[i] && !chat[i].is_user && !chat[i].is_system) count++;
    }
    return count;
}

/** Greeting floors: AI messages with no user message before them (covers alternate and group greetings). */
function isGreetingFloor(mesId) {
    const chat = ctx().chat;
    for (let i = 0; i < mesId; i++) {
        if (chat[i]?.is_user) return false;
    }
    return true;
}

/** Whether 自动配图 draws this floor (a reply just done, or still streaming in): everything but how the reply came out. */
function autoAllowed(mesId, type) {
    const settings = getSettings();
    if (!settings.enabled || !settings.autoGenerate) return false;
    const chat = ctx().chat;
    const message = chat[mesId];
    if (!message || message.is_user || message.is_system || !String(message.mes || '').trim()) return false;
    if (['impersonate', 'quiet'].includes(type)) return false;
    // A finished reply is always the newest floor. Other extensions / card scripts may re-emit the rendered
    // event for older floors (or rewrite the greeting); those must not start generations.
    if (mesId !== chat.length - 1) return false;
    if (!settings.includeFirstMessage && (type === 'first_message' || isGreetingFloor(mesId))) return false;
    // A stopped/aborted stream also emits the rendered event; don't draw half a message.
    if (Date.now() - lastStoppedAt < 2000) return false;
    if (getJob(message)) return false;

    // Any earlier result (image, error or skip) means this floor was already handled; only an explicit
    // "continue" with the regenerate option asks for a new version.
    const existing = getMessageData(message);
    if (existing && !(type === 'continue' && settings.regenOnContinue)) return false;

    // Drawing instructions always get a picture, even between "every N floors".
    const hasHints = pendingHints(mesId).length > 0;
    const everyN = Math.max(1, Number(settings.everyN) || 1);
    return !(everyN > 1 && aiFloorNumber(mesId) % everyN !== 0 && !hasHints);
}

async function maybeAutoGenerate(mesId, type) {
    const settings = getSettings();
    if (!autoAllowed(mesId, type)) return;
    const chat = ctx().chat;
    const message = chat[mesId];
    const existing = getMessageData(message);

    // 正文截断、安全检查、提示词过滤: a reply that was cut off or blocked gets no picture (after 「继续」 finishes it,
    // it is checked again).
    if (settings.skipBadReplies !== false) {
        const swipeId = message.swipe_id ?? 0;
        const modelMode = currentMode();
        const problem = await replyProblem(message);
        // The rules above were the old mode's; after a mode switch meanwhile, leave it to the new mode's.
        if (currentMode() !== modelMode) return;
        // Counting tokens can wait on the server; skip if the chat, swipe or floor state changed meanwhile.
        const current = ctx().chat;
        if (current !== chat || current[mesId] !== message || mesId !== current.length - 1) return;
        if ((message.swipe_id ?? 0) !== swipeId || getJob(message) || getMessageData(message) !== existing) return;
        if (problem) {
            log(`#${mesId} ${problem}，不自动配图`);
            toastr.info(`#${mesId} ${problem}，没有自动配图。需要的话可以手动生成。`, 'ComfyUI 角色配图', { timeOut: 5000 });
            return;
        }
    }

    log(`自动配图 #${mesId} (${type ?? 'normal'})`);
    enqueue(mesId, { mode: 'reparse', auto: true });
}

/** The type of the generation whose reply is streaming in (see onReplyToken). */
let streamType = 'normal';

/**
 * 提示词和正文一起出: a token of a reply streaming in. Once one of its picture blocks is complete, 自动配图 starts the
 * floor at once: that picture goes to ComfyUI while the main AI writes on (see readReply in pipeline.js).
 */
function onReplyToken(text) {
    const reply = replyToken(text);
    if (!reply || getJob(reply.message) || !reply.text.includes('</details')) return;
    if (!findPromptBlocks(reply.text).some(block => block.complete)) return;
    const mesId = ctx().chat.indexOf(reply.message);
    if (!autoAllowed(mesId, streamType)) return;
    log(`自动配图 #${mesId}（正文还在写，第一张图的提示词已经写好）`);
    enqueue(mesId, { mode: 'reparse', auto: true });
}

/**
 * {{comfyRules}}: the instruction of 提示词和正文一起出, for the user's own preset. SillyTavern's older registration
 * works with both of its macro engines (it hands the macro on to the new one when that is on); the newer one alone
 * only reaches the new engine.
 */
function registerReplyMacro() {
    const context = ctx();
    const description = 'ComfyUI 角色配图：「提示词和正文一起出」时，告诉正文 AI 怎么写配图提示词块的说明（开关关着时为空）。用了它，扩展就不再自动插入这份说明';
    try {
        if (typeof context.registerMacro === 'function') context.registerMacro(REPLY_MACRO, () => replyInstructionMacro(), description);
        else context.macros?.register?.(REPLY_MACRO, { handler: () => replyInstructionMacro(), description });
    } catch (error) {
        console.warn(LOG_PREFIX, error);
    }
}

/** 提示词和正文一起出: picture blocks are hidden from the moment they are shown, while a reply streams in too. */
function hidePromptBlocks(chatElement) {
    new MutationObserver(mutations => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (!(node instanceof HTMLElement) || !node.textContent.includes(BLOCK_LABEL)) continue;
                for (const details of node.matches('details') ? [node] : node.querySelectorAll('details')) {
                    if (details.querySelector(':scope > summary')?.textContent.includes(BLOCK_LABEL)) details.classList.add('ctp-prompt-block');
                }
            }
        }
    }).observe(chatElement, { childList: true, subtree: true });
}

/* ---------------- per-floor actions ---------------- */

/**
 * 🗑: deletes the shown version. 多张图: `scene` names one picture of it (its index in image.scenes, -1 = the end
 * of the floor) and only that picture goes, the others stay where they are; the toolbar under a whole set deletes
 * the set, after asking.
 */
async function deleteImage(mesId, scene = null) {
    const message = ctx().chat[mesId];
    const data = getMessageData(message);
    if (!data?.images?.length) return;
    const swipeId = message.swipe_id ?? 0;
    const index = Math.min(Math.max(0, data.index ?? 0), data.images.length - 1);
    const shown = data.images[index];
    const count = (shown.scenes?.length ?? 0) + 1;
    let removed;
    if (count > 1 && Number.isInteger(scene) && (scene < 0 || shown.scenes[scene])) {
        removed = [removePicture(shown, scene)];
    } else {
        if (count > 1) {
            const { callGenericPopup, POPUP_TYPE, POPUP_RESULT } = ctx();
            const answer = await callGenericPopup(`删除这一版的全部 ${count} 张图？<br>只想删其中一张，点那张图上方的 🗑。`, POPUP_TYPE.CONFIRM);
            if (answer !== POPUP_RESULT.AFFIRMATIVE) return;
            // The popup can stay open while the floor changes: only delete the version it was asked about.
            if (getMessageData(ctx().chat[mesId]) !== data || data.images[index] !== shown) return;
        }
        data.images.splice(index, 1);
        data.index = Math.max(0, Math.min(index, data.images.length - 1));
        removed = [shown, ...(shown.scenes ?? [])];
    }
    setMessageData(message, swipeId, data.images.length || data.error || data.skipped ? data : null);
    await ctx().saveChat();
    renderMessage(mesId);
    // A picture's file goes with it, except one another version still shows (redrawing one picture copies the
    // others into the new version).
    const paths = image => [image?.path, ...(image?.scenes ?? []).map(part => part.path)].filter(Boolean);
    const kept = new Set(data.images.flatMap(paths));
    for (const path of removed.map(picture => picture?.path).filter(Boolean)) {
        if (kept.has(path)) continue;
        fetch('/api/images/delete', {
            method: 'POST',
            headers: ctx().getRequestHeaders(),
            body: JSON.stringify({ path }),
        }).catch(() => {});
    }
}

async function changeIndex(mesId, delta) {
    const message = ctx().chat[mesId];
    const data = getMessageData(message);
    if (!data?.images?.length) return;
    const count = data.images.length;
    data.index = ((data.index ?? 0) + delta + count) % count;
    setMessageData(message, message.swipe_id ?? 0, data);
    renderMessage(mesId);
    await ctx().saveChat();
}

async function clearState(mesId) {
    const message = ctx().chat[mesId];
    const data = getMessageData(message);
    if (!data) return;
    data.error = null;
    setMessageData(message, message.swipe_id ?? 0, data.images?.length ? data : null);
    renderMessage(mesId);
    await ctx().saveChat();
}

function zoom(mesId, scene = -1, src = '') {
    const data = getMessageData(ctx().chat[mesId]);
    const image = data?.images?.[Math.max(0, data.index ?? 0)];
    // 画好一张显示一张: a picture of a floor still being drawn is in no version yet: shown as it is.
    // 多张图: one of the earlier parts of the floor (-1 = the end of the floor).
    const picture = src ? { src } : scene >= 0 ? image?.scenes?.[scene] ?? image : image;
    if (!picture?.src) return;
    const { callGenericPopup, POPUP_TYPE } = ctx();
    const root = document.createElement('div');
    root.className = 'ctp-zoom';
    const img = document.createElement('img');
    img.src = picture.src;
    root.appendChild(img);
    callGenericPopup(root, POPUP_TYPE.DISPLAY ?? POPUP_TYPE.TEXT, '', { large: true, wide: true, allowVerticalScrolling: true });
}

/** 「加画图指令重画」: edit the floor's drawing instructions, then parse it again with them; the text stays. */
async function redrawWithHints(mesId) {
    // 提示词和正文一起出: no parser model reads the instructions; the main AI gets them with its next reply.
    if (promptsInReply()) {
        toastr.info('「提示词和正文一起出」开着：画图指令交给正文 AI，在它下一次写正文时生效。要按新的指令重画这一楼，请让正文 AI 重写这一楼（重新生成 / 滑动），或者先关掉这个开关改用解析模型', 'ComfyUI 角色配图', { timeOut: 8000 });
        return;
    }
    const message = ctx().chat[mesId];
    const data = getMessageData(message);
    const image = data?.images?.[Math.max(0, data.index ?? 0)];
    const hints = await openHintDialog(mesId, image?.prompt || data?.prompt || '');
    if (!hints) return;
    const index = ctx().chat.indexOf(message);
    if (index < 0) return;
    renderMessage(index);
    ctx().saveChat();
    if (hints.length) enqueue(index, { mode: 'reparse', force: true });
    else toastr.info(`已删除 #${index} 的画图指令`);
}

/**
 * 多张图: 🎲 (reroll) / 🔄 (reparse) on one picture redraws only that picture of the shown version (a new
 * version with it replaced); 🔄 asks the parser for that part again first.
 */
function redrawPicture(mesId, scene, mode = 'reroll') {
    const data = getMessageData(ctx().chat[mesId]);
    if (!data?.images?.length || !Number.isInteger(scene)) return;
    const version = currentIndex(data);
    const drawnIn = imageMode(data.images[version]);
    if (drawnIn !== currentMode() && !getSettings().autoModelByRating) {
        toastr.warning(`这一版是 ${modeLabel(drawnIn)} 模式画的，切回 ${modeLabel(drawnIn)} 模式再单独重画`);
        return;
    }
    enqueue(mesId, { mode, scene, version });
}

function onAction(event) {
    const button = event.currentTarget;
    // Buttons live either inside a chat message or in the side panel (which carries data-mesid).
    const owner = button.closest('[data-mesid]') ?? button.closest('.mes');
    const mesId = Number(owner?.dataset.mesid ?? owner?.getAttribute('mesid'));
    if (!Number.isInteger(mesId)) return;
    event.preventDefault();
    event.stopPropagation();
    switch (button.dataset.act) {
        case 'cancel': cancelJob(ctx().chat[mesId]); break;
        case 'prev': changeIndex(mesId, -1); break;
        case 'next': changeIndex(mesId, 1); break;
        case 'reroll': enqueue(mesId, { mode: 'reroll' }); break;
        case 'reparse': enqueue(mesId, { mode: 'reparse', force: true }); break;
        // ComfyUI failed after the parse: the same prompts again, without the parser.
        case 'resend': enqueue(mesId, { mode: 'resend' }); break;
        case 'force': enqueue(mesId, { mode: 'reparse', force: true }); break;
        case 'edit': openEditDialog(mesId); break;
        // 多张图: one picture of the shown version.
        case 'picture-reroll': redrawPicture(mesId, Number(button.dataset.scene)); break;
        case 'picture-reparse': redrawPicture(mesId, Number(button.dataset.scene), 'reparse'); break;
        case 'picture-edit': openEditDialog(mesId, Number(button.dataset.scene)); break;
        case 'picture-delete': deleteImage(mesId, Number(button.dataset.scene)); break;
        case 'hint': redrawWithHints(mesId); break;
        // 先画完所有图，再统一放大
        case 'upscale-retry': retryUpscales(mesId); break;
        case 'upscale-drop': dropUpscales(mesId); break;
        case 'debug': showFloorDebug(mesId); break;
        case 'delete': deleteImage(mesId); break;
        case 'clear': clearState(mesId); break;
        case 'zoom': zoom(mesId, Number(button.dataset.scene ?? -1), button.dataset.live ? button.getAttribute('src') : ''); break;
        case 'panel': showInPanel(mesId); break;
        case 'hint-remove':
            removeHint(ctx().chat[mesId], Number(button.dataset.index));
            renderMessage(mesId);
            ctx().saveChat();
            break;
    }
}

function onMessageButton() {
    const mesId = Number($(this).closest('.mes').attr('mesid'));
    if (!Number.isInteger(mesId)) return;
    enqueue(mesId, { mode: 'reparse', force: true });
}

function injectWandButton() {
    const menu = $('#extensionsMenu');
    if (!menu.length || $('#ctp_wand').length) return;
    const item = $(`<div id="ctp_wand" class="list-group-item flex-container flexGap5" title="ComfyUI 角色配图：为最新楼层生成配图">
        <div class="fa-solid fa-image extensionsMenuExtensionButton"></div>
        <span>为最新楼层生成配图</span>
    </div>`);
    item.on('click', () => {
        const mesId = lastFloorId();
        if (mesId >= 0) enqueue(mesId, { mode: 'reparse', force: true });
    });
    menu.append(item);
}

/* ---------------- events ---------------- */

function onSwiped(mesId) {
    const message = ctx().chat[mesId];
    if (!message) return;
    // Generating a brand-new swipe: SillyTavern keeps the previous swipe's extra on the message, drop our copy.
    if (Array.isArray(message.swipes) && (message.swipe_id ?? 0) >= message.swipes.length && message.extra?.[EXTRA_KEY]) {
        delete message.extra[EXTRA_KEY];
    }
    renderMessage(mesId);
}

let renderAllTimer = null;
function renderAllSoon() {
    clearTimeout(renderAllTimer);
    renderAllTimer = setTimeout(() => {
        injectMessageButtons();
        updateQuickToggle();
        renderAll();
    }, 50);
}

function registerEvents() {
    const { eventSource, eventTypes } = ctx();
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, (mesId, type) => {
        // 提示词和正文一起出: a reply that was streaming in is done (a floor drawing from it reads it whole now).
        replyEnded({ message: ctx().chat[Number(mesId)] });
        renderMessage(Number(mesId));
        maybeAutoGenerate(Number(mesId), type).catch(error => console.warn(LOG_PREFIX, error));
    });
    eventSource.on(eventTypes.USER_MESSAGE_RENDERED, mesId => renderMessage(Number(mesId)));

    // [[drawing instructions]]: cut out of the text before the prompt is built, kept for the image parser only.
    eventSource.on(eventTypes.MESSAGE_SENT, mesId => {
        if (captureHints(Number(mesId))) ctx().saveChat();
    });
    eventSource.on(eventTypes.MESSAGE_EDITED, mesId => {
        if (captureHints(Number(mesId))) ctx().saveChat();
    });
    eventSource.on(eventTypes.CHAT_COMPLETION_PROMPT_READY, data => {
        stripOutgoingChat(data?.chat);
        // 提示词和正文一起出: the main AI sees the picture blocks of its latest floors only, and the instruction once.
        stripOldBlocks(data?.chat);
        dropAutomaticInstruction(data?.chat);
        if (!data?.dryRun) noteInstructionSent(data?.chat);
    });
    eventSource.on(eventTypes.GENERATE_AFTER_COMBINE_PROMPTS, data => {
        if (hintsEnabled() && typeof data?.prompt === 'string') data.prompt = stripHints(data.prompt);
        if (typeof data?.prompt === 'string') data.prompt = dropAutomaticInstructionText(stripOldBlocksText(data.prompt));
        if (typeof data?.prompt === 'string' && !data.dryRun) noteInstructionSent(data.prompt);
    });
    if (eventTypes.STREAM_TOKEN_RECEIVED) eventSource.on(eventTypes.STREAM_TOKEN_RECEIVED, onReplyToken);
    eventSource.on(eventTypes.MESSAGE_SWIPED, mesId => onSwiped(Number(mesId)));
    eventSource.on(eventTypes.MESSAGE_UPDATED, mesId => renderMessage(Number(mesId)));
    eventSource.on(eventTypes.MESSAGE_EDITED, mesId => renderMessage(Number(mesId)));
    eventSource.on(eventTypes.MESSAGE_DELETED, renderAllSoon);
    eventSource.on(eventTypes.MORE_MESSAGES_LOADED, renderAllSoon);
    eventSource.on(eventTypes.GENERATION_STOPPED, () => {
        lastStoppedAt = Date.now();
        replyEnded({ stopped: true });
    });
    // Status bar instruction for the main AI: refreshed per generation (who to describe can change, and quiet
    // generations must not get it).
    eventSource.on(eventTypes.GENERATION_STARTED, async (type, _options, dryRun) => {
        updateStatusPrompt(type);
        updateRatingPrompt(type);
        // 提示词和正文一起出: the main AI is told to write the picture blocks, and its reply is followed.
        if (!dryRun && !['quiet', 'impersonate'].includes(type)) streamType = type || 'normal';
        replyStarted(type, dryRun);
        await updateReplyPrompt(type);
    });
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        replyEnded({ stopped: true });
        updateStatusPrompt();
        updateRatingPrompt();
        updateReplyPrompt();
        cancelAllJobs();
        cancelUpscales();
        resetPanelForChat();
        renderAllSoon();
        refreshTargetSelect();
        // A chat locked to a persona switches it on load; its profile follows. Then the card's 出图参数预设 (a profile
        // switch puts it in place itself). Pictures of this chat still waiting for the upscale model get in line.
        setTimeout(() => {
            if (!syncPersonaProfile()) applyCardParamPreset();
            resumeUpscales();
        }, 0);
    });
    // Registered after initPersonaTracking's own listener, so the new persona is already known here.
    if (eventTypes.PERSONA_CHANGED) eventSource.on(eventTypes.PERSONA_CHANGED, onPersonaChanged);

    // Whole-chat re-renders (branch, reload) don't always emit per-message events.
    const chatElement = document.getElementById('chat');
    if (chatElement) hidePromptBlocks(chatElement);
    if (chatElement) {
        new MutationObserver(mutations => {
            if (mutations.some(mutation => [...mutation.addedNodes].some(node => node instanceof HTMLElement && node.classList.contains('mes')))) {
                renderAllSoon();
            }
        }).observe(chatElement, { childList: true });
    }

    onLayoutChange(renderAll);

    $(document).on('click', '.ctp-wrap .ctp-act, #ctp_panel .ctp-act, .ctp-hints .ctp-act, .mes_text .ctp-inserted .ctp-act', onAction);
    $(document).on('click', '.ctp_mes_gen', onMessageButton);
}

/* ---------------- slash commands ---------------- */

function registerSlashCommands() {
    const { SlashCommandParser, SlashCommand, SlashCommandNamedArgument, SlashCommandArgument, ARGUMENT_TYPE } = ctx();
    if (!SlashCommandParser?.addCommandObject) return;

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ctimg',
        helpString: '用 ComfyUI 为某一楼生成角色配图（默认最新 AI 楼层）。',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({ name: 'target', description: '画谁：预设名 / user / char / auto', typeList: [ARGUMENT_TYPE.STRING] }),
            SlashCommandNamedArgument.fromProps({ name: 'at', description: '楼层号', typeList: [ARGUMENT_TYPE.NUMBER] }),
            SlashCommandNamedArgument.fromProps({ name: 'prompt', description: '直接使用这段提示词（跳过解析）', typeList: [ARGUMENT_TYPE.STRING] }),
        ],
        callback: async (args) => {
            const mesId = args.at !== undefined && args.at !== '' ? Number(args.at) : lastFloorId();
            if (!Number.isInteger(mesId) || !ctx().chat[mesId]) {
                toastr.warning('楼层不存在');
                return '';
            }
            const prompt = String(args.prompt || '').trim();
            await enqueue(mesId, prompt
                ? { mode: 'edit', prompt }
                : { mode: 'reparse', force: true, target: args.target ? String(args.target) : undefined });
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ctimg-target',
        helpString: '设置配图目标：预设名 / user / char / auto。不带参数时返回当前目标。',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: '目标', typeList: [ARGUMENT_TYPE.STRING], isRequired: false }),
        ],
        callback: async (_args, value) => {
            const settings = getSettings();
            const wanted = String(value || '').trim();
            if (!wanted) return settings.targetMode;
            const lower = wanted.toLowerCase();
            const mode = lower === 'user' ? TARGET_USER
                : lower === 'char' ? TARGET_CHAR
                    : lower === 'auto' ? TARGET_AUTO
                        : (findPresetById(wanted) ?? findPresetByName(wanted))?.id;
            if (!mode) {
                toastr.warning(`没有名为「${wanted}」的角色预设`);
                return settings.targetMode;
            }
            settings.targetMode = mode;
            saveSettings();
            refreshTargetSelect();
            toastr.success(`配图目标：${wanted}`);
            return mode;
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ctimg-preset',
        helpString: '切换配图风格（解析预设），例如 /ctimg-preset 立绘。不带参数时返回当前预设名。',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: '预设名（可以只写一部分）', typeList: [ARGUMENT_TYPE.STRING], isRequired: false }),
        ],
        callback: async (_args, value) => {
            const settings = getSettings();
            const wanted = String(value || '').trim();
            if (!wanted) return findParserPreset(settings.parserPresetId)?.name ?? '';
            const preset = findParserPreset(wanted);
            if (!preset) {
                toastr.warning(`没有名为「${wanted}」的解析预设`);
                return '';
            }
            settings.parserPresetId = preset.id;
            saveSettings();
            syncSettingsUi();
            toastr.success(`配图风格：${preset.name}`);
            return preset.name;
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ctimg-mode',
        helpString: '提示词生成方式：fixed（固定外貌 + AI 补充）或 ai（AI 写完整提示词）。不带参数时返回当前方式。',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: 'fixed / ai', typeList: [ARGUMENT_TYPE.STRING], isRequired: false }),
        ],
        callback: async (_args, value) => {
            const settings = getSettings();
            const wanted = String(value || '').trim().toLowerCase();
            if (!wanted) return settings.promptMode;
            if (!['fixed', 'ai'].includes(wanted)) {
                toastr.warning('只能是 fixed 或 ai');
                return settings.promptMode;
            }
            settings.promptMode = wanted;
            saveSettings();
            syncSettingsUi();
            toastr.success(wanted === 'ai' ? '提示词生成方式：AI 写完整提示词' : '提示词生成方式：固定外貌 + AI 补充');
            return wanted;
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ctimg-model',
        helpString: '切换模型模式：krea2、anima 或 moss（每个模式的设置分开保存，API 设置和图片显示共用）。不带参数时返回当前模式。',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: 'krea2 / anima / moss', typeList: [ARGUMENT_TYPE.STRING], isRequired: false }),
        ],
        callback: async (_args, value) => {
            const wanted = String(value || '').trim().toLowerCase().replace(/[\s_-]/g, '');
            if (!wanted) return currentMode();
            const mode = MODEL_MODES.find(item => item === wanted || MODEL_LABELS[item].toLowerCase().replace(/[\s_-]/g, '') === wanted);
            if (!mode) {
                toastr.warning('只能是 krea2、anima 或 moss');
                return currentMode();
            }
            if (!switchModelMode(mode)) toastr.info(`已经是 ${modeLabel(mode)} 模式`);
            return mode;
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ctimg-enable',
        helpString: '一键开关 ComfyUI 角色配图（设置里的「启用」）：on / off，不带参数则切换。关掉后不再生成新图，已有的图照常显示。',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: 'on / off', typeList: [ARGUMENT_TYPE.STRING], isRequired: false }),
        ],
        callback: async (_args, value) => {
            const wanted = String(value || '').trim().toLowerCase();
            setEnabled(wanted ? ['on', 'true', '1', '开'].includes(wanted) : !getSettings().enabled);
            return String(getSettings().enabled);
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ctimg-debug',
        helpString: '开关配图调试模式：on / off，不带参数则切换。',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: 'on / off', typeList: [ARGUMENT_TYPE.STRING], isRequired: false }),
        ],
        callback: async (_args, value) => {
            const settings = getSettings();
            const wanted = String(value || '').trim().toLowerCase();
            settings.debug = wanted ? ['on', 'true', '1'].includes(wanted) : !settings.debug;
            saveSettings();
            syncSettingsUi();
            renderAll();
            toastr.info(`配图调试模式：${settings.debug ? '开' : '关'}`);
            return String(settings.debug);
        },
    }));
}

/* ---------------- init ---------------- */

jQuery(async () => {
    try {
        getSettings();
        setRenderer(renderMessage);
        setImageAddedHandler(showInPanel);
        setModeSwitcher(autoSwitchModelMode);
        setParserReviewer(reviewParserInput);
        await initPersonaTracking();
        await initSettingsUi();
        injectMessageButtons();
        injectWandButton();
        updateQuickToggle();
        registerEvents();
        registerReplyMacro();
        registerSlashCommands();
        updateStatusPrompt();
        updateRatingPrompt();
        updateReplyPrompt();
        renderAll();
        console.log(LOG_PREFIX, 'loaded');
    } catch (error) {
        console.error(LOG_PREFIX, 'init failed', error);
        toastr.error(String(error?.message || error), 'ComfyUI 角色配图加载失败');
    }
});
