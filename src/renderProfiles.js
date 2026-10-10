/**
 * Render profiles: named sets of ComfyUI model / LoRA / sampling settings that a character preset can use,
 * so each character (and each user persona bound to a preset) is drawn with its own model and LoRA.
 * Every field is an override: empty (or 0) keeps the default from the ComfyUI section.
 */
import { LORA_NONE, makeId } from './constants.js';
import { getSettings } from './utils.js';

/**
 * @typedef {Object} RenderProfile
 * @property {string} id
 * @property {string} name
 * @property {string} unet
 * @property {string} clip
 * @property {string} vae
 * @property {string} lora '' = default LoRA, LORA_NONE = no style LoRA
 * @property {number} loraStrength Used when the profile picks its own LoRA
 * @property {number} steps 0 = default
 * @property {number} cfg 0 = default
 * @property {string} sampler
 * @property {string} scheduler
 * @property {string} workflow API-format JSON; empty = default workflow
 */

/** @returns {RenderProfile} */
export function newRenderProfile(base = {}) {
    return {
        id: makeId(),
        name: '新渲染配置',
        unet: '',
        clip: '',
        vae: '',
        lora: '',
        loraStrength: 0.8,
        steps: 0,
        cfg: 0,
        sampler: '',
        scheduler: '',
        workflow: '',
        ...base,
    };
}

/** Builds a clean profile from imported data, keeping its id so presets that use it stay linked. */
export function sanitizeRenderProfile(raw) {
    const profile = newRenderProfile();
    for (const key of Object.keys(profile)) {
        if (raw?.[key] === undefined || (key === 'id' && raw[key] === '')) continue;
        profile[key] = typeof profile[key] === 'number' ? Number(raw[key]) || 0 : String(raw[key]);
    }
    return profile;
}

export function findRenderProfile(id) {
    if (!id) return null;
    return getSettings().renderProfiles.find(profile => profile.id === id) ?? null;
}

/** The render profile a character preset uses, or null for the defaults. */
export function renderProfileFor(preset) {
    return findRenderProfile(preset?.renderProfileId);
}

/** Character presets that use a render profile. */
export function presetsUsing(profileId) {
    return getSettings().presets.filter(preset => preset.renderProfileId === profileId);
}

/** The ComfyUI settings with a render profile's overrides applied. */
export function effectiveComfy(profile) {
    const { comfy } = getSettings();
    if (!profile) return comfy;
    const text = (value, fallback) => (String(value ?? '').trim() ? String(value).trim() : fallback);
    const positive = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback);
    const ownLora = String(profile.lora ?? '').trim();
    const ownWorkflow = String(profile.workflow ?? '').trim();
    return {
        ...comfy,
        unet: text(profile.unet, comfy.unet),
        clip: text(profile.clip, comfy.clip),
        vae: text(profile.vae, comfy.vae),
        lora: ownLora === LORA_NONE ? '' : ownLora || comfy.lora,
        loraStrength: ownLora && ownLora !== LORA_NONE ? Number(profile.loraStrength) || 0 : comfy.loraStrength,
        steps: positive(profile.steps, comfy.steps),
        cfg: positive(profile.cfg, comfy.cfg),
        sampler: text(profile.sampler, comfy.sampler),
        scheduler: text(profile.scheduler, comfy.scheduler),
        workflowSource: ownWorkflow ? 'custom' : comfy.workflowSource,
        workflow: ownWorkflow ? profile.workflow : comfy.workflow,
    };
}
