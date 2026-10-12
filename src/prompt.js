import { ANIMA_OTHERS_LINE, ANIMA_SOLO_LINE, OTHERS_LINE, PARSED_FIELDS, SOLO_LINE } from './constants.js';
import { isAnimaMode } from './modes.js';
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

const SENTENCE_END = /[.!?。！？]$/;

function closeSentence(text) {
    return SENTENCE_END.test(text) ? text : `${text}.`;
}

/**
 * Joins the prompt's parts into one paragraph. Krea 2 reads sentences, so each part is closed with a full stop;
 * Anima reads tags, so parts are joined with commas (a part that already ends a sentence just gets a space).
 */
function joinParts(parts, tags) {
    const text = tags
        ? parts.reduce((out, part) => (!out ? part : SENTENCE_END.test(out) ? `${out} ${part}` : `${out}, ${part}`), '')
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

/** Whether `word` is in `text` as a whole word or tag (case-insensitive; escaped parentheses count as plain). */
function containsWord(text, word) {
    const plain = text.replace(/\\([()])/g, '$1');
    return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapeRegExp(word)}(?=$|[^\\p{L}\\p{N}_])`, 'iu').test(plain);
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

/** A ComfyUI weight like "(smile:1.2)"; those keep their parentheses. */
const WEIGHT = /(?<!\\)\([^()]*?:\s*-?\d+(?:\.\d+)?\s*\)/g;

/**
 * Escapes ( ) so ComfyUI keeps them as text: unescaped, it reads them as emphasis and drops them, which breaks
 * Danbooru tags like "artoria pendragon (fate)". Explicit weights such as "(smile:1.2)" are left alone.
 */
export function escapeParens(text) {
    const kept = [];
    const masked = String(text ?? '').replace(WEIGHT, match => `\u0001${kept.push(match) - 1}\u0001`);
    return masked.replace(/(?<!\\)[()]/g, '\\$&').replace(/\u0001(\d+)\u0001/g, (_, index) => kept[Number(index)]);
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
    const tags = isAnimaMode();
    const prefix = [settings.prefix, parserPreset?.prefix].map(text => resolveMacros(text || '')).filter(Boolean).join(tags ? ', ' : ' ');

    if (mode === 'ai' && parsed?.prompt) {
        const parts = [resolveMacros(preset?.trigger || ''), prefix, parsed.prompt, resolveMacros(settings.suffix || '')]
            .map(text => cleanLine(String(text || '')))
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
    for (const line of templateFor(String(settings.promptTemplate || ''), !!vars.others, tags).split('\n')) {
        const keys = [...line.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]).filter(key => Object.hasOwn(vars, key));
        if (keys.length && keys.every(key => !vars[key])) continue;
        const cleaned = cleanLine(fillTemplate(line, vars));
        // Lines are joined into one paragraph, so each is closed (sentences) or comma-separated (tags).
        if (cleaned) lines.push(cleaned);
    }
    return finishPrompt(joinParts(lines, tags));
}

export function buildNegativePrompt(preset) {
    const settings = getSettings();
    return [settings.negativePrompt, preset?.negative]
        .map(text => resolveMacros(text || ''))
        .filter(Boolean)
        .join(', ');
}
