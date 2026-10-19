import { PARSED_FIELDS, STATE_FIELDS } from './constants.js';
import { pendingHints } from './hints.js';
import { currentIndex } from './markup.js';
import { currentMode, floorMode, imageMode, modeLabel, promptStyle } from './modes.js';
import { NATURAL_STYLE_RULE } from './parserPresetDefaults.js';
import { activeParserPreset, extraFieldRules, outputRules, parseFixedFields, presetResolution, promptMode, sceneLimit } from './parserPresets.js';
import { ASPECT_RATIOS, parseAspect, parserPicksAspect } from './resolution.js';
import { describeThinking, profileThinking, thinkingBody, thinkingMaxTokens } from './thinking.js';
import { triggerWordList } from './prompt.js';
import { findStatusBar, withoutStatusBar } from './statusBar.js';
import { findUserPreset, presetForName, presetName, presetsMentioned } from './targets.js';
import {
    ctx,
    errorMessage,
    fillTemplate,
    getMessageData,
    getSettings,
    isAbortError,
    plainText,
    resolveMacros,
    sleep,
    truncate,
    warn,
    withTimeout,
} from './utils.js';

/** The tag name of 「只读取标签里的正文」, without brackets (default game). */
export function storyTagName(parser = getSettings().parser) {
    return String(parser.storyTag ?? '').replace(/[^\w:-]/g, '') || 'game';
}

function storyTagPattern(parser) {
    const tag = storyTagName(parser);
    // An unclosed tag (the AI forgot it, or the reply was cut off) runs to the end of the message.
    return new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)(?:</${tag}\\s*>|$)`, 'gi');
}

/** Whether a message has the story tag (only meaningful while 「只读取标签里的正文」 is on). */
export function hasStoryTag(text, parser = getSettings().parser) {
    return [...String(text ?? '').matchAll(storyTagPattern(parser))].some(match => match[1].trim());
}

/**
 * The part of a message the parser reads. With 「只读取标签里的正文」 only what is inside <game>…</game> (every
 * such block), so code pages, option panels and the like around the story are not taken for the story. A message
 * without the tag (the user's own, or a reply where the AI left it out) is read whole minus ``` code blocks.
 */
export function storyText(text, parser = getSettings().parser) {
    const source = String(text ?? '');
    if (!parser.storyTagOnly) return source;
    const parts = [...source.matchAll(storyTagPattern(parser))].map(match => match[1].trim()).filter(Boolean);
    if (parts.length) return parts.join('\n\n');
    return source.replace(/```[\s\S]*?(?:```|$)/g, '').trim();
}

/** Label of the AI's messages while 「隐藏角色卡的名字」 is on. */
export const HIDDEN_CHAR_LABEL = '正文';

/**
 * Who a message is from, as the parser sees it. With 「隐藏角色卡的名字」 the AI's messages are labelled 正文
 * instead of the card's name (for game / narrator cards whose name is not a character).
 */
export function speakerLabel(message) {
    if (message.is_user) return message.name || ctx().name1;
    return getSettings().parser.hideCharName ? HIDDEN_CHAR_LABEL : message.name || ctx().name2;
}

function formatMessage(message, maxChars, text = message.mes) {
    return `${speakerLabel(message)}: ${truncate(plainText(storyText(text)), maxChars)}`;
}

/** The paragraphs (lines) of a floor's text as the parser reads it. */
export function paragraphsOf(text) {
    return String(text ?? '').split(/\n+/).map(line => line.trim()).filter(Boolean);
}

/**
 * The paragraphs of the floor being drawn, exactly as the parser saw them numbered ([1], [2] …) when it was asked
 * where pictures go (图片插在正文中间, 多张图): its text without the status bar, story tag applied, cut to the
 * per-floor limit.
 */
export function floorParagraphs(message) {
    const settings = getSettings();
    const status = settings.statusBar.parserFocus ? findStatusBar(message?.mes) : null;
    const maxChars = Number(settings.parser.maxCharsPerMessage) || 0;
    return paragraphsOf(truncate(plainText(storyText(withoutStatusBar(message?.mes, status))), maxChars));
}

/** The current floor's status bar as its own block, so the parser treats it as the main source. */
function statusBarBlock(found) {
    if (!found) return '';
    return `【正文状态栏（写正文的 AI 总结的本楼结束时的状态，重点参考）】
${found.text}
这是写正文的 AI 对本楼结束时角色状态的总结：穿着、动作、状态、心情以它为准，翻译成英文、补成具体的视觉描写写进对应字段；正文只用来补充细节。状态栏写的不是目标角色时，只作参考。`;
}

/**
 * The chat as the parser may see it for floor `mesId`: that floor and the ones before it, never later floors.
 * Re-parsing #10 in a chat that has reached #30 must not read #11 and after (their text, images, drawing
 * instructions or status bars), so every reader below takes its messages from here.
 */
