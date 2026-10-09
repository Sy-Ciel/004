import { EXTRA_KEY, LOG_PREFIX, TARGET_AUTO, TARGET_CHAR, TARGET_USER } from './src/constants.js';
import { lastFloorId, showFloorDebug } from './src/debug.js';
import { resetPanelForChat, showInPanel } from './src/panel.js';
import { cancelAllJobs, cancelJob, enqueue, getJob, setImageAddedHandler, setRenderer } from './src/pipeline.js';
import { onLayoutChange, renderAll, renderMessage } from './src/render.js';
import { findPresetByName, findPresetById, initPersonaTracking } from './src/targets.js';
import { initSettingsUi, onPersonaChanged, refreshTargetSelect, syncSettingsUi } from './src/ui.js';
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

function maybeAutoGenerate(mesId, type) {
    const settings = getSettings();
    if (!settings.enabled || !settings.autoGenerate) return;
    const chat = ctx().chat;
    const message = chat[mesId];
    if (!message || message.is_user || message.is_system || !String(message.mes || '').trim()) return;
    if (['impersonate', 'quiet'].includes(type)) return;
    // A finished reply is always the newest floor. Other extensions / card scripts may re-emit the rendered
    // event for older floors (or rewrite the greeting); those must not start generations.
    if (mesId !== chat.length - 1) return;
    if (!settings.includeFirstMessage && (type === 'first_message' || isGreetingFloor(mesId))) return;
    // A stopped/aborted stream also emits the rendered event; don't draw half a message.
    if (Date.now() - lastStoppedAt < 2000) return;
    if (getJob(message)) return;

    // Any earlier result (image, error or skip) means this floor was already handled; only an explicit
    // "continue" with the regenerate option asks for a new version.
    const existing = getMessageData(message);
    if (existing && !(type === 'continue' && settings.regenOnContinue)) return;

    const everyN = Math.max(1, Number(settings.everyN) || 1);
    if (everyN > 1 && aiFloorNumber(mesId) % everyN !== 0) return;

    log(`自动配图 #${mesId} (${type ?? 'normal'})`);
    enqueue(mesId, { mode: 'reparse' });
}

/* ---------------- per-floor actions ---------------- */

async function editPrompt(mesId) {
    const message = ctx().chat[mesId];
    const data = getMessageData(message);
    const index = Math.max(0, data?.index ?? 0);
    const current = data?.images?.[index]?.prompt || data?.prompt || '';
    const { callGenericPopup, POPUP_TYPE } = ctx();
    const result = await callGenericPopup(`编辑 #${mesId} 的正向提示词，确认后用它重新生成`, POPUP_TYPE.INPUT, current, { rows: 12, wide: true, okButton: '生成' });
    if (typeof result === 'string' && result.trim()) {
        enqueue(mesId, { mode: 'edit', prompt: result });
    }
}

