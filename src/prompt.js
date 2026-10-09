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

/**
 * Builds the final positive prompt from the fixed part (preset) and the parsed part (AI).
 * A template line whose placeholders are all empty is dropped, so missing fields leave no dangling labels.
 */
export function buildImagePrompt(preset, parsed) {
    const settings = getSettings();
    const vars = {
        trigger: resolveMacros(preset?.trigger || ''),
        prefix: resolveMacros(settings.prefix || ''),
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
        if (cleaned) lines.push(/[.!?。！？]$/.test(cleaned) ? cleaned : `${cleaned}.`);
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