export function chatUpTo(mesId) {
    return ctx().chat.slice(0, Math.max(0, mesId + 1));
}

/**
 * A floor's picture data, if it was drawn in the active image model mode. Pictures of the other mode are
 * written for another model (sentences vs tags), so the parser never sees them as earlier outputs.
 */
function sameModeData(message) {
    const data = getMessageData(message);
    return data && floorMode(data) === currentMode() ? data : null;
}

/** Most recent parsed state of the same character on an earlier floor (for outfit/scene continuity). */
export function findLastState(mesId, targetName) {
    const chat = chatUpTo(mesId);
    const wanted = String(targetName || '').toLowerCase();
    for (let i = mesId - 1; i >= 0; i--) {
        const data = sameModeData(chat[i]);
        if (!data?.parsed || data.skipped) continue;
        if (wanted && String(data.target || '').toLowerCase() !== wanted) continue;
        return { floor: i, parsed: data.parsed };
    }
    return null;
}

function formatState(state, shownFloors) {
    if (!state) return '（无）';
    if (shownFloors.has(state.floor)) return `（见下方之前的配图输出 #${state.floor}）`;
    const lines = [...STATE_FIELDS, ...PARSED_FIELDS]
        .filter(field => state.parsed[field])
        .map(field => `${field}: ${state.parsed[field]}`);
    return lines.length ? `（来自 #${state.floor}）\n${lines.join('\n')}` : '（无）';
}

/**
 * Earlier floors' results (parsed fields + final prompt), newest `count` of them, oldest first.
 * They live in the messages' extension data, never in the message text, so only the parser sees them.
 */
export function previousOutputs(mesId, count) {
    const chat = chatUpTo(mesId);
    const records = [];
    for (let i = mesId - 1; i >= 0 && records.length < count; i--) {
        const data = sameModeData(chat[i]);
        if (!data?.parsed) continue;
        // A floor whose latest parse was skipped and that never got an image has nothing worth repeating.
        if (data.skipped && !data.images?.length) continue;
        records.unshift({ floor: i, data });
    }
    return records;
}

function formatOutputs(records, includePrompt) {
    if (!records.length) return '';
    const blocks = records.map(({ floor, data }) => {
        const lines = [`#${floor} · 目标：${data.subject === 'nobody' ? '（这一楼只画了场景，没有人物）' : data.target || '?'}`];
        for (const field of [...STATE_FIELDS, ...PARSED_FIELDS]) {
            if (data.parsed[field]) lines.push(`${field}: ${data.parsed[field]}`);
        }
        if (includePrompt) {
            // The selected version may be an older picture of the other mode (its prompt is for another model).
            const selected = data.images?.[currentIndex(data)];
            const image = selected && imageMode(selected) === currentMode() ? selected : null;
            const prompt = image?.prompt || data.prompt;
            if (prompt) {
                const edited = image?.prompt && data.prompt && image.prompt !== data.prompt ? '（用户选中的版本）' : '';
                lines.push(`最终提示词${edited}: ${truncate(prompt, 1500)}`);
            }
        }
        return lines.join('\n');
    });
    return `【之前的配图输出（最近 ${records.length} 次，从旧到新，用来保持人物服装和场景连贯）】\n${blocks.join('\n\n')}`;
}

/**
 * A character preset's outfit sets ("套装", one per line, "名称：提示词") as a reference block: when the story puts
 * the character in one of them, the parser writes that set's prompt into outfit.
 */
export function outfitBlock(preset, name = '') {
    const lines = resolveMacros(String(preset?.outfits || '')).split('\n').map(line => line.trim()).filter(Boolean);
    if (!lines.length) return '';
    const who = name ? `${name} 的` : '';
    return `【${who}套装（服装参考：剧情里穿上其中某一套、或用户画图指令点名某一套时，outfit 照这套的提示词写，再按剧情补充穿着状态；剧情没写到换装就不要换成套装）】
${lines.map(line => `- ${line}`).join('\n')}`;
}

function referenceBlock(target, mode) {
    const settings = getSettings();
    const blocks = [];
    if (target.auto) {
        for (const name of target.candidates) {
            const preset = presetForName(name);
            if (preset?.appearance) {
                const label = mode === 'ai' ? '角色设定（选中此人时必须完整写进 prompt）' : '固定外貌（仅供识别，不要输出）';
                blocks.push(`【${name} 的${label}】\n${resolveMacros(preset.appearance)}`);
            }
            const outfits = outfitBlock(preset, name);
            if (outfits) blocks.push(outfits);
        }
        return blocks.join('\n');
    }

    if (target.preset?.appearance) {
        const label = mode === 'ai' ? '角色设定（固定外貌，必须完整写进 prompt）' : '固定外貌（已由用户设定，仅供理解，不要输出）';
        blocks.push(`【${label}】\n${resolveMacros(target.preset.appearance)}`);
    }
    const outfits = outfitBlock(target.preset);
    if (outfits) blocks.push(outfits);
    const isUser = target.name && target.name === ctx().name1;
    if (settings.parser.includePersona && isUser) {
        const persona = ctx().powerUserSettings?.persona_description;
        if (persona) blocks.push(`【人设描述】\n${truncate(resolveMacros(persona), 2000)}`);
    }
    if (settings.parser.includeCharDescription && !isUser) {
        try {
            const description = ctx().getCharacterCardFields?.()?.description;
            if (description) blocks.push(`【角色卡描述】\n${truncate(description, 2000)}`);
        } catch {
            // Character card not available (e.g. no character selected)
        }
    }
    return blocks.join('\n');
}

