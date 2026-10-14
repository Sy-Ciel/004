import { ANIMA_OTHERS_LINE, ANIMA_PROMPT_TEMPLATE, ANIMA_SOLO_LINE, DEFAULT_PROMPT_TEMPLATE, OTHERS_LINE, PARSED_FIELDS, SOLO_LINE } from './constants.js';
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
function templateFor(template, hasOthers, tags) {
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

/** Last step for every generated prompt: the mode's trigger words, then escaping if the mode wants it. */
export function finishPrompt(prompt) {
    const settings = getSettings();
    const text = withTriggerWords(prompt, triggerWordList(settings.triggerWords));
    return settings.escapeParens ? escapeParens(text) : text;
}

/**
 * Builds the final positive prompt.
 * - "fixed" mode: the character preset's appearance plus the parsed fields, through the assembly template.
 *   A template line whose placeholders are all empty is dropped, so missing fields leave no dangling labels.
 * - "ai" mode: the parser's own `prompt`, with the LoRA trigger and style prefixes around it.
 * Either way the mode's trigger words are added (see finishPrompt). Anima joins the parts as tags.
 * Other people (`others`) are only used when the parser preset allows them.
 * @param {object|null} preset Character preset
 * @param {object} parsed Parser output
 * @param {{ parserPreset?: object, mode?: 'fixed'|'ai' }} [options]
 */
export function buildImagePrompt(preset, parsed, { parserPreset = null, mode = 'fixed' } = {}) {
    const settings = getSettings();
    // Anima writes tags, unless its "英文自然语言" switch is on: then sentences, like Krea 2.
    const style = promptStyle();
    const tags = style === 'anima';
    const prefix = [settings.prefix, parserPreset?.prefix].map(text => resolveMacros(text || '')).filter(Boolean).join(tags ? ', ' : ' ');

    const clean = tags ? cleanTags : text => cleanLine(String(text || ''));
    if (mode === 'ai' && parsed?.prompt) {
        const parts = [resolveMacros(preset?.trigger || ''), prefix, parsed.prompt, resolveMacros(settings.suffix || '')]
            .map(clean)
            .filter(Boolean);
        return finishPrompt(joinParts(parts, tags));
    }

    const vars = {
        // The mode's trigger words first, then the character LoRA's.
        trigger: [...triggerWordList(settings.triggerWords), resolveMacros(preset?.trigger || '')].filter(Boolean).join(', '),
        prefix,
        suffix: resolveMacros(settings.suffix || ''),
        appearance: resolveMacros(preset?.appearance || ''),
    };
    for (const field of PARSED_FIELDS) {
        vars[field] = String(parsed?.[field] || '').trim();
    }
    if (!parserPreset?.allowOthers) vars.others = '';

    const lines = [];
    // The untouched tag template does not fit sentences: natural-language Anima uses the sentence template then.
    let template = String(settings.promptTemplate || '');
    if (style === 'anima-natural' && template === ANIMA_PROMPT_TEMPLATE) template = DEFAULT_PROMPT_TEMPLATE;
    for (const line of templateFor(template, !!vars.others, tags).split('\n')) {
        const keys = [...line.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]).filter(key => Object.hasOwn(vars, key));
        if (keys.length && keys.every(key => !vars[key])) continue;
        const cleaned = clean(fillTemplate(line, vars));
        // Lines are joined into one paragraph, so each is closed (sentences) or comma-separated (tags).
        if (cleaned) lines.push(cleaned);
    }
    return finishPrompt(joinParts(lines, tags));
}

const EMPTY_ANSWERS = new Set(['无', '没有', '空', '无需', 'none', 'n/a', 'na', 'null', 'false', '-']);

function tagSet(text) {
    return new Set(unescapeParens(text).split(',').map(tag => tag.trim().toLowerCase()).filter(Boolean));
}

/**
 * The negative prompt: the global one, the character preset's extra one and, when the parser is asked for one
 * (parserNegative), the parser's tags for this picture. A parser tag that is already there, or that is in the
 * positive prompt (it would cancel what the picture is meant to show), is left out.
 * @param {object|null} preset Character preset
 * @param {object|null} [parsed] Parser output (its `negative`)
 * @param {string} [prompt] The positive prompt
 */
export function buildNegativePrompt(preset, parsed = null, prompt = '') {
    const settings = getSettings();
    const base = [settings.negativePrompt, preset?.negative]
        .map(text => resolveMacros(text || ''))
        .filter(Boolean)
        .join(', ');
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
