import { comicPages, comicPanelCount, comicPanels, isComicPreset, readComicPage } from './comic.js';
import { KREA2_REFINE_INSTRUCTIONS, MODEL_KREA2, MODEL_MOSS, PARSED_FIELDS, STATE_FIELDS } from './constants.js';
import { pendingHints } from './hints.js';
import { currentIndex } from './markup.js';
import { chinesePrompt, currentMode, floorMode, imageMode, modeLabel, promptStyle } from './modes.js';
import { CHINESE_PROMPT_RULE, NATURAL_STYLE_RULE } from './parserPresetDefaults.js';
import { mossSkillBlock } from './mossSkill.js';
import { activeParserPreset, extraFieldRules, outputRules, parseFixedFields, presetResolution, promptMode, sceneLimit } from './parserPresets.js';
import { ASPECT_RATIOS, baseSize, parseAspect, parserPicksAspect } from './resolution.js';
import { describeThinking, profileThinking, thinkingBody, thinkingMaxTokens, thinkingOmits } from './thinking.js';
import { isTriggerTag, triggerWordList } from './prompt.js';
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

/** The parser's output limit for a comic of so many pages at least (when 「最大输出」 is set lower). */
function comicMinTokens(pages) {
    return Math.min(8192, 2048 * (pages + 1));
}

/** The last words of a comic request: the pages in MOSS-Image's layout format, never a written-out prompt. */
function comicReminder(pages) {
    return pages > 1
        ? `【输出要求】这是漫画模式：只输出一个 JSON 对象，漫画写在 pages 里（按内容画 1–${pages} 页，每一页一个 layout，用 MOSS-Image 的 JSON 版面格式：summary + items，照 System 里的格式示例写），不要写自然语言提示词。`
        : '【输出要求】这是漫画模式：只输出一个 JSON 对象，这一页漫画全部写在 layout 里（MOSS-Image 的 JSON 版面格式：summary + items，照 System 里的格式示例写），不要写自然语言提示词。';
}

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

const CODE_BLOCK = /```[\s\S]*?(?:```|$)/g;

/** The tags of 「不算正文的标签」 (default advice), without brackets. */
function ignoredTags(parser) {
    return String(parser.ignoreTags ?? '').split(/[,，\s]+/).map(tag => tag.replace(/[^\w:-]/g, '')).filter(Boolean);
}

/**
 * A message without the blocks of 「不算正文的标签」: e.g. <advice>…</advice>, where a preset copies the user's next
 * message into the end of the reply. That is the user's input for the next floor, not this floor's story: the parser
 * must not draw it, and pictures do not go after it.
 */
