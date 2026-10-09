import { PARSED_FIELDS } from './constants.js';
import { BUILTIN_PARSER_PRESETS, OUTPUT_RULES_AI, OUTPUT_RULES_FIXED } from './parserPresetDefaults.js';
import { getSettings, resolveMacros } from './utils.js';

/** Chinese names accepted in a preset's "fixed content" lines. */
const FIELD_ALIASES = {
    服装: 'outfit', 衣服: 'outfit', 穿着: 'outfit',
    动作: 'action', 姿势: 'action',
    表情: 'expression',
    神态: 'demeanor', 情绪: 'demeanor',
    场景: 'scene', 背景: 'scene',
    镜头: 'camera', 构图: 'camera',
    光线: 'lighting', 灯光: 'lighting',
};

export function promptMode() {
    return getSettings().promptMode === 'ai' ? 'ai' : 'fixed';
}

export function outputRules(mode) {
    return mode === 'ai' ? OUTPUT_RULES_AI : OUTPUT_RULES_FIXED;
}

export function builtinParserPreset(id) {
    return BUILTIN_PARSER_PRESETS.find(preset => preset.id === id) ?? null;
}

export function findParserPreset(idOrName) {
    const presets = getSettings().parserPresets;
    const wanted = String(idOrName ?? '').trim().toLowerCase();
    if (!wanted) return null;
    return presets.find(preset => preset.id === idOrName)
        ?? presets.find(preset => String(preset.name).toLowerCase() === wanted)
        ?? presets.find(preset => String(preset.name).toLowerCase().includes(wanted))
        ?? null;
}

/** The selected preset, falling back to the built-in story preset. */
export function activeParserPreset() {
    const settings = getSettings();
    return settings.parserPresets.find(preset => preset.id === settings.parserPresetId)
        ?? settings.parserPresets.find(preset => preset.id === 'story')
        ?? structuredClone(BUILTIN_PARSER_PRESETS[0]);
}

/**
 * Reads "field: value" lines (outfit/action/… or 服装/动作/…). Unknown names are ignored.
 * @returns {Record<string, string>}
 */
export function parseFixedFields(text) {
    const fields = {};
    for (const line of String(text ?? '').split('\n')) {
        const match = line.match(/^\s*([A-Za-z一-龥]+)\s*[:：]\s*(.+?)\s*$/);
        if (!match) continue;
        const name = match[1];
        const field = PARSED_FIELDS.includes(name.toLowerCase()) ? name.toLowerCase() : FIELD_ALIASES[name];
        if (field) fields[field] = resolveMacros(match[2]);
    }
    return fields;
}

/** Resolution override of a preset, or null to use the global ComfyUI resolution. */
export function presetResolution(preset) {
    const width = Number(preset?.width) || 0;
    const height = Number(preset?.height) || 0;
    return width >= 256 && height >= 256 ? { width, height } : null;
}