/**
 * Fixed looks of characters who may share the frame when the preset allows other people: the {{user}} and
 * {{char}} presets and any preset named in the last two messages, except the target itself.
 */
function othersReference(mesId, target, absent = false) {
    if (target.auto) return '';
    const chat = chatUpTo(mesId);
    const text = [chat[mesId - 1], chat[mesId]].filter(Boolean).map(message => plainText(storyText(message.mes))).join('\n');
    const seen = new Set([target.preset?.id]);
    const lines = [];
    const card = getSettings().parser.hideCharName ? null : presetForName(ctx().name2);
    for (const preset of [findUserPreset(), card, ...presetsMentioned(text)]) {
        if (!preset?.appearance || seen.has(preset.id)) continue;
        seen.add(preset.id);
        lines.push(`- ${presetName(preset)}: ${truncate(resolveMacros(preset.appearance), 600)}`);
        if (lines.length >= 4) break;
    }
    const use = absent
        ? '画进 others 时照这些外貌写、不写名字；目标角色不在画面里、改画其中一人时，target 写这里的名字，looks 照这个外貌写'
        : '画进 others 时照这些外貌写，不写名字';
    return lines.length ? `【可能同框的其他角色（${use}）】\n${lines.join('\n')}` : '';
}

/** Entries the current story activates, via SillyTavern's own scan in dry-run mode (no events, no timed effects). */
async function activatedWorldInfo(mesId) {
    const context = ctx();
    if (typeof context.getWorldInfoPrompt !== 'function') throw new Error('当前酒馆版本没有世界书扫描接口');
    // Same input shape as SillyTavern's generation: "name: text", newest first. A dry run applies no sticky /
    // cooldown effects, and "delay" counts this shortened chat, so later floors don't activate anything.
    const scan = chatUpTo(mesId)
        .filter(message => message && !message.is_system)
        .map(message => `${speakerLabel(message)}: ${storyText(message.mes)}`)
        .reverse();
    const result = await context.getWorldInfoPrompt(scan, context.maxContext, true);
    const depth = (result.worldInfoDepth || []).flatMap(item => item?.entries || []);
    return [result.worldInfoBefore, result.worldInfoAfter, ...(result.anBefore || []), ...(result.anAfter || []), ...depth]
        .map(text => String(text || '').trim())
        .filter(Boolean)
        .join('\n\n');
}

/** Every enabled entry of the lorebooks active for this chat (global, character, chat, persona). */
async function allWorldInfo() {
    const worldInfo = await import('../../../../world-info.js');
    const entries = await worldInfo.getSortedEntries();
    return entries
        .filter(entry => !entry.disable && String(entry.content || '').trim())
        .map(entry => {
            const title = entry.comment || (Array.isArray(entry.key) ? entry.key.join(', ') : '');
            const content = resolveMacros(entry.content);
            return title ? `[${title}]\n${content}` : content;
        })
        .join('\n\n');
}

/** Optional world-info block for the parser. Failures only drop the block; they never stop a generation. */
export async function worldInfoBlock(mesId) {
    const { parser } = getSettings();
    if (!parser.worldInfo || parser.worldInfo === 'off') return { text: '', note: '' };
    try {
        const raw = parser.worldInfo === 'all' ? await allWorldInfo() : await activatedWorldInfo(mesId);
        if (!raw.trim()) return { text: '', note: '世界书：没有可用的条目' };
        const max = Math.max(500, Number(parser.worldInfoMaxChars) || 6000);
        const cut = raw.length > max ? `（已截断到 ${max} 字）` : '';
        return {
            text: `【世界书（参考设定，用来理解人物、服装、场景；不要输出）】\n${truncate(raw, max)}`,
            note: `世界书：${raw.length} 字${cut}`,
        };
    } catch (error) {
        warn('world info', error);
        return { text: '', note: `世界书读取失败：${errorMessage(error)}` };
    }
}

/**
 * Tells the parser about the mode's trigger words. They are added to every prompt by the extension anyway (see
 * finishPrompt); when the AI writes the whole prompt it is asked to start with them.
 */
