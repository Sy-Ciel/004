/**
 * 漫画模式 (MOSS-Image): a floor drawn as one comic page. The parser lays the page out (field `page`): panels in
 * reading order, the people in each panel and the story's lines in speech bubbles, every box as percentages of the
 * page. This turns it into MOSS-Image's JSON layout prompt, whose boxes are pixels around the canvas centre
 * ("abs_centralized", [y_min, x_min, y_max, x_max], see OpenMOSS's user guide), and fits such a prompt to another
 * canvas size. Pure functions, no imports.
 */

/** Hard limits that keep the prompt well within what MOSS-Image reads (about 4K tokens). */
const MAX_PANELS = 8;
const MAX_CHARACTERS = 3;
const MAX_TEXTS = 3;

/** Whether a parser preset draws comic pages (漫画模式 and copies of it). */
export function isComicPreset(preset) {
    return preset?.comic === true;
}

/** Panels per page at most (1–6) of a comic preset. */
export function comicPanels(preset) {
    return Math.min(6, Math.max(1, Math.trunc(Number(preset?.panels)) || 4));
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asText(value) {
    return typeof value === 'string' || typeof value === 'number' ? String(value).replace(/\s+/g, ' ').trim() : '';
}

/** Words to draw: line breaks kept (written "\n" by a model that escaped twice too). */
function asWords(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    return String(value).replace(/\\n/g, '\n').split('\n').map(line => line.trim()).filter(Boolean).join('\n');
}

function list(value) {
    return Array.isArray(value) ? value.filter(isObject) : [];
}

/**
 * A box as the parser wrote it, as [top, left, bottom, right] in percent of the page (fractions of 1 are read as
 * such), kept inside the page; null when it is not four numbers or has no size.
 */
export function readBox(value) {
    const raw = Array.isArray(value)
        ? value
        : isObject(value) ? [value.top ?? value.y_min, value.left ?? value.x_min, value.bottom ?? value.y_max, value.right ?? value.x_max] : [];
    let numbers = raw.map(Number);
    if (numbers.length !== 4 || numbers.some(number => !Number.isFinite(number))) return null;
    if (numbers.every(number => number >= 0 && number <= 1)) numbers = numbers.map(number => number * 100);
    let [top, left, bottom, right] = numbers.map(number => Math.min(100, Math.max(0, number)));
    if (bottom < top) [top, bottom] = [bottom, top];
    if (right < left) [left, right] = [right, left];
    return bottom - top >= 1 && right - left >= 1 ? [top, left, bottom, right] : null;
}

/**
 * The parser's page, checked: { caption, panels: [{ box, caption, characters: [{ box, caption }], texts: [{ box,
 * text, caption }] }] }, or null when it has no panel. When a panel has no usable box, the page is laid out again as
 * full-width rows (everything in a panel then takes the panel's box); a person or text without one takes its panel's.
 */
export function readComicPage(value) {
    if (!isObject(value)) return null;
    const panels = [];
    for (const raw of list(value.panels).slice(0, MAX_PANELS)) {
        const panel = {
            box: readBox(raw.box ?? raw.bbox),
            caption: asText(raw.caption ?? raw.description),
            characters: list(raw.characters ?? raw.people)
                .map(item => ({ box: readBox(item.box ?? item.bbox), caption: asText(item.caption ?? item.description) }))
                .filter(item => item.caption)
                .slice(0, MAX_CHARACTERS),
            texts: list(raw.texts ?? raw.text)
                .map(item => ({ box: readBox(item.box ?? item.bbox), text: asWords(item.text ?? item.content), caption: asText(item.caption ?? item.description) }))
                .filter(item => item.text)
                .slice(0, MAX_TEXTS),
        };
        if (panel.caption || panel.characters.length) panels.push(panel);
    }
    if (!panels.length) return null;
    const relaid = panels.some(panel => !panel.box);
    panels.forEach((panel, index) => {
        if (relaid) panel.box = [index * 100 / panels.length, 0, (index + 1) * 100 / panels.length, 100];
        for (const item of [...panel.characters, ...panel.texts]) {
            if (relaid || !item.box) item.box = [...panel.box];
        }
    });
    return { caption: asText(value.caption ?? value.summary), panels };
}

/** "Top-left vertical panel" from where a panel is on the page and its shape on the canvas. */
function panelName([top, left, bottom, right], width, height) {
    const middleY = (top + bottom) / 2;
    const middleX = (left + right) / 2;
    const row = middleY < 34 ? 'top' : middleY > 66 ? 'bottom' : 'middle';
    const column = right - left > 80 ? '' : middleX < 40 ? 'left' : middleX > 60 ? 'right' : 'center';
    const across = (right - left) * width;
    const down = (bottom - top) * height;
    const shape = across > down * 1.3 ? ' horizontal' : down > across * 1.3 ? ' vertical' : '';
    const where = column ? `${row}-${column}` : row;
    return `${where[0].toUpperCase()}${where.slice(1)}${shape} panel`;
}

/** A panel's caption, saying where it is ("Top-left vertical panel: …") unless it already does. */
function panelCaption(panel, width, height) {
    if (/^[^:：.]{0,40}\bpanel\b[^:：.]{0,20}[:：]/i.test(panel.caption)) return panel.caption;
    return `${panelName(panel.box, width, height)}: ${panel.caption}`;
}

/**
 * MOSS-Image's JSON layout of a page on a width × height canvas, as OpenMOSS's examples write it: the summary
 * (`caption` is its description, the style and trigger words included), then per panel an object item, its people
 * as character items and its words as text items. A one-panel page is a single canvas: there the panel has no item
 * of its own (its description goes into the summary, see prompt.js).
 */
export function comicLayout(page, { width, height, caption }) {
    const single = page.panels.length === 1;
    const canvas = single ? 'single' : 'multi_panel';
    const pixels = ([top, left, bottom, right]) => [
        (top / 100 - 0.5) * height,
        (left / 100 - 0.5) * width,
        (bottom / 100 - 0.5) * height,
        (right / 100 - 0.5) * width,
    ].map(Math.round);
    const items = [];
    for (const panel of page.panels) {
        if (!single && panel.caption) items.push({ label: 'object', caption: panelCaption(panel, width, height), bbox: pixels(panel.box) });
        for (const person of panel.characters) items.push({ label: 'character', caption: person.caption, bbox: pixels(person.box) });
        for (const words of panel.texts) {
            items.push({ label: 'text', caption: words.caption || 'Clean comic text in a white speech bubble.', text: words.text, bbox: pixels(words.box) });
        }
    }
    return {
        summary: { meta: ['comic', canvas, 'digital_painting'], canvas, caption },
        items,
        bbox_coord_space: 'abs_centralized',
        bbox_format: 'yxyx',
    };
}

/** A layout as prompt text, indented like OpenMOSS's and the LoRA card's examples. */
export function layoutText(layout) {
    return JSON.stringify(layout, null, 2);
}

/**
 * A prompt that is a MOSS-Image JSON layout, after lines of its own (the trigger tags): { head, layout }, or null
 * for any other prompt.
 */
export function readLayoutPrompt(prompt) {
    const source = String(prompt ?? '');
    const start = source.indexOf('{');
    if (start < 0 || !source.trimEnd().endsWith('}')) return null;
    try {
        const layout = JSON.parse(source.slice(start));
        return isObject(layout) && Array.isArray(layout.items) && isObject(layout.summary) ? { head: source.slice(0, start), layout } : null;
    } catch {
        return null;
    }
}

/**
 * A layout prompt drawn on another canvas: its pixel boxes scaled from the size they were written for (`from`) to
 * `to`. Any other prompt, or the same size, is returned as it is.
 */
export function fitLayout(prompt, from, to) {
    const sizes = [from?.width, from?.height, to?.width, to?.height].map(Number);
    if (sizes.some(size => !(size > 0)) || (sizes[0] === sizes[2] && sizes[1] === sizes[3])) return prompt;
    const found = readLayoutPrompt(prompt);
    if (!found || found.layout.bbox_coord_space !== 'abs_centralized') return prompt;
    const scaleY = sizes[3] / sizes[1];
    const scaleX = sizes[2] / sizes[0];
    const yFirst = found.layout.bbox_format !== 'xyxy';
    for (const item of found.layout.items) {
        if (!Array.isArray(item?.bbox) || item.bbox.length !== 4 || !item.bbox.every(Number.isFinite)) continue;
        item.bbox = item.bbox.map((value, index) => Math.round(value * ((index % 2 === 0) === yFirst ? scaleY : scaleX)));
    }
    return `${found.head}${layoutText(found.layout)}`;
}
