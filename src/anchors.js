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
    const wanted = comparable(quote).slice(0, QUOTE_MAX);
    if (wanted.length < 4) return -1;
    for (let length = wanted.length; length >= Math.min(QUOTE_MIN, wanted.length); length--) {
        const index = text.indexOf(wanted.slice(0, length), from);
        if (index >= 0) return index;
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

/** The shown text of an element as comparable characters, with the text node each one comes from. */
function textMap(root) {
    let text = '';
    const positions = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const skipped = node.parentElement?.closest(SKIP);
        if (skipped && skipped !== root && root.contains(skipped)) continue;
        for (const char of node.nodeValue) {
            if (!/[\p{L}\p{N}]/u.test(char)) continue;
            const lower = char.toLowerCase();
            text += lower;
            // One entry per UTF-16 unit, so indexes into `text` index `positions` too.
            for (let unit = 0; unit < lower.length; unit++) positions.push(node);
        }
    }
    return { text, positions };
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

/**
 * 「图片插在正文中间」: finds the sentences the parser chose for the pictures (`place`), in order when it can,
 * else each one anywhere (two pictures may follow the same sentence).
 * @returns {Node[] | null} The text node each sentence starts in, or null when one is not found
 */
export function findPlaces(root, quotes) {
    if (!quotes.length || quotes.some(quote => !quote)) return null;
    const { text, positions } = textMap(root);
    const found = locateQuotes(text, quotes) ?? quotes.map(quote => findQuote(text, quote));
    return found.every(index => index >= 0) ? found.map(index => positions[index]) : null;
}

/** Inserts `element` right after the line the text node `node` (from findPlaces) is on. */
export function insertAfterLine(root, node, element) {
    return root.contains(node) && insertAtLineEnd(root, node, element);
}

/**
 * Finds where the parts of a floor start in the shown text of `root`.
 * @param {string[]} quotes The opening words of the 2nd, 3rd … part
 * @returns {Node[] | null} The text node each part starts in, or null when one is not found
 */
export function findPartStarts(root, quotes) {
    if (!quotes.length || quotes.some(quote => !quote)) return null;
    const { text, positions } = textMap(root);
    const found = locateQuotes(text, quotes);
    return found ? found.map(index => positions[index]) : null;
}

/** Inserts `figure` at the start of the line the text node `node` (from findPartStarts) is on. */
export function insertBeforeLine(root, node, figure) {
    return root.contains(node) && insertAtLine(root, node, figure);
}