function triggerWordsRule(mode) {
    const words = triggerWordList();
    if (!words.length) return '';
    const list = words.join(', ');
    return mode === 'ai'
        ? `触发词：最终提示词必须带上这些触发词：${list}。把它们原样写在 prompt 的最前面（不翻译、不改写、不加括号或权重），每次都要写。`
        : `触发词：最终提示词的开头会自动加上这些触发词：${list}。它们由程序添加，你的字段里不用再写。`;
}

/** Puts `{{name}}` in front of `anchor` (or at the end) when a custom template predates the variable. */
function ensureSlot(template, name, anchors) {
    if (template.includes(`{{${name}}}`)) return template;
    for (const anchor of anchors) {
        const index = template.indexOf(anchor);
        if (index >= 0) return `${template.slice(0, index)}{{${name}}}\n\n${template.slice(index)}`;
    }
    return `${template}\n\n{{${name}}}`;
}

function fixedFieldsBlock(preset) {
    const fields = parseFixedFields(preset?.fixedFields);
    const lines = Object.entries(fields).map(([field, value]) => `${field}: ${value}`);
    return lines.length ? `【固定内容（这些字段每张图都一样，必须原样使用，不要改）】\n${lines.join('\n')}` : '';
}

/**
 * Builds the system + user messages for the parser model from the active parser preset.
 * @returns {Promise<{ system: string, user: string, notes: string[], preset: object, mode: 'fixed'|'ai' }>}
 */
/**
 * 多张图, 🔄 on one picture: the parser writes that one part again. Its place in the text stays as it was.
 * @typedef {{ label: string, start: string, place: string, index: number, count: number, end: boolean }} PartFocus
 */
function focusBlock(focus) {
    const where = [
        focus.start ? `这一段在正文里从「${focus.start}」开始` : '',
        focus.place ? `这张图插在「${focus.place}」这句话后面` : '',
    ].filter(Boolean).join('，');
    return `【这次只重新写一张图】这一楼的配图按时间分成了 ${focus.count} 段，这次只重写第 ${focus.index + 1} 段「${focus.label}」的那一张${where ? `（${where}）` : ''}：
- 主字段只写这一段画面那一刻的情况${focus.end ? '（也就是这一楼结束的时刻）' : '；时间线规则里的「画面时刻」这次换成这一段，不是这一楼结束的时刻'}
- 不要写 earlier_scenes，也不要写别的段`;
}

/**
 * @param {number} mesId
 * @param {object} target
 * @param {{ focus?: PartFocus }} [options] focus: only one part of the floor is written (🔄 on one picture)
 */
