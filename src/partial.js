/**
 * 边解析边出图: follows a parser reply while it streams in, to tell which of its pictures are written out already — the
 * fields in front of the list of pictures (earlier_scenes with 多张图, a comic's pages) once the list begins, then each
 * part of the list once it is complete. Only the reply's structure is followed here (its JSON object, strings and
 * brackets, scanned once as the text grows); what the pieces say is read by readPartialReply in parser.js.
 */

/** The end of a <think> block of a model that thinks in its answer's text. */
const THINK_END = /<\/think(?:ing)?>/gi;

/** The next character after `from` that is not white space ('' when the text ends first). */
function nextChar(text, from) {
    for (let i = from; i < text.length; i++) {
        if (!/\s/.test(text[i])) return text[i];
    }
    return '';
}

export class ReplyScanner {
    /** @param {string[]} keys the names the list of pictures may have in the reply */
    constructor(keys) {
        this.keys = keys;
        this.reset();
    }

    /** Starts over, for a new reply (the parser was asked again). */
    reset() {
        this.text = '';
        /** The next character to scan. */
        this.at = 0;
        /** The reply object's { (-1 until it begins). */
        this.open = -1;
        this.depth = 0;
        /** Where the string being read began (-1: not in a string). */
        this.string = -1;
        /** The last string read: { start, end, depth } (a key when a colon follows). */
        this.last = null;
        /** The list's key was read: its value comes next. */
        this.expectList = false;
        this.key = '';
        /** Where the list's key begins: the fields before it are complete once the list begins. */
        this.keyAt = -1;
        /** The list's [, the { of the part being read, the complete parts ([start, end]) and the list's ]. */
        this.list = -1;
        this.item = -1;
        this.items = [];
        this.listEnd = -1;
        /** The reply object's } (-1 until it is closed). */
        this.close = -1;
        /** How many times something to draw changed: the list began, a part of it began or ended, the list or the object closed. */
        this.steps = 0;
    }

    /**
     * Reads the reply so far (all of it; only what is new is scanned).
     * @returns {boolean} whether something to draw may have changed since the last time
     */
    read(text) {
        if (text.length < this.text.length) this.reset();
        this.text = text;
        const before = this.steps;
        while (this.at < text.length && this.close < 0 && this.step(text)) {
            // one character (or <think> block) at a time
        }
        return this.steps !== before;
    }

    /** Scans one character, or a <think> block in front of the object; false when that has to wait for more text. */
    step(text) {
        const at = this.at;
        const char = text[at];
        if (this.open < 0) {
            if (char === '<') {
                const tag = text.slice(at, at + 6).toLowerCase();
                if (tag.length < 6 && '<think'.startsWith(tag)) return false;
                if (tag === '<think') {
                    THINK_END.lastIndex = at;
                    const end = THINK_END.exec(text);
                    if (!end) return false;
                    this.at = end.index + end[0].length;
                    return true;
                }
            }
            if (char === '{') {
                this.open = at;
                this.depth = 1;
            }
            this.at++;
            return true;
        }
        if (this.string >= 0) {
            if (char === '\\') {
                if (at + 1 >= text.length) return false;
                this.at += 2;
                return true;
            }
            if (char === '"') {
                // A quote ends the string only when JSON structure follows: one the model did not escape (他说"你好")
                // is part of the text, as parser.js mends such replies (fixStrings).
                const next = nextChar(text, at + 1);
                if (!next) return false;
                if (',:}]'.includes(next)) {
                    this.last = { start: this.string, end: at, depth: this.depth };
                    this.string = -1;
                }
            }
            this.at++;
            return true;
        }
        if (this.expectList && !/\s/.test(char)) {
            this.expectList = false;
            if (char === '[') {
                this.list = at;
                this.steps++;
            }
        }
        switch (char) {
            case '"':
                this.string = at;
                break;
            case ':':
                if (this.depth === 1 && this.list < 0 && this.last?.depth === 1 && !text.slice(this.last.end + 1, at).trim()) {
                    const name = text.slice(this.last.start + 1, this.last.end);
                    if (this.keys.includes(name)) {
                        this.key = name;
                        this.keyAt = this.last.start;
                        this.expectList = true;
                    }
                }
                break;
            case '{':
            case '[':
                this.depth++;
                if (char === '{' && this.list >= 0 && this.listEnd < 0 && this.depth === 3) {
                    // Another part begins: the one before it is not the last (漫画模式: an earlier page, not the end).
                    this.item = at;
                    this.steps++;
                }
                break;
            case '}':
            case ']':
                this.depth--;
                if (char === '}' && this.item >= 0 && this.depth === 2) {
                    this.items.push([this.item, at]);
                    this.item = -1;
                    this.steps++;
                }
                if (this.list >= 0 && this.listEnd < 0 && this.depth === 1) {
                    this.listEnd = at;
                    this.steps++;
                }
                if (this.depth <= 0) {
                    this.close = at;
                    this.steps++;
                }
                break;
        }
        this.at++;
        return true;
    }

    /**
     * The reply as far as it is written out: its whole object once it is closed; else, once the list has begun, the
     * fields in front of it (as an object of their own) and the list's complete parts. null before that.
     * @returns {{ whole?: string, head?: string, key?: string, parts?: string[], more: boolean, done: boolean } | null}
     *   more: another part of the list has begun after the last complete one; done: the list is closed
     */
    pieces() {
        if (this.close >= 0) return { whole: this.text.slice(this.open, this.close + 1), more: false, done: true };
        if (this.list < 0) return null;
        const last = this.items.at(-1);
        return {
            head: `${this.text.slice(this.open, this.keyAt).replace(/[\s,]*$/, '')}}`,
            key: this.key,
            parts: this.items.map(([start, end]) => this.text.slice(start, end + 1)),
            more: this.listEnd < 0 && (this.item >= 0 || (!!last && nextChar(this.text, last[1] + 1) === ',')),
            done: this.listEnd >= 0,
        };
    }
}
