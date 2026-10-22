/**
 * Pictures inside the text. 多张图: the parser names the paragraph every part of a floor begins with (`start`), and
 * each part's picture is put where that part begins or ends. 「图片插在正文中间」: the parser names the paragraph
 * each picture fits best after (`place`), and the picture goes right after it. Both are kept as the paragraph's
 * opening words and its share of the story.
 *
 * Pictures only go into the story (what is inside <game>…</game>, see storyParagraphs): its paragraphs are found
 * in the shown text one after another, and nothing outside the stretch they cover is used. The message text is
 * plain text (markdown symbols and all); the chat shows rendered HTML. Both are compared by their letters and
 * digits only, so punctuation, spacing, quotes and markdown do not matter.
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

/**
 * Where the closing words of `quote` end in comparable text, at or after `from` (the index of their last
 * character), or -1.
 */
function findQuoteEnd(text, quote, from = 0) {
    const wanted = comparable(quote);
    if (wanted.length < 4) return -1;
    // The closing words first; then a little before them, for an ending the shown text changed.
    for (const skip of [0, 4, 8]) {
        const end = wanted.length - skip;
        const part = wanted.slice(Math.max(0, end - QUOTE_MAX), end);
        if (part.length < Math.min(QUOTE_MIN, wanted.length)) break;
        for (let length = part.length; length >= Math.min(QUOTE_MIN, part.length); length--) {
            const piece = part.slice(part.length - length);
            const index = text.indexOf(piece, from);
            if (index >= 0) return index + piece.length - 1;
        }
    }
    return -1;
}

/**
 * Every place the opening words of `quote` stand in comparable text, matched as findQuote matches them. `full`:
 * the whole opening matched, not just a part of it (a weaker sign: an option line may quote a paragraph's start).
 */
function occurrences(text, quote) {
    const wanted = comparable(quote);
    if (wanted.length < 4) return [];
    for (const skip of [0, 4, 8]) {
        const part = wanted.slice(skip, skip + QUOTE_MAX);
        if (part.length < Math.min(QUOTE_MIN, wanted.length)) break;
        for (let length = part.length; length >= Math.min(QUOTE_MIN, part.length); length--) {
            const piece = part.slice(0, length);
            const full = skip === 0 && length === part.length;
            const found = [];
            for (let index = text.indexOf(piece); index >= 0 && found.length < 20; index = text.indexOf(piece, index + 1)) {
                found.push({ at: Math.max(0, index - skip), full });
            }
            if (found.length) return found;
        }
    }
    return [];
}

/**
 * Where each story paragraph starts in comparable text, -1 for one not found: the longest chain of the places its
 * paragraphs' words stand in, in story order and each not much further from the one before than the paragraphs in
 * between are long. So words that also stand somewhere else (a panel, a summary, a status bar), or that match
 * out of order, are not taken for the story. A chain without one whole opening matched is not trusted (the story
 * itself is not shown, only lines quoting it).
 */
function locateParagraphs(text, paragraphs) {
    const sizes = paragraphs.map(paragraph => comparable(paragraph).length);
    const better = (a, b) => !b || a.length > b.length || (a.length === b.length && a.full > b.full);
    const chains = [];
    let best = null;
    paragraphs.forEach((paragraph, index) => {
        chains[index] = occurrences(text, paragraph.slice(0, 40)).map(({ at, full }) => {
            const own = full ? 1 : 0;
            let chain = { length: 1, full: own, at, index, previous: null };
            let span = 0;
            for (let before = index - 1; before >= 0; before--) {
                span += sizes[before];
                for (const link of chains[before]) {
                    const longer = { length: link.length + 1, full: link.full + own, at, index, previous: link };
                    if (link.at < at && at - link.at <= 3 * span + 300 && better(longer, chain)) chain = longer;
                }
            }
            if (better(chain, best)) best = chain;
            return chain;
        });
    });
    const starts = paragraphs.map(() => -1);
    if (best?.full) for (let link = best; link; link = link.previous) starts[link.index] = link.at;
    return starts;
}

/** The last character of a paragraph found at `start`: its closing words, else its length, never past `limit`. */
function paragraphEnd(text, paragraph, start, limit) {
    const end = findQuoteEnd(text, paragraph, start);
    if (end >= start && end <= limit) return end;
    return Math.max(start, Math.min(limit, start + comparable(paragraph).length - 1));
}