export async function buildParserPrompt(mesId, target, { focus = null } = {}) {
    const settings = getSettings();
    const preset = activeParserPreset();
    const mode = promptMode();
    const allowOthers = !!preset.allowOthers;
    // The parser writes the picture's negative prompt too (Anima: a real negative prompt at CFG 4).
    const negative = !!settings.parserNegative;
    // 多张图: earlier parts of the floor (another time or place) get pictures of their own. One part written
    // again keeps its place and size, so neither the parts nor the place and aspect are asked for then.
    const scenes = focus ? 0 : sceneLimit(settings.parser);
    // 图片插在正文中间: the parser picks the sentence each picture goes after.
    const place = !focus && !!settings.placeInStory;
    // 画谁不在画面里: who to draw when the target is not in the scene, instead of skipping (not for sprites,
    // which always show the target).
    const absent = settings.absentFallback !== false && preset.id !== 'sprite' ? { auto: !!target.auto } : null;
    // The parser picks the aspect ratio (resolution selector), unless this parser preset sets its own size.
    const aspect = !focus && parserPicksAspect(settings.comfy) && !presetResolution(preset)
        ? { ratios: ASPECT_RATIOS, fallback: parseAspect(settings.comfy.aspectRatio) || '1:1' }
        : null;
    const chat = chatUpTo(mesId);
    const laterFloors = ctx().chat.length - chat.length;
    const depth = Math.max(0, Number(settings.parser.contextDepth) || 0);
    const maxChars = Number(settings.parser.maxCharsPerMessage) || 0;

    const history = [];
    for (let i = mesId - 1; i >= 0 && history.length < depth; i--) {
        const message = chat[i];
        if (!message || message.is_system) continue;
        history.unshift(formatMessage(message, maxChars));
    }

    const historyCount = Math.max(0, Math.min(20, Number(settings.parser.historyFloors) || 0));
    const records = previousOutputs(mesId, historyCount);
    const prevOutputs = formatOutputs(records, settings.parser.historyIncludePrompt !== false);
    const shownFloors = new Set(records.map(record => record.floor));
    const lastState = settings.continuity && !target.auto ? findLastState(mesId, target.name) : null;
    const candidates = target.auto
        ? `【候选角色】请从以下角色中选出当前楼层最适合作为画面主角的一位（通常是动作、情绪描写最集中的人），把名字原样填入 target：\n${target.candidates.map(name => `- ${name}`).join('\n')}`
        : '';

    // The main AI's status bar for this floor (see statusBar.js), read first and left out of the floor's text.
    const status = settings.statusBar.parserFocus ? findStatusBar(chat[mesId].mes) : null;

    const vars = {
        target: target.auto ? '（由你从候选角色中选择）' : target.name,
        appearance: [referenceBlock(target, mode), allowOthers || absent ? othersReference(mesId, target, !!absent) : ''].filter(Boolean).join('\n'),
        fixed_fields: fixedFieldsBlock(preset),
        output_rules: outputRules(mode, allowOthers, negative, aspect, scenes, place, absent),
        candidates,
        last_state: target.auto ? '（自动模式下不提供）' : formatState(lastState, shownFloors),
        prev_outputs: prevOutputs,
        history: history.length ? history.join('\n\n') : '（无）',
        // Where pictures go is asked as paragraph numbers: the floor is shown numbered then.
        latest: place || scenes > 1
            ? `${speakerLabel(chat[mesId])}:\n${floorParagraphs(chat[mesId]).map((paragraph, index) => `[${index + 1}] ${paragraph}`).join('\n')}`
            : formatMessage(chat[mesId], maxChars, withoutStatusBar(chat[mesId].mes, status)),
        status_bar: statusBarBlock(status),
        floor: String(mesId),
    };

    const worldInfo = await worldInfoBlock(mesId);
    vars.world_info = worldInfo.text;
    const hints = pendingHints(mesId);
    vars.user_hints = hints.length
        ? `【用户画图指令（用户在消息里用 [[ ]] 写给你的画面要求，优先级最高，必须体现在对应字段里）】\n${hints.flatMap(item => item.hints.map(hint => `- #${item.floor} ${item.name}: ${hint}`)).join('\n')}`
        : '';

    // Custom templates from before these variables existed still get the blocks.
    let userTemplate = String(preset.user || '');
    if (vars.fixed_fields) userTemplate = ensureSlot(userTemplate, 'fixed_fields', ['【上一次状态', '【最近剧情', '【当前楼层']);
    if (prevOutputs) userTemplate = ensureSlot(userTemplate, 'prev_outputs', ['【最近剧情', '【当前楼层']);
    if (worldInfo.text) userTemplate = ensureSlot(userTemplate, 'world_info', ['【上一次状态', '【最近剧情', '【当前楼层']);
    if (vars.user_hints) userTemplate = ensureSlot(userTemplate, 'user_hints', ['请按要求']);
    if (vars.status_bar) userTemplate = ensureSlot(userTemplate, 'status_bar', ['{{user_hints}}', '请按要求']);

    // A custom system prompt without {{output_rules}} keeps its own output format in "fixed" mode; the
    // "AI writes the prompt" mode and "allow other people" need the rules that ask for `prompt` / `others`.
    let systemTemplate = String(preset.system || '');
    if ((mode === 'ai' || allowOthers) && !systemTemplate.includes('{{output_rules}}')) systemTemplate += '\n\n{{output_rules}}';
    // Only extra fields are asked for: such a prompt keeps its own format and just gets those fields.
    else if ((negative || aspect || scenes || place || absent) && !systemTemplate.includes('{{output_rules}}')) systemTemplate += `\n\n${extraFieldRules(negative, aspect, scenes, place, absent)}`;

    const triggerRule = triggerWordsRule(mode);
    // Anima in natural-language mode: the presets were written for tags, so this rule overrides them.
    const natural = promptStyle() === 'anima-natural';
    return {
        system: [fillTemplate(systemTemplate, vars), natural ? NATURAL_STYLE_RULE : '', triggerRule].filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n'),
        user: [fillTemplate(userTemplate, vars), focus ? focusBlock(focus) : ''].filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n'),
        preset,
        mode,
        absent: !!absent,
        notes: [
            `${modeLabel()} 模式 · 解析预设：${preset.name} · ${mode === 'ai' ? 'AI 写完整提示词' : '固定外貌 + AI 补充'}${allowOthers ? ' · 允许其他人物' : ''}`,
            triggerRule ? `触发词：${triggerWordList().join(', ')}` : '',
            natural ? '英文自然语言写法' : '',
            settings.parser.hideCharName ? `隐藏了角色卡的名字（AI 的消息标成「${HIDDEN_CHAR_LABEL}」）` : '',
            settings.parser.storyTagOnly
                ? hasStoryTag(chat[mesId].mes) ? `只读取 <${storyTagName()}> 标签里的正文` : `当前楼层没有 <${storyTagName()}> 标签，读取了全文（去掉了 \`\`\` 代码块）`
                : '',
            negative ? '解析模型补充反向提示词' : '',
            aspect ? '解析模型选择宽高比' : '',
            scenes ? `多张图：正文换了时间或地点时最多画 ${scenes} 张` : '',
            place ? '图片插在正文中间：由解析模型选位置' : '',
            absent ? '画谁不在画面里时，改画在场的人或场景' : '',
            focus ? `只重新解析「${focus.label}」这一张` : '',
            describeThinking(settings.parser),
            worldInfo.note,
            records.length ? `参考了之前 ${records.length} 次配图输出` : '',
            hints.length ? `用户画图指令 ${hints.reduce((sum, item) => sum + item.hints.length, 0)} 条` : '',
            status ? '读取了正文状态栏' : '',
            laterFloors > 0 ? `只读取 #${mesId} 及之前的楼层，之后的 ${laterFloors} 楼不读取` : '',
        ].filter(Boolean),
    };
}

