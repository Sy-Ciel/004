/**
 * 漫画模式 (MOSS-Image): a floor drawn as one comic page. The parser writes the page in MOSS-Image's own JSON layout
 * format (field `layout`: a summary and items — panels, people, words — each with a box), only with the boxes as
 * percentages of the page. This checks it and turns it into the prompt, whose boxes are pixels around the canvas
 * centre ("abs_centralized", [y_min, x_min, y_max, x_max], see OpenMOSS's user guide), and fits such a prompt to
 * another canvas size. Pure functions, no imports.
 */

/** A hard limit that keeps the prompt well within what MOSS-Image reads (about 4K tokens). */
const MAX_ITEMS = 40;

const TEXT_CAPTION = 'Clean comic text in a white speech bubble.';
const PANEL_WORD = /\bpanel\b/i;

/** Whether a parser preset draws comic pages (漫画模式 and copies of it). */
export function isComicPreset(preset) {
    return preset?.comic === true;
}

/** Panels per page at most (1–6) of a comic preset. */
export function comicPanels(preset) {
    return Math.min(6, Math.max(1, Math.trunc(Number(preset?.panels)) || 4));
}

/** Pages per floor at most (1–4) of a comic preset; the parser decides how many (presets from before: 3). */
export function comicPages(preset) {
    return Math.min(4, Math.max(1, Math.trunc(Number(preset?.pages)) || 3));
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

/** MOSS-Image's three item labels, from the names models also use for them. */
const LABELS = {
    object: 'object', panel: 'object', frame: 'object', scene: 'object', background: 'object', prop: 'object',
    character: 'character', person: 'character', people: 'character', human: 'character', figure: 'character',
    text: 'text', dialogue: 'text', speech: 'text', bubble: 'text', narration: 'text', sfx: 'text', title: 'text',
};

function labelOf(item) {
    const name = String(item.label ?? item.type ?? '').trim().toLowerCase();
    if (Object.hasOwn(LABELS, name)) return LABELS[name];
    return asWords(item.text) ? 'text' : 'object';
}

/** Four numbers as the parser wrote them (an array or { top, left, bottom, right }), or null. */
function rawBox(value) {
    const raw = Array.isArray(value)
        ? value
        : isObject(value) ? [value.top ?? value.y_min, value.left ?? value.x_min, value.bottom ?? value.y_max, value.right ?? value.x_max] : [];
    const numbers = raw.map(Number);
    return numbers.length === 4 && numbers.every(Number.isFinite) ? numbers : null;
}

/** [top, left, bottom, right] kept inside the page and in order; null when it has no size. */
function tidyBox(box) {
    let [top, left, bottom, right] = box.map(number => Math.min(100, Math.max(0, number)));
    if (bottom < top) [top, bottom] = [bottom, top];
    if (right < left) [left, right] = [right, left];
    return bottom - top >= 1 && right - left >= 1 ? [top, left, bottom, right] : null;
}

/**
 * A page's boxes as percent of the page, [top, left, bottom, right]. Asked for in percent, they may come as
 * fractions of 1, per mille (0–1000), pixels from the top-left corner or MOSS-Image's own pixels around the centre
 * (copied from its examples); all boxes of a page are read the same way, judged by their range.
 */
function percentBoxes(boxes) {
    const values = boxes.flat();
    const min = Math.min(...values);
    const max = Math.max(...values);
    const ys = boxes.flatMap(box => [box[0], box[2]]);
    const xs = boxes.flatMap(box => [box[1], box[3]]);
    let convert = box => box;
    if (min < 0 && -min >= max * 0.3) {
        // Around the centre: the page spans as far as its boxes reach. (A slightly negative number in percent is a
        // slip, kept inside the page below.)
        const halfY = Math.max(...ys.map(Math.abs)) || 1;
        const halfX = Math.max(...xs.map(Math.abs)) || 1;
        convert = box => box.map((value, index) => (value / (index % 2 ? halfX : halfY) + 1) * 50);
    } else if (max <= 1) {
        convert = box => box.map(value => value * 100);
    } else if (max > 100 && max <= 1000) {
        convert = box => box.map(value => value / 10);
    } else if (max > 1000) {
        const height = Math.max(...ys) || 1;
        const width = Math.max(...xs) || 1;
        convert = box => box.map((value, index) => value / (index % 2 ? width : height) * 100);
    }
    return boxes.map(box => tidyBox(convert(box)));
}

/** v1.45's page, panel by panel (panels with characters and texts), as a layout of items. */
function flattenPanels(value) {
    const panels = list(value.panels);
    const single = panels.length === 1;
    const items = [];
    for (const panel of panels) {
        const box = panel.box ?? panel.bbox;
        if (!single) items.push({ label: 'object', caption: panel.caption ?? panel.description, bbox: box, panel: true });
        for (const person of list(panel.characters ?? panel.people)) items.push({ label: 'character', caption: person.caption ?? person.description, bbox: person.box ?? person.bbox ?? box });
        for (const words of list(panel.texts ?? panel.text)) items.push({ label: 'text', caption: words.caption ?? words.description, text: words.text ?? words.content, bbox: words.box ?? words.bbox ?? box });
    }
    const caption = [asText(value.caption ?? value.summary), single ? asText(panels[0].caption ?? panels[0].description) : ''].filter(Boolean).join(' ');
    return { summary: { canvas: single ? 'single' : 'multi_panel', caption }, items };
}

/**
 * The parser's comic page, checked: { caption, canvas: 'single' | 'multi_panel', items: [{ label, caption, text?,
 * box, panel? }] } with boxes in percent of the page, or null when it has no usable item. Read from MOSS-Image's
 * layout format (summary + items; the parser was asked for it) or v1.45's panel by panel one. On a page of several
 * panels, an object that says it is a panel or takes up a good part of the page is one. An item without a usable
 * box takes the panel before it (items go panel by panel), else the whole page.
 */
export function readComicPage(value) {
    if (!isObject(value)) return null;
    const source = Array.isArray(value.panels) && !Array.isArray(value.items) ? flattenPanels(value) : value;
    const summary = isObject(source.summary) ? source.summary : {};
    const entries = list(source.items).slice(0, MAX_ITEMS).map(item => {
        const label = labelOf(item);
        return {
            label,
            caption: asText(item.caption ?? item.description),
            text: label === 'text' ? asWords(item.text ?? item.content) : '',
            raw: rawBox(item.bbox ?? item.box),
            marked: item.panel === true,
        };
    }).filter(item => (item.label === 'text' ? item.text : item.caption));
    if (!entries.length) return null;
    const boxed = entries.filter(item => item.raw);
    if (boxed.length) percentBoxes(boxed.map(item => item.raw)).forEach((box, index) => { boxed[index].box = box; });
    const area = box => (box ? (box[2] - box[0]) * (box[3] - box[1]) / 100 : 0);
    const panelLike = item => item.label === 'object' && (item.marked || PANEL_WORD.test(item.caption) || area(item.box) >= 8);
    // The canvas as declared, unless the items name several panels.
    const declared = String(summary.canvas ?? source.canvas ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const named = entries.filter(item => item.label === 'object' && (item.marked || PANEL_WORD.test(item.caption))).length;
    const canvas = named > 1 || (declared !== 'single' && (declared === 'multi_panel' || entries.filter(panelLike).length > 1)) ? 'multi_panel' : 'single';
    let panelBox = [0, 0, 100, 100];
    const items = entries.map(item => {
        const panel = canvas === 'multi_panel' && panelLike(item);
        const box = item.box ?? [...panelBox];
        if (panel) panelBox = box;
        return {
            label: item.label,
            caption: item.caption || (item.label === 'text' ? TEXT_CAPTION : ''),
            ...(item.label === 'text' ? { text: item.text } : {}),
            box,
            ...(panel ? { panel: true } : {}),
        };
    });
    return { caption: asText(summary.caption ?? source.caption), canvas, items };
}

/** How many panels a page has (v1.45's pages list them; a layout names them "… panel"). */
export function comicPanelCount(page) {
    if (Array.isArray(page?.panels)) return page.panels.length;
    if (page?.canvas === 'single') return 1;
    return (page?.items ?? []).filter(item => item.panel).length;
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

/**
 * MOSS-Image's JSON layout of a page on a width × height canvas, as OpenMOSS's examples and the LoRA card write it:
 * the summary (`caption` is its description, the style and trigger words included) and the items in the parser's
 * order, boxes in pixels around the canvas centre. A panel that does not say where it is gets its place in front
 * ("Top-left vertical panel: …").
 */
export function comicLayout(page, { width, height, caption }) {
    const canvas = page.canvas === 'single' ? 'single' : 'multi_panel';
    const pixels = ([top, left, bottom, right]) => [
        (top / 100 - 0.5) * height,
        (left / 100 - 0.5) * width,
        (bottom / 100 - 0.5) * height,
        (right / 100 - 0.5) * width,
    ].map(Math.round);
    return {
        summary: { meta: ['comic', canvas, 'digital_painting'], canvas, caption },
        items: page.items.map(item => ({
            label: item.label,
            caption: item.panel && !PANEL_WORD.test(item.caption) ? `${panelName(item.box, width, height)}: ${item.caption}` : item.caption,
            ...(item.label === 'text' ? { text: item.text } : {}),
            bbox: pixels(item.box),
        })),
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
