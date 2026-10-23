import { comicLayout, isComicPreset, layoutText, readLayoutPrompt } from './comic.js';
import { ANIMA_NATURAL_TEMPLATE, ANIMA_NOBODY_LINE, BORDER_NEGATIVE, ANIMA_OTHERS_LINE, ANIMA_PROMPT_TEMPLATE, ANIMA_PROMPT_TEMPLATE_V1, ANIMA_SOLO_LINE, MODEL_MOSS, NOBODY_LINE, OTHERS_LINE, PARSED_FIELDS, SOLO_LINE } from './constants.js';
import { promptStyle } from './modes.js';
import { fillTemplate, getSettings, resolveMacros } from './utils.js';

function cleanLine(line) {
    return line
        .replace(/\s+/g, ' ')
        .replace(/\s+([,.;:!?])/g, '$1')
        .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
        .replace(/,\s*\./g, '.')
        .replace(/\.(?:\s*\.)+/g, '.')
        .replace(/^[\s,.;:]+/, '')
        .replace(/[\s,;:]+$/, '')
        .trim();
}

/**
 * Tidies one part of an Anima (tag) prompt. Only spacing and empty tags change: cleanLine's punctuation rules are
 * for sentences and would break tags such as ":d", ":3" or ";)".
 */
function cleanTags(text) {
    return String(text ?? '').replace(/\s+/g, ' ').split(',').map(tag => tag.trim()).filter(Boolean).join(', ');
}

const SENTENCE_END = /[.!?。！？]$/;
/** In a tag prompt only a full stop ends a sentence: "love live!" or "!?" are tags. */
const TAG_SENTENCE_END = /[.。]$/;

function closeSentence(text) {
    return SENTENCE_END.test(text) ? text : `${text}.`;
}

/**
 * Joins the prompt's parts into one paragraph. Krea 2 reads sentences, so each part is closed with a full stop;
 * Anima reads tags, so parts are joined with commas (a part that already ends a sentence just gets a space).
 */
function joinParts(parts, tags) {
    const text = tags
        ? parts.reduce((out, part) => (!out ? part : TAG_SENTENCE_END.test(out) ? `${out} ${part}` : `${out}, ${part}`), '')
        : parts.map(closeSentence).join(' ');
    return text.replace(/\s+/g, ' ').trim();
}

/**
 * With other people in the picture the template's "solo" line would contradict it, so it is dropped, and the
 * people go in {{others}} (added before the camera / lighting line when the template has no such slot).
 */
function templateFor(template, hasOthers, tags, nobody = false) {
    if (nobody) {
        // Nobody in the scene: the "one person" line says "no people" instead; the person lines are empty and drop out.
        const lines = template.split('\n');
        const at = lines.findIndex(line => [SOLO_LINE, ANIMA_SOLO_LINE].includes(line.trim()));
        if (at >= 0) lines[at] = tags ? ANIMA_NOBODY_LINE : NOBODY_LINE;
        else lines.splice(Math.min(1, lines.length), 0, tags ? ANIMA_NOBODY_LINE : NOBODY_LINE);
        return lines.join('\n');
    }
    if (!hasOthers) return template;
    const lines = template.split('\n').filter(line => ![SOLO_LINE, ANIMA_SOLO_LINE].includes(line.trim()));
    if (!lines.some(line => line.includes('{{others}}'))) {
        let at = lines.findIndex(line => /\{\{(camera|lighting)\}\}/.test(line));
        if (at < 0) at = lines.findIndex(line => line.includes('{{suffix}}'));
        lines.splice(at < 0 ? lines.length : at, 0, tags ? ANIMA_OTHERS_LINE : OTHERS_LINE);
    }
    return lines.join('\n');
}

/** The mode's trigger words (comma / new line separated, macros resolved). */
export function triggerWordList(text = getSettings().triggerWords) {
    return resolveMacros(String(text ?? '')).split(/[,，\n]/).map(word => word.trim()).filter(Boolean);
}