/** A mistake in the settings: retrying the request cannot fix it. */
function settingsError(message) {
    const error = new Error(message);
    error.noRetry = true;
    return error;
}

function authHeaders(key) {
    return key ? JSON.stringify({ Authorization: `Bearer ${key}` }) : undefined;
}

/** Extra JSON merged into the request body, e.g. {"thinking": {"type": "disabled"}} for GLM. */
export function parseExtraBody() {
    const text = String(getSettings().parser.extraBody || '').trim();
    if (!text) return null;
    let value;
    try {
        value = JSON.parse(text);
    } catch (error) {
        throw settingsError(`「附加请求参数」不是合法 JSON：${error.message}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw settingsError('「附加请求参数」必须是 JSON 对象，例如 {"thinking": {"type": "disabled"}}');
    }
    return value;
}

/** Pulls content / reasoning / finish_reason out of an OpenAI-style chat completion response. */
function readCompletion(json) {
    const choice = json?.choices?.[0] ?? {};
    const message = choice.message ?? {};
    const content = Array.isArray(message.content)
        ? message.content.map(part => part?.text ?? '').join('')
        : String(message.content ?? choice.text ?? '');
    const reasoning = String(message.reasoning_content ?? message.reasoning ?? '');
    return { content, reasoning, finish: choice.finish_reason ?? '' };
}

/**
 * @typedef {{ content: string, reasoning: string, finish: string }} ParserReply
 */

/** @returns {Promise<ParserReply>} */
async function callCustom(system, user, signal) {
    const { parser } = getSettings();
    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
    const url = parser.customUrl.trim().replace(/\/+$/, '');
    if (!url) throw settingsError('未填写解析模型的 API 地址');
    if (!parser.customModel.trim()) throw settingsError('未填写解析模型名称');
    // Thinking parameters first, so the user's own 「附加请求参数」 can override them.
    const extraBody = { ...thinkingBody(parser), ...parseExtraBody() };
    const maxTokens = thinkingMaxTokens(parser);

    const service = ctx().ChatCompletionService;
    if (service?.processRequest) {
        // Routed through the SillyTavern server: no CORS problems, key is sent only as a request header.
        // extractData=false so finish_reason and reasoning_content are available for diagnostics.
        const json = await service.processRequest({
            stream: false,
            messages,
            model: parser.customModel.trim(),
            chat_completion_source: 'custom',
            custom_url: url,
            custom_include_headers: authHeaders(parser.customKey.trim()),
            custom_include_body: Object.keys(extraBody).length ? JSON.stringify(extraBody) : undefined,
            max_tokens: maxTokens,
            temperature: Number(parser.temperature),
        }, {}, false, signal);
        return readCompletion(json);
    }

    const response = await fetch(`${url}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(parser.customKey ? { Authorization: `Bearer ${parser.customKey.trim()}` } : {}),
        },
        body: JSON.stringify({
            model: parser.customModel.trim(),
            messages,
            max_tokens: maxTokens,
            temperature: Number(parser.temperature),
            stream: false,
            ...extraBody,
        }),
        signal,
    });
    if (!response.ok) {
        throw new Error(`解析模型返回 ${response.status}: ${truncate(await response.text(), 500)}`);
    }
    return readCompletion(await response.json());
}

/** @returns {Promise<ParserReply>} */
async function callProfile(system, user, signal) {
    const { parser } = getSettings();
    const service = ctx().ConnectionManagerRequestService;
    if (!service) throw settingsError('当前酒馆版本没有 Connection Manager 接口，请改用「独立 API」');
    if (!parser.profileId) throw settingsError('未选择连接配置');
    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
    const result = await service.sendRequest(
        parser.profileId,
        messages,
        Number(parser.maxTokens) || 2048,
        { stream: false, signal, extractData: true, includePreset: true, includeInstruct: true },
        { temperature: Number(parser.temperature), ...profileThinking(parser) },
    );
    if (typeof result === 'string') return { content: result, reasoning: '', finish: '' };
    return { content: String(result?.content ?? ''), reasoning: String(result?.reasoning ?? ''), finish: '' };
}

