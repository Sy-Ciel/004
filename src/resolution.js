/**
 * Picture size. Two ways per mode (comfy.sizeMode):
 * - "fixed": width × height as set (the resolution list fills them in);
 * - "selector": an aspect ratio and a pixel count, like ComfyUI's Resolution Selector node, so the parser model
 *   can pick a ratio per picture (comfy.parserAspect) while the size stays about the same.
 */

/** The ratios offered (the same as ComfyUI's Resolution Selector). */
export const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'];

const MULTIPLE = 16;

function ratioParts(ratio) {
    const match = String(ratio ?? '').match(/(\d+(?:\.\d+)?)\s*[:：xX×/]\s*(\d+(?:\.\d+)?)/);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    return width > 0 && height > 0 ? [width, height] : null;
}

/**
 * A ratio written by a person or the parser ("2:3", "2 x 3", "16/9", "portrait 2:3") as the closest offered
 * ratio, or '' when it is not a ratio or far outside the offered ones.
 */
export function parseAspect(text) {
    const parts = ratioParts(text);
    if (!parts) return '';
    const wanted = Math.log(parts[0] / parts[1]);
    let best = '';
    let distance = Infinity;
    for (const ratio of ASPECT_RATIOS) {
        const [w, h] = ratioParts(ratio);
        const d = Math.abs(Math.log(w / h) - wanted);
        if (d < distance) {
            best = ratio;
            distance = d;
        }
    }
    // More than about 1.5× off the nearest offered ratio: not something to draw.
    return distance <= Math.log(1.5) ? best : '';
}

/**
 * Width and height for a ratio and a pixel count, as ComfyUI's Resolution Selector computes them:
 * total = MP × 1024², each side rounded to a multiple of 16. 2:3 at 1 MP → 832 × 1248.
 */
export function selectorSize(ratio, megapixels) {
    const [rw, rh] = ratioParts(ratio) ?? [1, 1];
    const mp = Number(megapixels) > 0 ? Number(megapixels) : 1;
    const unit = Math.sqrt((mp * 1024 * 1024) / (rw * rh));
    const side = value => Math.max(MULTIPLE, Math.round((value * unit) / MULTIPLE) * MULTIPLE);
    return { width: side(rw), height: side(rh) };
}

/** Whether the parser picks the ratio: selector mode with the switch on. */
export function parserPicksAspect(comfy) {
    return comfy?.sizeMode === 'selector' && !!comfy.parserAspect;
}

/**
 * The size from the ComfyUI settings (render profile applied), before per-picture overrides.
 * @param {object} comfy
 * @param {string} [parsedAspect] The ratio the parser chose for this picture
 * @returns {{ width: number, height: number, aspect: string, fromParser: boolean }}
 */
export function baseSize(comfy, parsedAspect = '') {
    if (comfy?.sizeMode !== 'selector') return { width: Number(comfy?.width), height: Number(comfy?.height), aspect: '', fromParser: false };
    const fromParser = parserPicksAspect(comfy) ? parseAspect(parsedAspect) : '';
    const aspect = fromParser || parseAspect(comfy.aspectRatio) || '1:1';
    return { ...selectorSize(aspect, comfy.megapixels), aspect, fromParser: !!fromParser };
}
