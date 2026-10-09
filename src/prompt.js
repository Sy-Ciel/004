import { PARSED_FIELDS } from './constants.js';
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

function closeSentence(text) {
    return /[.!?。！？]$/.test(text) ? text : `${text}.`;
}

/**
 * Builds the final positive prompt.
 * - "fixed" mode: the character preset's appearance plus the parsed fields, through the assembly template.
 *   A template line whose placeholders are all empty is dropped, so missing fields leave no dangling labels.
 * - "ai" mode: the parser's own `prompt`, with the LoRA trigger and style prefixes around it.
 * @param {object|null} preset Character preset
 * @param {object} parsed Parser output
 * @param {{ parserPreset?: object, mode?: 'fixed'|'ai' }} [options]
 */
export function buildImagePrompt(preset, parsed, { parserPreset = null, mode = 'fixed' } = {}) {
    const settings = getSettings();
    const prefix = [settings.prefix, parserPreset?.prefix].map(text => resolveMacros(text || '')).filter(Boolean).join(' ');

    if (mode === 'ai' && parsed?.prompt) {
        return [resolveMacros(preset?.trigger || ''), prefix, parsed.prompt, resolveMacros(settings.suffix || '')]
            .map(text => cleanLine(String(text || '')))
            .filter(Boolean)
            .map(closeSentence)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    const vars = {
        trigger: resolveMacros(preset?.trigger || ''),
        prefix,
        suffix: resolveMacros(settings.suffix || ''),
        appearance: resolveMacros(preset?.appearance || ''),
    };
    for (const field of PARSED_FIELDS) {
        vars[field] = String(parsed?.[field] || '').trim();
    }

    const lines = [];
    for (const line of String(settings.promptTemplate || '').split('\n')) {
        const keys = [...line.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]).filter(key => Object.hasOwn(vars, key));
        if (keys.length && keys.every(key => !vars[key])) continue;
        const cleaned = cleanLine(fillTemplate(line, vars));
        // Lines are joined into one paragraph, so close each sentence to keep them from running together.
        if (cleaned) lines.push(closeSentence(cleaned));
    }
    return lines.join(' ').replace(/\s+/g, ' ').trim();
}

export function buildNegativePrompt(preset) {
    const settings = getSettings();
    return [settings.negativePrompt, preset?.negative]
        .map(text => resolveMacros(text || ''))
        .filter(Boolean)
        .join(', ');
}