function withoutIgnored(text, parser) {
    let source = String(text ?? '');
    for (const tag of ignoredTags(parser)) {
        source = source.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?(?:</${tag}\\s*>|$)`, 'gi'), '');
    }
    return source;
}

/**
 * The story of a message: what is inside <game>…</game> (every such block), so code pages, option panels and the
 * like around it are not taken for the story. A message without the tag (the user's own, or a reply where the AI
 * left it out) is the whole of it minus ``` code blocks. Blocks of 「不算正文的标签」 are never part of it.
 */
function storyPart(text, parser) {
    const source = withoutIgnored(text, parser);
    const parts = [...source.matchAll(storyTagPattern(parser))].map(match => match[1].trim()).filter(Boolean);
    if (parts.length) return parts.join('\n\n');
    return source.replace(CODE_BLOCK, '').trim();
}

/** What storyPart leaves out: the text around the story tag, or the code blocks of a message without it. */
function outsideStory(text, parser) {
    const source = withoutIgnored(text, parser);
    if (hasStoryTag(source, parser)) return source.replace(storyTagPattern(parser), '').trim();
    return (source.match(CODE_BLOCK) ?? []).join('\n').trim();
}

/**
 * The part of a message the parser reads: with 「只读取标签里的正文」 only the story (storyPart), else all of it; never
 * the blocks of 「不算正文的标签」.
 */
export function storyText(text, parser = getSettings().parser) {
    return parser.storyTagOnly ? storyPart(text, parser) : withoutIgnored(text, parser);
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

/** A message's text as placing pictures sees it: without the status bar the parser is shown on its own. */
function placementSource(message) {
    const status = getSettings().statusBar.parserFocus ? findStatusBar(message?.mes) : null;
    return withoutStatusBar(message?.mes, status);
}

/**
 * The story paragraphs of a floor, where its pictures may go (图片插在正文中间, 多张图): what is inside
 * <game>…</game> when the message has that tag, whether or not 「只读取标签里的正文」 is on (pictures go into the
 * story, never into the panels or code pages around it); else the message minus ``` code blocks. Not cut to the
 * per-floor limit, so the story's end is its real end (the parser's numbers are the same, see floorParagraphs).
 */
export function storyParagraphs(message) {
    return paragraphsOf(plainText(storyPart(placementSource(message), getSettings().parser)));
}

/**
 * The paragraphs of the floor being drawn as the parser saw them numbered ([1], [2] …) when it was asked where
 * pictures go: storyParagraphs, cut to the per-floor limit (so the numbers are the same, only fewer).
 */
export function floorParagraphs(message) {
    const settings = getSettings();
    const maxChars = Number(settings.parser.maxCharsPerMessage) || 0;
    return paragraphsOf(truncate(plainText(storyPart(placementSource(message), settings.parser)), maxChars));
}

/**
 * The floor shown to the parser when it is asked where pictures go: the story paragraphs numbered; with
 * 「只读取标签里的正文」 off, the rest of the message follows as reference (pictures cannot go there).
 */
function numberedFloor(message, maxChars) {
    const settings = getSettings();
    const lines = floorParagraphs(message).map((paragraph, index) => `[${index + 1}] ${paragraph}`);
    const outside = settings.parser.storyTagOnly ? '' : plainText(outsideStory(placementSource(message), settings.parser));
    const note = hasStoryTag(message?.mes, settings.parser) ? ` <${storyTagName(settings.parser)}> 标签外面的内容` : '代码块里的内容';
    return `${speakerLabel(message)}:\n${lines.join('\n')}${outside ? `\n\n（下面是这一楼${note}，没有编号，只作参考，图片不能插在这里）\n${truncate(outside, maxChars)}` : ''}`;
}

/** The current floor's status bar as its own block, so the parser treats it as the main source. */
function statusBarBlock(found) {
    if (!found) return '';
    return `【正文状态栏（写正文的 AI 总结的本楼结束时的状态，重点参考）】
${found.text}
这是写正文的 AI 对本楼结束时角色状态的总结：穿着、动作、状态、心情以它为准，翻译成英文、补成具体的视觉描写写进对应字段；正文只用来补充细节。状态栏写的不是目标角色时，只作参考。`;
}

/**
 * Krea 2 with 「官方模板写法」: the rules ComfyUI's official Krea 2 Turbo template gives its prompt rewrite
 * (KREA2_REFINE_INSTRUCTIONS, word for word), with how they apply to what the parser writes here. The text-free
 * ending of rule 4 is added by buildImagePrompt.
 */
function kreaRulesBlock(mode) {
    const how = mode === 'ai'
        ? 'prompt 按这些规则写成一段连贯的英文：每个人和自己的外貌、衣服、动作写在一起，姿势和位置写具体，不添加正文里没有的人和东西，没有依据的细节不要编'
        : '你只写各个英文字段，程序按固定顺序把它们拼成提示词：每个字段按规则 1、2、5 写（忠于正文、姿势和位置写具体、没有依据的细节不要编）';
    return `【Krea 2 官方模板的写法】
下面是 ComfyUI 官方 Krea 2 Turbo 模板里「Refine Prompt」那一步给模型的改写规则（Comfy-Org/workflow_templates，MIT 协议，原文照录）。写英文画面描述时按这些规则来；和上面的要求冲突时，以上面的为准：
- 规则里「用户的提示词」就是正文里这一刻的画面。可以按规则开头说的先想一想，但思考过程不要写进回复，回复仍然只有上面要求的 JSON；规则 6、10 说的「只输出一段提示词」指的是画面描述本身的写法
- 画风和媒介由画风前缀和 LoRA 决定：规则开头和规则 3、9 说的挑画风、挑媒介不用做；镜头和光线照常按剧情写
- 规则 4 结尾那句 "Absolutely no text…" 不用写，程序会加在提示词最后
- ${how}

${KREA2_REFINE_INSTRUCTIONS.replace(/\s*User's Input:\s*$/, '').trim()}`;
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
        // 漫画模式: the page's description stands for its JSON layout (boxes and all).
        const page = data.parsed.page;
        const panels = page ? comicPanelCount(page) : 0;
        if (page?.caption) lines.push(`漫画${panels ? `（${panels} 格）` : ''}: ${truncate(page.caption, 600)}`);
        if (includePrompt && !page) {
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

function referenceBlock(target, mode, comic = false) {
    const settings = getSettings();
    const blocks = [];
    if (target.auto) {
        for (const name of target.candidates) {
            const preset = presetForName(name);
            if (preset?.appearance) {
                const label = comic ? '角色设定（选中此人时，画到 ta 的每一格都要完整写上）' : mode === 'ai' ? '角色设定（选中此人时必须完整写进 prompt）' : '固定外貌（仅供识别，不要输出）';
                blocks.push(`【${name} 的${label}】\n${resolveMacros(preset.appearance)}`);
            }
            const outfits = outfitBlock(preset, name);
            if (outfits) blocks.push(outfits);
        }
        return blocks.join('\n');
    }

    if (target.preset?.appearance) {
        const label = comic ? '角色设定（固定外貌，画到 ta 的每一格都要完整写上）' : mode === 'ai' ? '角色设定（固定外貌，必须完整写进 prompt）' : '固定外貌（已由用户设定，仅供理解，不要输出）';
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
 * finishPrompt); when the AI writes the whole prompt it is asked to start with them, except in Anima, where they
 * take the artist's place of the official tag order, MOSS-Image's structural tags (always the first line, added by
 * the extension) and 漫画模式 (they go into the page's summary).
 */
function triggerWordsRule(mode, comic = false) {
    const words = triggerWordList();
    if (!words.length) return '';
    const list = words.join(', ');
    if (String(promptStyle()).startsWith('anima')) {
        return `触发词：${list}。程序会把它们放在 Anima 官方顺序里画师的位置（人数和角色之后、其他标签之前），${mode === 'ai' ? 'prompt' : '字段'}里不用写。`;
    }
    const tags = promptStyle() === MODEL_MOSS ? words.filter(isTriggerTag) : [];
    const plain = words.filter(word => !tags.includes(word));
    const tagNote = tags.length ? `${tags.join('、')} 由程序单独放在提示词的第一行，你不要写。` : '';
    if (comic) return `触发词：${list}。程序会把它们加进提示词，layout 里不用写。`;
    if (!plain.length) return `触发词：${tagNote}`;
    return mode === 'ai'
        ? `触发词：最终提示词必须带上这些触发词：${plain.join(', ')}。把它们原样写在 prompt 的最前面（不翻译、不改写、不加括号或权重），每次都要写。${tagNote}`
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
    // 漫画模式: the parser lays out a whole comic page (the people's looks included) instead of picture fields.
    // One page written again (🔄 on it) is one page.
    const comic = isComicPreset(preset) ? { panels: comicPanels(preset), pages: focus ? 1 : comicPages(preset), dialogue: preset.dialogue !== false } : null;
    const mode = comic ? 'ai' : promptMode();
    const allowOthers = !!preset.allowOthers;
    // The parser writes the picture's negative prompt too (Anima: a real negative prompt at CFG 4).
    const negative = !!settings.parserNegative;
    // 多张图: earlier parts of the floor (another time or place) get pictures of their own. One part written
    // again keeps its place and size, so neither the parts nor the place and aspect are asked for then.
    const scenes = focus || comic ? 0 : sceneLimit(settings.parser);
    // 图片插在正文中间: the parser picks the sentence each picture goes after.
    const place = !focus && !!settings.placeInStory;
    // 画谁不在画面里: who to draw when the target is not in the scene, instead of skipping (not for sprites,
    // which always show the target).
    const absent = settings.absentFallback !== false && preset.id !== 'sprite' ? { auto: !!target.auto } : null;
    // The parser picks the aspect ratio (resolution selector), unless this parser preset sets its own size.
    const aspect = !focus && parserPicksAspect(settings.comfy) && !presetResolution(preset)
        ? { ratios: ASPECT_RATIOS, fallback: parseAspect(settings.comfy.aspectRatio) || '1:1' }
        : null;
    // The comic page's canvas, for planning the panels (unknown while the parser picks the aspect ratio).
    const size = comic && (presetResolution(preset) ?? (aspect ? null : baseSize(settings.comfy)));
    if (size?.width > 0 && size?.height > 0) Object.assign(comic, { width: Math.round(size.width), height: Math.round(size.height) });
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
        appearance: [referenceBlock(target, mode, !!comic), allowOthers || absent ? othersReference(mesId, target, !!absent) : ''].filter(Boolean).join('\n'),
        fixed_fields: fixedFieldsBlock(preset),
        output_rules: outputRules(mode, allowOthers, negative, aspect, scenes, place, absent, comic),
        candidates,
        last_state: target.auto ? '（自动模式下不提供）' : formatState(lastState, shownFloors),
        prev_outputs: prevOutputs,
        history: history.length ? history.join('\n\n') : '（无）',
        // Where pictures go is asked as paragraph numbers: the floor is shown numbered then.
        latest: place || scenes > 1 || comic?.pages > 1
            ? numberedFloor(chat[mesId], maxChars)
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

    const triggerRule = triggerWordsRule(mode, !!comic);
    // 提示词写法: MOSS-Image with Moeblack's prompt skill (downloaded once, see mossSkill.js); Krea 2 with the rules
    // of its official template.
    const chinese = chinesePrompt();
    const writing = promptStyle() === MODEL_MOSS && settings.parser.mossSkill !== false ? await mossSkillBlock({ mode, comic, allowOthers, chinese })
        : promptStyle() === MODEL_KREA2 && settings.parser.kreaRules ? { text: kreaRulesBlock(mode), note: '提示词写法：Krea 2 官方模板（最后加上 Absolutely no text…）' }
            : null;
    // A comic page (every panel, person and speech bubble described) is a long answer.
    const minTokens = comic ? comicMinTokens(comic.pages) : 0;
    const raised = minTokens > (Number(settings.parser.maxTokens) || 2048);
    // Anima in natural-language mode: the presets were written for tags, so this rule overrides them.
    const natural = promptStyle() === 'anima-natural';
    return {
        system: [fillTemplate(systemTemplate, vars), natural ? NATURAL_STYLE_RULE : '', chinese ? CHINESE_PROMPT_RULE : '', triggerRule, writing?.text].filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n'),
        user: [fillTemplate(userTemplate, vars), focus ? focusBlock(focus) : '', comic ? comicReminder(comic.pages) : ''].filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n'),
        preset,
        mode,
        absent: !!absent,
        comic: !!comic,
        minTokens,
        notes: [
            `${modeLabel()} 模式 · 解析预设：${preset.name} · ${comic ? `漫画：AI 画整页分镜（最多 ${comic.panels} 格，${comic.dialogue ? '带对白' : '不画文字'}）` : `${mode === 'ai' ? 'AI 写完整提示词' : '固定外貌 + AI 补充'}${allowOthers ? ' · 允许其他人物' : ''}`}`,
            triggerRule ? `触发词：${triggerWordList().join(', ')}` : '',
            natural ? '英文自然语言写法' : '',
            chinese ? '中文提示词（角色标签、触发词原样保留）' : '',
            writing?.note ?? '',
            settings.parser.hideCharName ? `隐藏了角色卡的名字（AI 的消息标成「${HIDDEN_CHAR_LABEL}」）` : '',
            settings.parser.storyTagOnly
                ? hasStoryTag(chat[mesId].mes) ? `只读取 <${storyTagName()}> 标签里的正文` : `当前楼层没有 <${storyTagName()}> 标签，读取了全文（去掉了 \`\`\` 代码块）`
                : '',
            negative ? '解析模型补充反向提示词' : '',
            aspect ? '解析模型选择宽高比' : '',
            scenes ? `多张图：正文换了时间或地点时最多画 ${scenes} 张` : '',
            comic?.pages > 1 ? `漫画：按内容画 1–${comic.pages} 页（「多张图」的设置对漫画不起作用）` : '',
            raised ? `漫画的输出比较长：这次的最大输出用 ${minTokens}（设置里是 ${Number(settings.parser.maxTokens) || 2048}）` : '',
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
async function callCustom(system, user, signal, parser = getSettings().parser) {
    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
    const url = parser.customUrl.trim().replace(/\/+$/, '');
    if (!url) throw settingsError('未填写解析模型的 API 地址');
    if (!parser.customModel.trim()) throw settingsError('未填写解析模型名称');
    // Thinking parameters first, so the user's own 「附加请求参数」 can override them.
    const extraBody = { ...thinkingBody(parser), ...parseExtraBody() };
    const maxTokens = thinkingMaxTokens(parser);
    // Fields the thinking parameters do without (no temperature for Claude after 4.5), unless the user sets them.
    const omitted = thinkingOmits(parser).filter(key => !Object.hasOwn(extraBody, key));
    const temperature = omitted.includes('temperature') ? undefined : Number(parser.temperature);

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
            custom_exclude_body: omitted.length ? JSON.stringify(omitted) : undefined,
            max_tokens: maxTokens,
            temperature,
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
            temperature,
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
async function callProfile(system, user, signal, parser = getSettings().parser) {
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
async function callMain(system, user, signal, parser = getSettings().parser) {
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
 * @param {{ minTokens?: number }} [options] minTokens: the output limit for this request when the setting is lower
 *   (a comic page is a long answer)
 * @returns {Promise<ParserReply>}
 */
export async function callParser(system, user, parentSignal, { minTokens = 0 } = {}) {
    const settings = getSettings().parser;
    const parser = minTokens > (Number(settings.maxTokens) || 2048) ? { ...settings, maxTokens: minTokens } : settings;
    const { signal, dispose } = withTimeout(parentSignal, Number(parser.timeoutSec) || 0);
    try {
        switch (parser.source) {
            case 'profile':
                return await callProfile(system, user, signal, parser);
            case 'main':
                return await callMain(system, user, signal, parser);
            default:
                return await callCustom(system, user, signal, parser);
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
 * @param {{ onReply?: (reply: ParserReply) => void, onRetry?: (attempt: number, max: number, error: Error) => void, minTokens?: number, comic?: boolean }} [hooks]
 *   minTokens: see callParser; comic: 漫画模式, a reply without a usable comic layout counts as failed (see parseParserOutput)
 * @returns {Promise<{ reply: ParserReply, parsed: ReturnType<typeof parseParserOutput>, retried: number }>}
 */
export async function requestParse(system, user, signal, { onReply, onRetry, minTokens = 0, comic = false } = {}) {
    const retries = Math.max(0, Math.min(5, Math.trunc(Number(getSettings().parser.retries) || 0)));
    for (let attempt = 0; ; attempt++) {
        let reply = null;
        try {
            reply = await callParser(system, user, signal, { minTokens });
            onReply?.(reply);
            return { reply, parsed: parseParserReply(reply, { comic }), retried: attempt };
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
 * @param {{ comic?: boolean }} [options] see parseParserOutput
 */
export function parseParserReply(reply, options = {}) {
    const sources = [reply?.content, reply?.reasoning].filter(text => String(text ?? '').trim());
    const finish = reply?.finish ? `（finish_reason=${reply.finish}）` : '';
    if (!sources.length) {
        throw new Error(`解析模型返回了空内容${finish}。${THINKING_HINT}`);
    }
    let lastError = null;
    for (const text of sources) {
        try {
            return parseParserOutput(text, options);
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

/**
 * Mends what models get wrong inside JSON strings: raw line breaks and tabs, and double quotes they did not escape
 * (他说"你好"). A quote inside a string ends it only when JSON structure follows.
 */
function fixStrings(text) {
    let out = '';
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (!inString) {
            if (char === '"') inString = true;
            out += char;
        } else if (char === '\\') {
            out += char + (text[i + 1] ?? '');
            i++;
        } else if (char === '"') {
            const next = text.slice(i + 1).match(/^\s*(\S?)/)[1];
            if (!next || ',:}]'.includes(next)) {
                inString = false;
                out += char;
            } else {
                out += '\\"';
            }
        } else if (char === '\n') {
            out += '\\n';
        } else if (char === '\t') {
            out += '\\t';
        } else if (char !== '\r') {
            out += char;
        }
    }
    return out;
}

/** Index of the bracket closing the one at `open` (strings skipped), or -1 when the text ends first. */
function closingBracket(text, open) {
    let depth = 0;
    let inString = false;
    for (let i = open; i < text.length; i++) {
        const char = text[i];
        if (inString) {
            if (char === '\\') i++;
            else if (char === '"') inString = false;
        } else if (char === '"') {
            inString = true;
        } else if (char === '{' || char === '[') {
            depth++;
        } else if ((char === '}' || char === ']') && --depth === 0) {
            return i;
        }
    }
    return -1;
}

function parseLoose(text) {
    for (const candidate of [text, fixStrings(text)]) {
        try {
            return JSON.parse(candidate);
        } catch {
            // try next candidate
        }
    }
    return null;
}

/**
 * 漫画模式: what can be read of a comic layout in a reply that is not valid JSON (cut off at the output limit, or
 * broken somewhere): its summary and every item that is complete on its own.
 */
function salvageLayout(text) {
    const summaryAt = text.search(/"summary"\s*:\s*\{/);
    const summaryOpen = summaryAt < 0 ? -1 : text.indexOf('{', summaryAt);
    const summaryClose = summaryOpen < 0 ? -1 : closingBracket(text, summaryOpen);
    const summary = summaryClose > 0 ? parseLoose(text.slice(summaryOpen, summaryClose + 1)) : null;
    const items = [];
    const itemsAt = text.search(/"items"\s*:\s*\[/);
    let at = itemsAt < 0 ? text.length : text.indexOf('[', itemsAt) + 1;
    while (at < text.length) {
        const next = text.slice(at).search(/\S/);
        if (next < 0) break;
        at += next;
        if (text[at] === ',') {
            at++;
            continue;
        }
        if (text[at] !== '{') break;
        const close = closingBracket(text, at);
        if (close < 0) break;
        const item = parseLoose(text.slice(at, close + 1));
        if (item && typeof item === 'object') items.push(item);
        at = close + 1;
    }
    return items.length ? { summary: summary ?? {}, items } : null;
}

/**
 * 漫画模式, several pages, in a reply that is not valid JSON: every page whose layout can be read (a cut-off last one
 * as far as it goes), with the label and paragraph written in front of its layout.
 */
function salvagePages(text) {
    const pages = [];
    const pattern = /"layout"\s*:\s*\{/g;
    let match;
    while ((match = pattern.exec(text))) {
        const open = match.index + match[0].length - 1;
        const close = closingBracket(text, open);
        // The page's own fields: after the last brace before its layout.
        const head = text.slice(0, match.index).split(/[{}]/).pop();
        const field = name => head.match(new RegExp(`"${name}"\\s*:\\s*"?([^",}]*)"?`))?.[1]?.trim() ?? '';
        const layout = close > 0 ? parseLoose(text.slice(open, close + 1)) : salvageLayout(text.slice(open));
        if (layout && typeof layout === 'object') pages.push({ label: field('label'), start: field('start'), place: field('place'), layout });
        if (close < 0) break;
        pattern.lastIndex = close + 1;
    }
    return pages;
}

/** 漫画模式, several pages: each usable page as { label, start, place, page }, in order. */
function readPages(value) {
    return (Array.isArray(value) ? value : [])
        .filter(item => item && typeof item === 'object' && !Array.isArray(item))
        .map(item => ({
            label: normalizeValue(item.label ?? item.title ?? item.name),
            start: normalizeValue(item.start ?? item.begin),
            place: normalizeValue(item.place ?? item.position),
            page: readComicPage(layoutOf(item)),
        }))
        .filter(item => item.page);
}

/**
 * Where a reply keeps its comic layout: `layout` (asked for), `page` (v1.45), a layout written out as a string, or
 * the reply itself when it is just a layout.
 */
function layoutOf(object) {
    for (const value of [object.layout, object.page, object.comic, object.prompt]) {
        if (value && typeof value === 'object') return value;
        if (typeof value === 'string' && value.trim().startsWith('{')) {
            const parsed = parseLoose(value.trim());
            if (parsed && typeof parsed === 'object') return parsed;
        }
    }
    return Array.isArray(object.items) || Array.isArray(object.panels) ? object : null;
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
 * @param {{ comic?: boolean }} [options] comic: 漫画模式 — the reply must hold a usable comic layout (else it counts
 *   as failed, so it is asked again instead of drawn without one); what can be read of a broken one is kept
 * @returns {{ skip: boolean, reason?: string, target?: string } & Record<string, string>}
 */
export function parseParserOutput(raw, { comic = false } = {}) {
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
        const mended = fixStrings(body);
        for (const candidate of [body, repairJson(body), mended, mended.replace(/,\s*([}\]])/g, '$1')]) {
            try {
                object = JSON.parse(candidate);
                break;
            } catch {
                // try next candidate
            }
        }
    }

    // 漫画模式: one page's `layout`, or `pages` when the floor may get several.
    let pages = comic && object && typeof object === 'object' ? readPages(object.pages) : [];
    let layout = comic && object && typeof object === 'object' && !pages.length ? layoutOf(object) : null;
    let partial = false;
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
        if (comic) {
            pages = /"pages"\s*:\s*\[/.test(text) ? readPages(salvagePages(text)) : [];
            layout = pages.length ? null : salvageLayout(text);
            partial = pages.length > 0 || !!layout;
        }
        if (!Object.keys(object).length && !layout && !pages.length) {
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
    // Only in 漫画模式 with several pages: the last page is the end of the floor, the ones before it are drawn as the
    // floor's earlier parts (as 多张图 does), each placed at its own paragraph.
    if (pages.length) {
        const last = pages.at(-1);
        result.page = last.page;
        if (partial) result.partial = true;
        result.earlierScenes = pages.slice(0, -1).map(item => ({
            label: item.label,
            start: item.start,
            place: item.place,
            absent: result.absent,
            target: result.target,
            looks: result.looks,
            ...Object.fromEntries(PARSED_FIELDS.map(field => [field, ''])),
            prompt: '',
            negative: '',
            page: item.page,
        }));
        result.start = result.earlierScenes.length ? last.start : '';
        result.place = last.place || result.place;
        result.prompt = '';
    }
    // Only in 漫画模式: the comic page the parser laid out (see comic.js).
    const page = pages.length ? null : readComicPage(layout);
    if (page) {
        result.page = page;
        if (partial) result.partial = true;
        // A layout given as the prompt is not a written-out prompt.
        if (layout === object.prompt || String(object.prompt ?? '').trim().startsWith('{')) result.prompt = '';
    }
    if (comic && !result.skip && !result.page) {
        throw new Error('解析模型没有按漫画格式输出：回复里没有 layout（MOSS-Image 的 JSON 版面：summary + items），或者 items 是空的');
    }
    if (!result.skip && !result.prompt && !result.page && PARSED_FIELDS.every(field => !result[field])) {
        throw new Error('解析结果里没有任何画面字段');
    }
    return result;
}