/**
 * A MOSS-Image structural tag such as <|artist|>fkey<|/artist|>: a style LoRA's trigger that was trained as the
 * prompt's first line, written tight (no spaces inside, no full stop), followed by a line break.
 */
export function isTriggerTag(word) {
    return /^<\|[^|<>\s]+\|>[\s\S]*<\|\/[^|<>\s]+\|>$/.test(String(word ?? '').trim());
}

/** Trigger words that go into the text: in MOSS-Image without its structural tags (those get lines of their own). */
function textTriggerWords(words = triggerWordList()) {
    return promptStyle() === MODEL_MOSS ? words.filter(word => !isTriggerTag(word)) : words;
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Escaped parentheses read as plain ones, so "x \\(y\\)" and "x (y)" are the same words. */
function unescapeParens(text) {
    return String(text).replace(/\\([()])/g, '$1');
}

/** Whether `word` is in `text` as a whole word or tag (case-insensitive; escaped parentheses count as plain). */
function containsWord(text, word) {
    const pattern = escapeRegExp(unescapeParens(word));
    return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${pattern}(?=$|[^\\p{L}\\p{N}_])`, 'iu').test(unescapeParens(text));
}

/**
 * Puts the trigger words that are not in the prompt yet in front of it, so every picture has them however
 * the prompt was written (template, the parser AI's own prompt, a custom template without {{trigger}}).
 */
export function withTriggerWords(prompt, words = triggerWordList()) {
    const text = String(prompt ?? '').trim();
    const missing = words.filter(word => !containsWord(text, word));
    if (!missing.length) return text;
    return text ? `${missing.join(', ')}, ${text}` : missing.join(', ');
}

/** The end of a ComfyUI weight group's text: ":1.2", ": 0.8", ":.5", ":-1". */
const WEIGHT_END = /:\s*-?(?:\d+(?:\.\d*)?|\.\d+)\s*$/;

/**
 * Escapes ( ) so ComfyUI keeps them as text: unescaped, it reads them as emphasis and drops them, which breaks
 * Danbooru tags like "artoria pendragon (fate)". Weight groups are kept: "(smile:1.2)", "(artoria pendragon
 * (fate):1.2)" (only the inner pair is escaped) and a pair that just wraps one, "((smile:1.2))". Parentheses
 * that are already escaped are left alone.
 */
export function escapeParens(text) {
    const source = String(text ?? '');
    const escape = new Set();
    const kept = new Set();
    const open = [];
    for (let i = 0; i < source.length; i++) {
        const char = source[i];
        if (char === '\\') {
            i++;
            continue;
        }
        if (char === '(') {
            open.push(i);
        } else if (char === ')') {
            if (!open.length) {
                escape.add(i);
                continue;
            }
            const start = open.pop();
            const inner = source.slice(start + 1, i);
            const innerStart = start + 1 + (inner.length - inner.trimStart().length);
            const innerEnd = start + inner.trimEnd().length;
            const wrapsKept = kept.has(innerStart) && kept.has(innerEnd) && matchingClose(source, innerStart) === innerEnd;
            if (WEIGHT_END.test(inner) || wrapsKept) {
                kept.add(start);
                kept.add(i);
            } else {
                escape.add(start);
                escape.add(i);
            }
        }
    }
    for (const index of open) escape.add(index);
    let out = '';
    for (let i = 0; i < source.length; i++) out += escape.has(i) ? `\\${source[i]}` : source[i];
    return out;
}

/** Index of the ")" closing the "(" at `start`, skipping escaped parentheses. */
function matchingClose(source, start) {
    let depth = 0;
    for (let i = start; i < source.length; i++) {
        if (source[i] === '\\') {
            i++;
            continue;
        }
        if (source[i] === '(') depth++;
        else if (source[i] === ')' && --depth === 0) return i;
    }
    return -1;
}

/**
 * Anima's tag order, from its model card: quality / meta / year / safety tags, then the subject count (1girl,
 * 1boy …), then character, series and artist, then the general tags. Within a section the order is free.
 */
const LEAD_TAGS = new Set([
    'masterpiece', 'best quality', 'good quality', 'normal quality', 'low quality', 'worst quality',
    'highres', 'absurdres', 'lowres', 'official art', 'anime screenshot',
    'newest', 'recent', 'mid', 'early', 'old',
]);
const SAFETY_TAGS = new Set(['safe', 'sensitive', 'nsfw', 'explicit']);
/** score_7, score_8_up, year 2025 */
const LEAD_PATTERN = /^(?:score_\d+(?:_up)?|year \d{4})$/;
/** 1girl, 2girls, 6+girls, 1boy, 1other, multiple girls … */
const COUNT_TAG = /^(?:\d+\+?|multiple )(?:girl|boy|other)s?$/;
const NUMBERED_COUNT = /^(\d+)\+?(girl|boy|other)s?$/;

/** A tag as compared: lower case, without a weight group "(tag:1.2)", escaped parentheses read as plain ones. */
function tagKey(tag) {
    const text = unescapeParens(tag).trim().toLowerCase();
    const weighted = text.match(/^\((.+?)(?::\s*-?[\d.]+)?\)$/);
    return (weighted ? weighted[1] : text).trim();
}

const RATINGS = { safe: 'safe', general: 'safe', sensitive: 'sensitive', nsfw: 'nsfw', questionable: 'nsfw', explicit: 'explicit' };

/** The parser's safety rating as one of Anima's safety tags ('' when it is none of them). */
export function ratingTag(value) {
    const key = String(value ?? '').trim().toLowerCase();
    return Object.hasOwn(RATINGS, key) ? RATINGS[key] : '';
}

/** Whether a tag list has one of Anima's safety tags. */
function hasSafetyTag(text) {
    return String(text ?? '').split(',').some(tag => SAFETY_TAGS.has(tagKey(tag)));
}

/** Splits the count tags (1girl, 2boys …) off a tag list: [the list without them, their keys]. */
function takeCounts(text) {
    const counts = [];
    const kept = String(text ?? '').split(',').filter(tag => {
        const key = tagKey(tag);
        if (!COUNT_TAG.test(key)) return true;
        counts.push(key);
        return false;
    });
    return [kept.join(','), counts];
}

/**
 * Everyone in the picture as count tags: the character's own count (from its look) plus one count tag per other
 * person, added up ("1girl" + "1girl" → "2girls"; "1girl" + "1boy" → "1girl, 1boy").
 */
function mergeCounts(own, others) {
    const totals = new Map();
    const kept = [];
    const add = key => {
        const numbered = key.match(NUMBERED_COUNT);
        if (numbered) totals.set(numbered[2], (totals.get(numbered[2]) ?? 0) + Number(numbered[1]));
        else if (!kept.includes(key)) kept.push(key);
    };
    [...new Set(own)].forEach(add);
    others.forEach(add);
    const counted = [...totals].map(([kind, n]) => (n === 1 ? `1${kind}` : n >= 6 ? `6+${kind}s` : `${n}${kind}s`));
    return [...counted, ...kept];
}

/**
 * Puts a tag prompt in Anima's recommended order: quality / meta / year / safety tags first (one safety tag: the
 * first one there, else the parser's rating), then the subject count, then the character's own tags (the preset's
 * trigger: a character LoRA's trigger, or the character and series names), then the rest as it was (artist and
 * trigger words, then the general tags). A part that ends a sentence stays where it is.
 * @param {{ rating?: string, count?: string[]|null, character?: string[] }} [order] count: everyone's count tags,
 *   in place of the ones in the text (none given: the ones in the text, once each)
 */
export function officialTagOrder(text, { rating = '', count = null, character = [] } = {}) {
    const lead = [];
    const counts = [];
    const own = [];
    const rest = [];
    const ownKeys = new Set(character.map(tagKey));
    const once = (list, item, key) => {
        if (!list.some(tag => tagKey(tag) === key)) list.push(item);
    };
    const safety = () => lead.some(tag => SAFETY_TAGS.has(tagKey(tag)));
    for (const item of String(text ?? '').split(',').map(part => part.trim()).filter(Boolean)) {
        const key = tagKey(item);
        if (SAFETY_TAGS.has(key)) {
            if (!safety()) lead.push(item);
        } else if (LEAD_TAGS.has(key) || LEAD_PATTERN.test(key)) once(lead, item, key);
        else if (COUNT_TAG.test(key) || key === 'no humans') once(counts, item, key);
        else if (ownKeys.has(key)) once(own, item, key);
        else rest.push(item);
    }
    if (rating && !safety()) lead.push(rating);
    return [...lead, ...(count?.length ? count : counts), ...own, ...rest].join(', ');
}

/** A text without one word, and without the separators that are left over where it was. */
function withoutWord(text, word) {
    const pattern = new RegExp(`[ \\t]*${escapeRegExp(word)}[ \\t]*`, 'g');
    const lines = text.split('\n');
    return lines
        .map(line => (line.includes(word)
            ? line.replace(pattern, ' ').replace(/([,.;:])(?:\s*[,.;:])+/g, '$1').replace(/^[\s,.;:]+|[\s,;:]+$/g, '').replace(/ {2,}/g, ' ')
            : line))
        // A line that was only the word goes; blank lines that were there stay.
        .filter((line, index) => line.trim() || !lines[index].trim())
        .join('\n');
}

/**
 * MOSS-Image's structural trigger tags, each on a line of its own at the very top of the prompt (taken out of the
 * text wherever else it had them). A JSON layout prompt (漫画模式) keeps its layout as it is: the plain trigger
 * words missing from it go at the start of its summary.
 */
function withTriggerTags(prompt, words) {
    const tags = words.filter(isTriggerTag);
    const plain = words.filter(word => !isTriggerTag(word));
    const layout = readLayoutPrompt(prompt);
    if (layout) {
        const head = tags.reduce((text, tag) => withoutWord(text, tag), layout.head).trim();
        const missing = plain.filter(word => !containsWord(prompt, word));
        const summary = layout.layout.summary;
        if (missing.length) summary.caption = [missing.join(', '), String(summary.caption ?? '')].filter(Boolean).join(' ');
        const body = missing.length ? layoutText(layout.layout) : String(prompt).slice(layout.head.length).trim();
        return [...tags, head, body].filter(Boolean).join('\n');
    }
    const text = withTriggerWords(tags.reduce(withoutWord, String(prompt ?? '').trim()), plain);
    return [...tags, text].filter(Boolean).join('\n');
}

/**
 * Last step for every generated prompt: the mode's trigger words (MOSS-Image's structural tags as the first lines),
 * Anima's tag order, then escaping if the mode wants it (not in a JSON layout, which would stop being one).
 * @param {{ rating?: string, count?: string[]|null, character?: string[] }} [order] see officialTagOrder
 */
export function finishPrompt(prompt, order = {}) {
    const settings = getSettings();
    const words = triggerWordList(settings.triggerWords);
    if (promptStyle() === MODEL_MOSS) {
        const text = withTriggerTags(prompt, words);
        return settings.escapeParens && !readLayoutPrompt(text) ? escapeParens(text) : text;
    }
    let text = withTriggerWords(prompt, words);
    if (promptStyle() === 'anima') text = officialTagOrder(text, order);
    return settings.escapeParens ? escapeParens(text) : text;
}

/**
 * 漫画模式: the page the parser laid out, as MOSS-Image's JSON layout for the canvas it is drawn on. Its summary
 * starts with the plain trigger words (the mode's and the character LoRA's) and the style prefixes, then the page's
 * description, and ends with the suffix; structural tags go on the first line.
 */
function buildComicPrompt(preset, page, { parserPreset, canvas }) {
    const settings = getSettings();
    const words = [...textTriggerWords(), resolveMacros(preset?.trigger || '')].filter(Boolean).join(', ');
    const prefix = [settings.prefix, parserPreset?.prefix].map(text => resolveMacros(text || '')).filter(Boolean).join(' ');
    const parts = [
        [words, prefix].filter(Boolean).join(' '),
        page.caption,
        resolveMacros(settings.suffix || ''),
    ].map(text => cleanLine(String(text || ''))).filter(Boolean);
    const caption = joinParts(parts, false);
    return finishPrompt(layoutText(comicLayout(page, { width: canvas.width, height: canvas.height, caption })));
}

/**
 * Builds the final positive prompt.
 * - "fixed" mode: the character preset's appearance plus the parsed fields, through the assembly template.
 *   A template line whose placeholders are all empty is dropped, so missing fields leave no dangling labels.
 * - "ai" mode: the parser's own `prompt`, with the LoRA trigger and style prefixes around it.
 * - 漫画模式 (a comic parser preset with the parser's `page`): MOSS-Image's JSON layout of the page for `canvas`.
 * Either way the mode's trigger words are added (see finishPrompt). Anima joins the parts as tags, in the order its
 * model card recommends (officialTagOrder), with the parser's safety rating and everyone's count tags.
 * Other people (`others`) are only used when the parser preset allows them.
 * @param {object|null} preset Character preset
 * @param {object} parsed Parser output
 * @param {{ parserPreset?: object, mode?: 'fixed'|'ai', nobody?: boolean, canvas?: { width: number, height: number } }} [options]
 *   nobody: only the scenery (画谁不在画面里); canvas: the size a comic page is drawn at
 */
export function buildImagePrompt(preset, parsed, { parserPreset = null, mode = 'fixed', nobody = false, canvas = null } = {}) {
    if (isComicPreset(parserPreset) && parsed?.page && canvas) return buildComicPrompt(preset, parsed.page, { parserPreset, canvas });
    const settings = getSettings();
    // Anima writes tags, unless its "英文自然语言" switch is on: then sentences, like Krea 2.
    const style = promptStyle();
    const tags = style === 'anima';
    const prefix = [settings.prefix, parserPreset?.prefix].map(text => resolveMacros(text || '')).filter(Boolean).join(tags ? ', ' : ' ');

    const clean = tags ? cleanTags : text => cleanLine(String(text || ''));
    const anima = String(style).startsWith('anima');
    // Anima: the character's own tags (its LoRA trigger, or its character and series names) and the mode's trigger
    // words (artist) have places of their own in the official order; the parser rates each picture's safety,
    // unless the user's own tags already set it.
    const character = resolveMacros(preset?.trigger || '');
    const artist = triggerWordList(settings.triggerWords).join(', ');
    const own = [prefix, character, artist, resolveMacros(settings.suffix || ''), resolveMacros(preset?.appearance || '')].join(', ');
    const rating = anima && !hasSafetyTag(own) ? ratingTag(parsed?.rating) : '';
    const order = { rating, character: triggerWordList(character) };
    if (mode === 'ai' && parsed?.prompt) {
        const scenery = nobody ? (tags ? ANIMA_NOBODY_LINE : NOBODY_LINE) : '';
        // The parser's tags start with the count (put in its place by officialTagOrder); the trigger words go in
        // the artist's place. In sentences, the tags lead and the description follows.
        const lead = !anima ? [character, prefix] : tags ? [[prefix, rating, character].join(', ')] : [[prefix, rating, character, artist].join(', ')];
        const parts = [...lead, scenery, parsed.prompt, resolveMacros(settings.suffix || '')]
            .map(clean)
            .filter(Boolean);
        return finishPrompt(joinParts(parts, tags), order);
    }

    const vars = {
        // The mode's trigger words first, then the character LoRA's (MOSS-Image's structural tags: see finishPrompt).
        trigger: [...textTriggerWords(triggerWordList(settings.triggerWords)), character].filter(Boolean).join(', '),
        prefix,
        suffix: resolveMacros(settings.suffix || ''),
        appearance: resolveMacros(preset?.appearance || ''),
        character,
        artist,
    };
    for (const field of PARSED_FIELDS) {
        vars[field] = String(parsed?.[field] || '').trim();
    }
    vars.rating = rating;
    vars.count = '';
    if (!parserPreset?.allowOthers) vars.others = '';
    // 画谁不在画面里, nobody there: only the place is drawn.
    if (nobody) for (const field of ['appearance', 'outfit', 'action', 'expression', 'demeanor', 'others']) vars[field] = '';
    if (tags) {
        // Everyone's count tags go together after the quality tags: the character's own (from its look) and one
        // per other person, added up.
        const mine = [];
        for (const field of ['appearance', 'outfit', 'action', 'expression', 'demeanor', 'scene', 'camera', 'lighting']) {
            const [kept, found] = takeCounts(vars[field]);
            vars[field] = kept;
            mine.push(...found);
        }
        const [others, theirs] = takeCounts(vars.others);
        vars.others = others;
        order.count = mergeCounts(mine, theirs);
        vars.count = order.count.join(', ');
    }

    const lines = [];
    // The untouched tag template does not fit sentences: natural-language Anima uses the sentence template then.
    let template = String(settings.promptTemplate || '');
    if (style === 'anima-natural' && [ANIMA_PROMPT_TEMPLATE, ANIMA_PROMPT_TEMPLATE_V1].includes(template)) template = ANIMA_NATURAL_TEMPLATE;
    for (const line of templateFor(template, !!vars.others, tags, nobody).split('\n')) {
        const keys = [...line.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]).filter(key => Object.hasOwn(vars, key));
        if (keys.length && keys.every(key => !vars[key])) continue;
        const cleaned = clean(fillTemplate(line, vars));
        // Lines are joined into one paragraph, so each is closed (sentences) or comma-separated (tags).
        if (cleaned) lines.push(cleaned);
    }
    return finishPrompt(joinParts(lines, tags), order);
}

const EMPTY_ANSWERS = new Set(['无', '没有', '空', '无需', 'none', 'n/a', 'na', 'null', 'false', '-']);

function tagSet(text) {
    return new Set(unescapeParens(text).split(',').map(tag => tag.trim().toLowerCase()).filter(Boolean));
}

/**
 * The negative prompt: the global one, the character preset's extra one, the tags against white / black bars
 * (防止白边, noBorder) and, when the parser is asked for one (parserNegative), the parser's tags for this picture.
 * An added tag that is already there, or that is in the positive prompt (it would cancel what the picture is meant
 * to show), is left out.
 * @param {object|null} preset Character preset
 * @param {object|null} [parsed] Parser output (its `negative`)
 * @param {string} [prompt] The positive prompt
 */
export function buildNegativePrompt(preset, parsed = null, prompt = '') {
    const settings = getSettings();
    let base = [settings.negativePrompt, preset?.negative]
        .map(text => resolveMacros(text || ''))
        .filter(Boolean)
        .join(', ');
    if (settings.noBorder) {
        const taken = new Set([...tagSet(base), ...tagSet(prompt)]);
        base = [base, ...BORDER_NEGATIVE.split(', ').filter(tag => !taken.has(tag))].filter(Boolean).join(', ');
    }
    const fromParser = settings.parserNegative ? String(parsed?.negative || '') : '';
    if (!fromParser.trim()) return base;
    const taken = new Set([...tagSet(base), ...tagSet(prompt)]);
    const tags = [];
    for (const tag of fromParser.split(',').map(item => item.trim()).filter(Boolean)) {
        const key = unescapeParens(tag).toLowerCase();
        // Placeholders for "nothing" are not tags.
        if (taken.has(key) || EMPTY_ANSWERS.has(key)) continue;
        taken.add(key);
        tags.push(tag);
    }
    if (!tags.length) return base;
    const added = tags.join(', ');
    return [base, settings.escapeParens ? escapeParens(added) : added].filter(Boolean).join(', ');
}
