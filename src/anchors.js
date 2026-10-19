/**
 * Pictures inside the text. 多张图: the parser copies the opening words of every part of a floor (`start`), and
 * each part's picture is put where that part begins or ends. 「图片插在正文中间」: the parser copies the sentence
 * each picture fits best after (`place`), and the picture goes right after that line.
 *
 * The quote is what the parser read (plain text, markdown symbols and all); the chat shows rendered HTML. Both are
 * compared by their letters and digits only, so punctuation, spacing, quotes and markdown do not matter.
 */

/** Letters and digits only, lower case: what a quote and a text are compared by. */
export function comparable(text) {
    return (String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]/gu) ?? []).join('');
}

/** Quotes are compared by their first characters; a model may copy the opening right and drift after it. */
const QUOTE_MAX = 24;
const QUOTE_MIN = 6;

/**
 * Where a quote starts in comparable text, at or after `from`: the longest opening of the quote that occurs
 * (at least a few characters). -1 when it is not there.
 */
export function findQuote(text, quote, from = 0) {
    const wanted = comparable(quote);
    if (wanted.length < 4) return -1;
    // The opening first; then a little further in, for an opening the shown text changed (a label a display
    // rule added, a word the model left out …).
    for (const skip of [0, 4, 8]) {
        const part = wanted.slice(skip, skip + QUOTE_MAX);
        if (part.length < Math.min(QUOTE_MIN, wanted.length)) break;
        for (let length = part.length; length >= Math.min(QUOTE_MIN, part.length); length--) {
            const index = text.indexOf(part.slice(0, length), from);
            if (index >= 0) return Math.max(from, index - skip);
        }
    }
    return -1;
}

/** Where each quote starts, in order (each after the one before), or null when one of them is missing. */
export function locateQuotes(text, quotes) {
    const found = [];
    let from = 0;
    for (const quote of quotes) {
        const index = findQuote(text, quote, from);
        if (index < 0) return null;
        found.push(index);
        from = index + 1;
    }
    return found;
}

/** Inside these the text is not the story (code pages, the status bar) or is ours. */
const SKIP = 'pre, code, script, style, iframe, details, .ctp-inserted, .ctp-wrap';
const BLOCKS = new Set(['P', 'DIV', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'PRE', 'HR', 'SECTION', 'ARTICLE', 'DETAILS', 'FIGURE', 'DL', 'CENTER']);

/** The shown text of an element as comparable characters, with the text node and offset each one comes from. */
function textMap(root) {
    let text = '';
    const positions = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const skipped = node.parentElement?.closest(SKIP);
        if (skipped && skipped !== root && root.contains(skipped)) continue;
        let offset = 0;
        for (const char of node.nodeValue) {
            if (/[\p{L}\p{N}]/u.test(char)) {
                const lower = char.toLowerCase();
                text += lower;
                // One entry per UTF-16 unit, so indexes into `text` index `positions` too.
                for (let unit = 0; unit < lower.length; unit++) positions.push({ node, offset });
            }
            offset += char.length;
        }
    }
    return { text, positions };
}

/**
 * Where pictures go in the shown story text, one spot per anchor, never none: by the anchor's words when they are
 * found (in order when they all are, else each anywhere), else at the anchor's share of the story (`at`, from the
 * paragraph the parser named), else at `even` (pictures spread evenly).
 * side 'after': the picture follows that point's line; 'before': it comes before that point's line.
 * @param {{ quote?: string, at?: number|null, even: number, side: 'after'|'before' }[]} anchors
 * @param {{ first?: string, last?: string }} [bounds] The story's first and last words (shares are of that stretch)
 * @returns {{ node: Text, offset: number, found: boolean }[] | null} null when there is no story text to place in
 */
