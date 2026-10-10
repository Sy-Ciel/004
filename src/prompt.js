import { OTHERS_LINE, PARSED_FIELDS, SOLO_LINE } from './constants.js';
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
 * With other people in the picture the template's "solo" line would contradict it, so it is dropped, and the
 * people go in {{others}} (added before the camera / lighting line when the template has no such slot).
 */
function templateFor(template, hasOthers) {
    if (!hasOthers) return template;
    const lines = template.split('\n').filter(line => line.trim() !== SOLO_LINE);
    if (!lines.some(line => line.includes('{{others}}'))) {
        let at = lines.findIndex(line => /\{\{(camera|lighting)\}\}/.test(line));
        if (at < 0) at = lines.findIndex(line => line.includes('{{suffix}}'));
        lines.splice(at < 0 ? lines.length : at, 0, OTHERS_LINE);
    }
    return lines.join('\n');
}

/**
 * Builds the final positive prompt.
 * - "fixed" mode: the character preset's appearance plus the parsed fields, through the assembly template.
 *   A template line whose placeholders are all empty is dropped, so missing fields leave no dangling labels.
 * - "ai" mode: the parser's own `prompt`, with the LoRA trigger and style prefixes around it.
 * Other people (`others`) are only used when the parser preset allows them.
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
    if (!parserPreset?.allowOthers) vars.others = '';

    const lines = [];
    for (const line of templateFor(String(settings.promptTemplate || ''), !!vars.others).split('\n')) {
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