/** @returns {Promise<ParserReply>} */
async function callMain(system, user, signal) {
    const { parser } = getSettings();
    const { generateRaw } = ctx();
    const maxTokens = Number(parser.maxTokens) || 2048;
    const request = generateRaw.length > 1
        // Older SillyTavern: positional arguments
        ? generateRaw(user, null, false, false, system, maxTokens)
        : generateRaw({ prompt: user, systemPrompt: system, responseLength: maxTokens });
    const aborted = new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')), { once: true });
    });
    const content = await Promise.race([request, aborted]);
    return { content: String(content ?? ''), reasoning: '', finish: '' };
}

export function parserLabel() {
    const { parser } = getSettings();
    switch (parser.source) {
        case 'profile': {
            const profile = ctx().extensionSettings?.connectionManager?.profiles?.find(p => p.id === parser.profileId);
            return `连接配置: ${profile?.name ?? parser.profileId}${profile?.model ? ` (${profile.model})` : ''}`;
        }
        case 'main':
            return '酒馆当前 API';
        default:
            return `独立 API: ${parser.customModel}`;
    }
}

/**
 * Calls the parser model.
 * @returns {Promise<ParserReply>}
 */
export async function callParser(system, user, parentSignal) {
    const { parser } = getSettings();
    const { signal, dispose } = withTimeout(parentSignal, Number(parser.timeoutSec) || 0);
    try {
        switch (parser.source) {
            case 'profile':
                return await callProfile(system, user, signal);
            case 'main':
                return await callMain(system, user, signal);
            default:
                return await callCustom(system, user, signal);
        }
    } catch (error) {
        if (signal.aborted && signal.reason instanceof Error) {
            // Timed out: another attempt would most likely wait just as long.
            signal.reason.noRetry = true;
            throw signal.reason;
        }
        throw error;
    } finally {
        dispose();
    }
}

/**
 * Calls the parser and parses its reply, retrying what a retry can fix: provider errors (some APIs reject an
 * identical request now and then, e.g. "Invalid API parameter", 429, 502) and replies without usable JSON.
 * Cancelling, timeouts, wrong settings and replies cut off by the output limit fail at once.
 * @param {{ onReply?: (reply: ParserReply) => void, onRetry?: (attempt: number, max: number, error: Error) => void }} [hooks]
 * @returns {Promise<{ reply: ParserReply, parsed: ReturnType<typeof parseParserOutput>, retried: number }>}
 */
export async function requestParse(system, user, signal, { onReply, onRetry } = {}) {
    const retries = Math.max(0, Math.min(5, Math.trunc(Number(getSettings().parser.retries) || 0)));
    for (let attempt = 0; ; attempt++) {
        let reply = null;
        try {
            reply = await callParser(system, user, signal);
            onReply?.(reply);
            return { reply, parsed: parseParserReply(reply), retried: attempt };
        } catch (error) {
            const retryable = !signal?.aborted && !isAbortError(error) && !error?.noRetry && reply?.finish !== 'length';
            if (!retryable) throw error;
            if (attempt >= retries) {
                throw attempt > 0 ? new Error(`解析模型连续 ${attempt + 1} 次失败`, { cause: error }) : error;
            }
            onRetry?.(attempt + 1, retries, error);
            await sleep(1500 * (attempt + 1), signal);
        }
    }
}

const THINKING_HINT = '如果是思考模型（GLM、DeepSeek-R1、Qwen3 等），通常是思考过程把「最大输出」用完了：调大「最大输出」，或把「思考模式」改成关闭、把「思考强度」调低';

/**
 * Parses a parser reply. Falls back to the reasoning text when a thinking model put its answer there,
 * and explains empty / truncated replies instead of a generic JSON error.
 */
export function parseParserReply(reply) {
    const sources = [reply?.content, reply?.reasoning].filter(text => String(text ?? '').trim());
    const finish = reply?.finish ? `（finish_reason=${reply.finish}）` : '';
    if (!sources.length) {
        throw new Error(`解析模型返回了空内容${finish}。${THINKING_HINT}`);
    }
    let lastError = null;
    for (const text of sources) {
        try {
            return parseParserOutput(text);
        } catch (error) {
            lastError = error;
        }
    }
    if (!String(reply.content ?? '').trim()) {
        throw new Error(`解析模型返回了空内容${finish}（只有思考过程，里面也没有 JSON）。${THINKING_HINT}`);
    }
    if (reply.finish === 'length') {
        throw new Error(`解析模型的输出被截断了${finish}，没有完整的 JSON。${THINKING_HINT}`);
    }
    throw lastError;
}

function repairJson(text) {
    return text
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, '\'')
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/\r?\n/g, ' ');
}