export function placeAnchors(root, anchors, bounds = {}) {
    const { text, positions } = textMap(root);
    if (!positions.length) return null;
    const quotes = anchors.map(anchor => anchor.quote || '');
    let found = quotes.every(Boolean) ? locateQuotes(text, quotes) : null;
    if (!found) found = quotes.map(quote => (quote ? findQuote(text, quote) : -1));
    // The story's own stretch of the shown text, when its first and last words are found: spots without words
    // of their own go inside it, not among code pages or panels around it.
    let first = 0;
    let last = positions.length - 1;
    const start = bounds.first ? findQuote(text, bounds.first) : -1;
    if (start >= 0) first = start;
    const end = bounds.last ? findQuote(text, bounds.last, first) : -1;
    if (end >= 0) last = Math.min(last, end + comparable(bounds.last).length - 1);
    const size = last - first + 1;
    return anchors.map((anchor, index) => {
        if (found[index] >= 0) return { ...positions[found[index]], found: true };
        const share = Math.min(1, Math.max(0, Number.isFinite(anchor.at) ? anchor.at : anchor.even));
        // 'after': the last character of that share of the story; 'before': the first one past it.
        const at = first + (anchor.side === 'after' ? Math.round(share * size) - 1 : Math.round(share * size));
        return { ...positions[Math.min(last, Math.max(first, at))], found: false };
    });
}

/** The top on screen (viewport y) of the line a position from placeAnchors is on. */
export function positionTop({ node, offset }) {
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, Math.min(node.nodeValue.length, offset + 1));
    const box = range.getBoundingClientRect();
    return box.height ? box.top : node.parentElement?.getBoundingClientRect().top ?? 0;
}

/** Puts `figure` at the start of the line `node` is on: after a line break or block before it, else before its block. */
function insertAtLine(root, node, figure) {
    let top = node;
    while (top.parentNode && top.parentNode !== root) top = top.parentNode;
    if (top.parentNode !== root) return false;
    if (top !== node) {
        const walker = document.createTreeWalker(top, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
        walker.currentNode = node;
        for (let previous = walker.previousNode(); previous; previous = walker.previousNode()) {
            if (previous.contains(node)) continue;
            if (previous.nodeName === 'BR' || (previous.nodeType === Node.ELEMENT_NODE && BLOCKS.has(previous.nodeName))) {
                previous.after(figure);
                return true;
            }
        }
        if (BLOCKS.has(top.nodeName)) {
            top.before(figure);
            return true;
        }
    }
    // Text or an inline element straight in the message: the line starts after the last break or block before it.
    let previous = top.previousSibling;
    while (previous && previous.nodeName !== 'BR' && !(previous.nodeType === Node.ELEMENT_NODE && BLOCKS.has(previous.nodeName))) {
        previous = previous.previousSibling;
    }
    if (previous) previous.after(figure);
    else root.prepend(figure);
    return true;
}

/** Puts `element` right after the line `node` is on: after the line break that ends it, else after its block. */
function insertAtLineEnd(root, node, element) {
    let top = node;
    while (top.parentNode && top.parentNode !== root) top = top.parentNode;
    if (top.parentNode !== root) return false;
    if (top !== node) {
        const walker = document.createTreeWalker(top, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
        walker.currentNode = node;
        for (let next = walker.nextNode(); next; next = walker.nextNode()) {
            if (next.nodeName === 'BR') {
                next.after(element);
                return true;
            }
            if (next.nodeType === Node.ELEMENT_NODE && BLOCKS.has(next.nodeName)) {
                next.before(element);
                return true;
            }
        }
        if (BLOCKS.has(top.nodeName)) {
            top.after(element);
            return true;
        }
    }
    // Text or an inline element straight in the message: the line ends at the next break or block.
    let next = top.nextSibling;
    while (next && next.nodeName !== 'BR' && !(next.nodeType === Node.ELEMENT_NODE && BLOCKS.has(next.nodeName))) {
        next = next.nextSibling;
    }
    if (!next) root.append(element);
    else if (next.nodeName === 'BR') next.after(element);
    else next.before(element);
    return true;
}

/** Inserts `element` right after the line the text node `node` (from placeAnchors) is on. */
export function insertAfterLine(root, node, element) {
    return root.contains(node) && insertAtLineEnd(root, node, element);
}

/** Inserts `figure` at the start of the line the text node `node` (from placeAnchors) is on. */
export function insertBeforeLine(root, node, figure) {
    return root.contains(node) && insertAtLine(root, node, figure);
}