/**
 * The story paragraph an anchor names (its opening words, as paragraphAnchor keeps them), among those found in the
 * shown text; of several with the same opening, the one nearest the anchor's share. -1 when none.
 */
function paragraphFor(paragraphs, starts, anchor) {
    const quote = comparable(anchor.quote);
    if (!quote) return -1;
    const sizes = paragraphs.map(paragraph => comparable(paragraph).length);
    const total = sizes.reduce((sum, size) => sum + size, 0) || 1;
    let best = -1;
    let distance = Infinity;
    let before = 0;
    paragraphs.forEach((paragraph, index) => {
        const share = (before + (anchor.side === 'after' ? sizes[index] : 0)) / total;
        before += sizes[index];
        if (starts[index] < 0 || comparable(paragraph.slice(0, 40)) !== quote) return;
        const off = Number.isFinite(anchor.at) ? Math.abs(share - anchor.at) : 0;
        if (off < distance) {
            best = index;
            distance = off;
        }
    });
    return best;
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
 * The shown text of a message as compared (letters and digits, without the pictures put in it): a placement made
 * for one text is not kept for another, e.g. when the text was the edit box while the message was being edited.
 */
export function shownText(root) {
    return textMap(root).text;
}

/**
 * Where pictures go in the shown story, one spot per anchor: in the story's stretch of the text (its paragraphs,
 * found one after another), at the paragraph the anchor names (after its end for 'after', at its start for
 * 'before'); else at the anchor's own words inside the stretch; else at its share of the story (`at`, from the
 * paragraph the parser named) or at `even` (pictures spread evenly). Never outside the story.
 * side 'after': the picture follows that point's line; 'before': it comes before that point's line.
 * @param {{ quote?: string, at?: number|null, even: number, side: 'after'|'before' }[]} anchors
 * @param {{ paragraphs?: string[], ending?: string, first?: string, last?: string }} [bounds] The story's paragraphs
 *   (storyParagraphs) and its last words when the pictures were made (storyEnding); without paragraphs, its first and
 *   last words (what the version keeps)
 * @returns {{ node: Text, offset: number, found: boolean }[] | null} null when the story is not in the shown text
 */
export function placeAnchors(root, anchors, bounds = {}) {
    const { text, positions } = textMap(root);
    if (!positions.length) return null;
    const paragraphs = (bounds.paragraphs ?? []).filter(paragraph => comparable(paragraph));
    // A story of only very short lines cannot be searched for: then by its first and last words, as before.
    if (paragraphs.some(paragraph => comparable(paragraph.slice(0, 40)).length >= 4)) return placeInStory(text, positions, anchors, paragraphs, bounds.ending);
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

/**
 * placeAnchors with the story's paragraphs: only the stretch of the text they are found in is used. `ending`: the
 * story's last words when the pictures were made; the stretch ends with that paragraph, so text added to the end of
 * the story later (a note a preset appends after the user's next message) does not pull pictures down.
 */
function placeInStory(text, positions, anchors, paragraphs, ending = '') {
    const starts = locateParagraphs(text, paragraphs);
    const found = starts.flatMap((at, index) => (at >= 0 ? [index] : []));
    // The story is not in the shown text (drawn in a frame, say): the pictures stay in the image block.
    if (!found.length) return null;
    const first = starts[found[0]];
    const end = comparable(ending);
    const original = end.length >= 4 ? found.filter(index => comparable(paragraphs[index]).endsWith(end)).at(-1) : undefined;
    const lastIndex = original ?? found.at(-1);
    const last = paragraphEnd(text, paragraphs[lastIndex], starts[lastIndex], positions.length - 1);
    // The end of a paragraph: before the next one found, else at the end of the story.
    const endOf = index => {
        const next = found.find(other => other > index);
        return paragraphEnd(text, paragraphs[index], starts[index], next === undefined ? last : starts[next] - 1);
    };
    const size = last - first + 1;
    return anchors.map(anchor => {
        const index = paragraphFor(paragraphs, starts, anchor);
        if (index >= 0) return { ...positions[anchor.side === 'after' ? endOf(index) : starts[index]], found: true };
        // Words of its own (a quote the parser copied before paragraph numbers): only inside the story.
        const quoted = anchor.quote ? findQuote(text, anchor.quote, first) : -1;
        if (quoted >= 0 && quoted <= last) return { ...positions[quoted], found: true };
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