function normalizeValue(value) {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.map(normalizeValue).filter(Boolean).join(', ');
    if (typeof value === 'object') return Object.values(value).map(normalizeValue).filter(Boolean).join(', ');
    return String(value).replace(/\s+/g, ' ').trim().replace(/[.。]+$/, '');
}

function isTrue(value) {
    return value === true || String(value).trim().toLowerCase() === 'true';
}

/** The `earlier_scenes` of a reply: objects with a label and picture fields; anything else is dropped. */
function parseScenes(value) {
    if (!Array.isArray(value)) return [];
    const scenes = [];
    for (const item of value) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const scene = {
            label: normalizeValue(item.label ?? item.time ?? item.name),
            start: normalizeValue(item.start ?? item.begin ?? item.quote),
            place: normalizeValue(item.place ?? item.position),
            // 画谁不在画面里: who this part shows when the target is not in it.
            absent: isTrue(item.absent),
            target: normalizeValue(item.target),
            looks: normalizeValue(item.looks),
        };
        for (const field of PARSED_FIELDS) scene[field] = normalizeValue(item[field]);
        scene.prompt = normalizeValue(item.prompt);
        scene.negative = normalizeValue(item.negative ?? item.negative_prompt);
        if (scene.prompt || PARSED_FIELDS.some(field => scene[field])) scenes.push(scene);
    }
    return scenes;
}

/**
 * Extracts the JSON object from the parser's reply. Tolerates code fences, thinking blocks and minor syntax slips.
 * @returns {{ skip: boolean, reason?: string, target?: string } & Record<string, string>}
 */
export function parseParserOutput(raw) {
    let text = String(raw ?? '')
        .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
        .trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) text = fence[1];

    let object = null;
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
        const body = text.slice(start, end + 1);
        for (const candidate of [body, repairJson(body)]) {
            try {
                object = JSON.parse(candidate);
                break;
            } catch {
                // try next candidate
            }
        }
    }

    if (!object) {
        // Salvage fields from broken or truncated JSON, or from "key: value" lines. A quoted value only counts
        // when its closing quote is present, so a reply cut off mid-value does not leak half a phrase.
        object = {};
        for (const key of ['skip', 'reason', 'target', 'looks', 'place', 'prompt', 'negative', 'negative_prompt', 'aspect', ...STATE_FIELDS, ...PARSED_FIELDS]) {
            // Whole keys only: "prompt" must not match the end of "negative_prompt".
            const quoted = text.match(new RegExp(`(?<![\\w])["']?${key}["']?\\s*[:：]\\s*"([^"\\n]*)"`, 'i'));
            const line = text.match(new RegExp(`^\\s*${key}\\s*[:：]\\s*([^"{}\\n]+)$`, 'im'));
            if (quoted) object[key] = quoted[1];
            else if (line) object[key] = line[1];
        }
        const skip = text.match(/["']?skip["']?\s*[:：]\s*(true|false)/i);
        if (skip) object.skip = skip[1].toLowerCase() === 'true';
        const absent = text.match(/["']?absent["']?\s*[:：]\s*(true|false)/i);
        if (absent) object.absent = absent[1].toLowerCase() === 'true';
        if (!Object.keys(object).length) {
            throw new Error('解析模型没有返回可识别的 JSON');
        }
    }

    const result = {
        skip: object.skip === true || String(object.skip).toLowerCase() === 'true',
        reason: normalizeValue(object.reason),
        target: normalizeValue(object.target),
    };
    for (const field of [...STATE_FIELDS, ...PARSED_FIELDS]) {
        result[field] = normalizeValue(object[field]);
    }
    // Only present in the "AI writes the whole prompt" mode
    result.prompt = normalizeValue(object.prompt);
    // Only when the parser is asked for a negative prompt
    // "negative_prompt" is the usual Stable Diffusion name; models sometimes use it.
    result.negative = normalizeValue(object.negative ?? object.negative_prompt);
    // Only when the parser picks the aspect ratio
    result.aspect = normalizeValue(object.aspect ?? object.aspect_ratio);
    // Only with 多张图: the earlier parts of the floor, in order (the main fields are the end of the floor).
    result.earlierScenes = parseScenes(object.earlier_scenes ?? object.earlierScenes);
    // The opening words of the last part (the end of the floor), to put its picture at its place in the text.
    result.start = result.earlierScenes.length ? normalizeValue(object.start) : '';
    // Only with 图片插在正文中间: the sentence the (end of the floor) picture goes after.
    result.place = normalizeValue(object.place ?? object.position);
    // Only with 画谁不在画面里: the target is not in the scene; `target` is who is drawn instead ('' = nobody).
    result.absent = isTrue(object.absent);
    result.looks = normalizeValue(object.looks);
    if (!result.skip && !result.prompt && PARSED_FIELDS.every(field => !result[field])) {
        throw new Error('解析结果里没有任何画面字段');
    }
    return result;
}