async function deleteImage(mesId) {
    const message = ctx().chat[mesId];
    const data = getMessageData(message);
    if (!data) return;
    const swipeId = message.swipe_id ?? 0;
    const index = Math.min(Math.max(0, data.index ?? 0), data.images.length - 1);
    const [removed] = data.images.splice(index, 1);
    data.index = Math.max(0, Math.min(index, data.images.length - 1));
    setMessageData(message, swipeId, data.images.length || data.error || data.skipped ? data : null);
    await ctx().saveChat();
    renderMessage(mesId);
    if (removed?.path) {
        fetch('/api/images/delete', {
            method: 'POST',
            headers: ctx().getRequestHeaders(),
            body: JSON.stringify({ path: removed.path }),
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

function zoom(mesId) {
    const data = getMessageData(ctx().chat[mesId]);
    const image = data?.images?.[Math.max(0, data.index ?? 0)];
    if (!image) return;
    const { callGenericPopup, POPUP_TYPE } = ctx();
    const root = document.createElement('div');
    root.className = 'ctp-zoom';
    const img = document.createElement('img');
    img.src = image.src;
    root.appendChild(img);
    callGenericPopup(root, POPUP_TYPE.DISPLAY ?? POPUP_TYPE.TEXT, '', { large: true, wide: true, allowVerticalScrolling: true });
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
        case 'force': enqueue(mesId, { mode: 'reparse', force: true }); break;
        case 'edit': editPrompt(mesId); break;
        case 'debug': showFloorDebug(mesId); break;
        case 'delete': deleteImage(mesId); break;
        case 'clear': clearState(mesId); break;
        case 'zoom': zoom(mesId); break;
        case 'panel': showInPanel(mesId); break;
    }
}

const MESSAGE_BUTTON = '<div title="ComfyUI 角色配图" class="mes_button ctp_mes_gen fa-solid fa-image"></div>';

/** Adds the per-message button to the message template (future messages) and to already rendered messages. */
function injectMessageButtons() {
    const template = $('#message_template .mes_buttons .extraMesButtons');
    if (template.length && !template.find('.ctp_mes_gen').length) template.prepend(MESSAGE_BUTTON);
    $('#chat .mes .extraMesButtons').each(function () {
        if (!$(this).find('.ctp_mes_gen').length) $(this).prepend(MESSAGE_BUTTON);
    });
}

function onMessageButton() {
    const mesId = Number($(this).closest('.mes').attr('mesid'));
    if (!Number.isInteger(mesId)) return;
    if (!getSettings().enabled) {
        toastr.info('ComfyUI 角色配图扩展已停用');
        return;
    }
    enqueue(mesId, { mode: 'reparse', force: true });
}

function injectWandButton() {
    const menu = $('#extensionsMenu');
    if (!menu.length || $('#ctp_wand').length) return;
    const item = $(`<div id="ctp_wand" class="list-group-item flex-container flexGap5" title="为最新楼层生成角色配图">
        <div class="fa-solid fa-image extensionsMenuExtensionButton"></div>
        <span>ComfyUI 角色配图</span>
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
        renderAll();
    }, 50);
}

function registerEvents() {
    const { eventSource, eventTypes } = ctx();
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, (mesId, type) => {
        renderMessage(Number(mesId));
        maybeAutoGenerate(Number(mesId), type);
    });
    eventSource.on(eventTypes.USER_MESSAGE_RENDERED, mesId => renderMessage(Number(mesId)));
    eventSource.on(eventTypes.MESSAGE_SWIPED, mesId => onSwiped(Number(mesId)));
    eventSource.on(eventTypes.MESSAGE_UPDATED, mesId => renderMessage(Number(mesId)));
    eventSource.on(eventTypes.MESSAGE_EDITED, mesId => renderMessage(Number(mesId)));
    eventSource.on(eventTypes.MESSAGE_DELETED, renderAllSoon);
    eventSource.on(eventTypes.MORE_MESSAGES_LOADED, renderAllSoon);
    eventSource.on(eventTypes.GENERATION_STOPPED, () => { lastStoppedAt = Date.now(); });
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        cancelAllJobs();
        resetPanelForChat();
        renderAllSoon();
        refreshTargetSelect();
    });
    // Registered after initPersonaTracking's own listener, so the new persona is already known here.
    if (eventTypes.PERSONA_CHANGED) eventSource.on(eventTypes.PERSONA_CHANGED, onPersonaChanged);

    // Whole-chat re-renders (branch, reload) don't always emit per-message events.
    const chatElement = document.getElementById('chat');
    if (chatElement) {
        new MutationObserver(mutations => {
            if (mutations.some(mutation => [...mutation.addedNodes].some(node => node instanceof HTMLElement && node.classList.contains('mes')))) {
                renderAllSoon();
            }
        }).observe(chatElement, { childList: true });
    }

    onLayoutChange(renderAll);

    $(document).on('click', '.ctp-wrap .ctp-act, #ctp_panel .ctp-act', onAction);
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
        await initPersonaTracking();
        await initSettingsUi();
        injectMessageButtons();
        injectWandButton();
        registerEvents();
        registerSlashCommands();
        renderAll();
        console.log(LOG_PREFIX, 'loaded');
    } catch (error) {
        console.error(LOG_PREFIX, 'init failed', error);
        toastr.error(String(error?.message || error), 'ComfyUI 角色配图加载失败');
    }
});
