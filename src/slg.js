/**
 * MOSS-Image's 跳层引导 (skip layer guidance): the layers the negative branch skips and the part of the sampling it
 * does so in, as ComfyUI's SkipLayerGuidanceDiTSimple node takes them (single_layers, start_percent, end_percent)
 * and as OpenMOSS's own app names them (skip layers, skip start, skip stop). ComfyUI's official template skips
 * layer 22 for the first half (0 → 0.5); OpenMOSS's app skips it all the way (0 → 1) and says 22, 24 and 26 all
 * help. Layers are counted from 0.
 */

/** The official ComfyUI template's values. */
export const SLG_DEFAULTS = { layers: '22', start: 0, end: 0.5 };

/** MOSS-Image's transformer has this many layers (0 … 41); a number past them names no layer. */
export const MOSS_LAYERS = 42;

/** The layer numbers of a 跳过的层 field: "22", "22, 24, 26", "22 24" or a range "22-26"; each once, as written. */
export function slgLayerList(text) {
    const layers = [];
    for (const [, from, to] of String(text ?? '').matchAll(/(\d{1,3})(?:\s*[-‐‑‒–—－~～]\s*(\d{1,3}))?/g)) {
        const first = Number(from);
        const last = to === undefined ? first : Number(to);
        for (let layer = Math.min(first, last); layer <= Math.max(first, last); layer++) {
            if (!layers.includes(layer)) layers.push(layer);
        }
    }
    return layers;
}

/** A part of the sampling between 0 and 1; `fallback` for a field left empty. */
function part(value, fallback) {
    const number = Number(value);
    return String(value ?? '').trim() === '' || !Number.isFinite(number) ? fallback : Math.min(1, Math.max(0, number));
}

/**
 * 跳层引导 as it is used: the layers (the default one when none is filled in) and where in the sampling it starts
 * and ends.
 * @returns {{ layers: number[], start: number, end: number, noLayers: boolean }}
 */
export function slgSettings(comfy) {
    const typed = slgLayerList(comfy?.slgLayers);
    return {
        layers: typed.length ? typed : slgLayerList(SLG_DEFAULTS.layers),
        start: part(comfy?.slgStart, SLG_DEFAULTS.start),
        end: part(comfy?.slgEnd, SLG_DEFAULTS.end),
        noLayers: !typed.length,
    };
}

const percent = value => `${Math.round(value * 100)}%`;

/** What these settings do, in a line: 「跳过第 22 层 · 采样进度 0% – 50%」. */
export function describeSlg(comfy) {
    const { layers, start, end } = slgSettings(comfy);
    return `跳过第 ${layers.join('、')} 层 · 采样进度 ${percent(start)} – ${percent(end)}`;
}

/** What is off about these settings (nothing when they are fine), for the settings panel. */
export function slgWarnings(comfy) {
    const { layers, start, end, noLayers } = slgSettings(comfy);
    const notes = [];
    if (noLayers) notes.push(`没有填层号，按默认的第 ${SLG_DEFAULTS.layers} 层`);
    const beyond = layers.filter(layer => layer >= MOSS_LAYERS);
    if (beyond.length) notes.push(`MOSS-Image 只有 ${MOSS_LAYERS} 层（0–${MOSS_LAYERS - 1}），第 ${beyond.join('、')} 层不存在，不起作用`);
    if (end <= start) notes.push('「结束」要大于「开始」，现在这样跳层不起作用');
    return notes;
}
