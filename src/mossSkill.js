/**
 * MOSS-Image 提示词 skill: Moeblack's 《MOSS-Image 提示词编译 SKILL》 (github.com/Moeblack/moss-image-prompt-skill,
 * CC BY-NC-ND 4.0) for the parser in MOSS-Image mode. Its licence lets people use it as it is in their own image
 * workflow, not pass on a shortened or reworded version, so the extension carries none of it: the browser downloads
 * the one version checked here (length and fingerprint must match), keeps it, and the sections on how to write for
 * the model go into the parser's System prompt word for word, with where they come from. Which ones depends on what
 * the parser writes (see mossSkillBlock). The sections on people's age, body and photo-shoot looks are never sent:
 * how people look comes from the character card.
 */
import { fingerprint } from './parserPresetDefaults.js';
import { errorMessage, warn } from './utils.js';

const REPO = 'Moeblack/moss-image-prompt-skill';
const COMMIT = '79f2e3e4e0981e1128ebd33b25f148913d905373';
export const MOSS_SKILL_VERSION = '2.0.0';
const FINGERPRINT = '66450:fd95ccee';
const SOURCES = [
    `https://raw.githubusercontent.com/${REPO}/${COMMIT}/SKILL.md`,
    `https://cdn.jsdelivr.net/gh/${REPO}@${COMMIT}/SKILL.md`,
    `https://fastly.jsdelivr.net/gh/${REPO}@${COMMIT}/SKILL.md`,
];
/** Where the file is kept in this browser (it is not part of the settings, which every save writes out). */
const STORE_KEY = 'ctp_moss_skill';
/** After a failed automatic download, parses go on without the skill for this long before trying again. */
const RETRY_AFTER = 10 * 60 * 1000;

/** The sections used: from a heading to the next section (or to `until`). */
const SECTIONS = {
    people: { number: 7, from: '## 7. ' },
    useless: { number: 11, from: '## 11. ' },
    blocks: { number: 16, from: '## 16. ', until: '#### 模板 3' },
    bubbles: { number: 19, from: '## 19. ', until: '### 19.4' },
};

let cached = null;
let loading = null;
let failedAt = 0;
let lastError = '';

/** The text if it is the checked version (line ends and a byte order mark aside), else null. */
function checked(text) {
    const value = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    return fingerprint(value) === FINGERPRINT ? value : null;
}

function stored() {
    if (!cached) {
        try {
            cached = checked(localStorage.getItem(STORE_KEY));
        } catch {
            cached = null;
        }
    }
    return cached;
}

function keep(text) {
    cached = text;
    failedAt = 0;
    lastError = '';
    try {
        localStorage.setItem(STORE_KEY, text);
    } catch {
        // Not kept past this page load (storage full or blocked); downloaded again next time.
    }
}

/** What the settings show: whether the file is here, or why the last download failed. */
export function mossSkillStatus() {
    if (stored()) return `已下载 v${MOSS_SKILL_VERSION}`;
    return lastError ? `下载失败：${lastError}` : '还没下载（第一次用时自动下载）';
}

/** Downloads the checked version from the first source that has it; throws with every source's reason otherwise. */
export async function downloadMossSkill() {
    const reasons = [];
    for (const url of SOURCES) {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const text = checked(await response.text());
            if (!text) throw new Error('内容和扩展核对过的版本不一样');
            keep(text);
            return text;
        } catch (error) {
            reasons.push(`${new URL(url).host} ${error?.name === 'TimeoutError' ? '超时' : errorMessage(error)}`);
        }
    }
    failedAt = Date.now();
    lastError = reasons.join('；');
    throw new Error(lastError);
}

/** Takes the file the user downloaded themselves (the same version). */
export async function importMossSkill(file) {
    const text = checked(await file.text());
    if (!text) throw new Error(`不是扩展核对过的那一版 SKILL.md（${REPO} v${MOSS_SKILL_VERSION}，提交 ${COMMIT.slice(0, 7)}）`);
    keep(text);
}

/** The file for a parse: kept, else downloaded now (one download for parses that start together). */
async function skillForParse() {
    if (stored()) return cached;
    if (!loading && Date.now() - failedAt > RETRY_AFTER) {
        loading = downloadMossSkill()
            .catch(error => {
                warn('MOSS 提示词 skill 下载失败', error);
                return null;
            })
            .finally(() => { loading = null; });
    }
    return loading ?? null;
}

function section(text, { from, until }) {
    const start = text.indexOf(`\n${from}`) + 1;
    if (!start) return '';
    const next = text.indexOf('\n## ', start);
    const cut = until ? text.indexOf(`\n${until}`, start) : -1;
    const end = [next, cut].filter(index => index > 0).reduce((a, b) => Math.min(a, b), text.length);
    return text.slice(start, end).trim();
}

/** How the sections apply to what the parser writes. */
function howToUse(mode, comic, chinese) {
    if (comic) {
        return '漫画的版面照上面的格式写（layout、items，bbox 用整页的百分比）。旁白框和台词气泡的 caption、位置按 §19 写：它说的像素按整页约 1000 像素宽换算成百分比（80 像素约 8%）';
    }
    if (mode === 'ai') {
        const block = chinese ? '<|中文概念名|>「……」<|/中文概念名|>（§16 的中文写法）' : '<|英文概念名|>……<|/英文概念名|>';
        return `prompt 改用 §16 的闭合标签分块写法（代替上面说的「一段」和其中的先后顺序）：${block}，一行一块（JSON 字符串里用 \\n 换行），第一块写镜头、光影和氛围，然后是主角（外貌、服装、动作、表情、身上的光），有其他人时每人一块，最后是背景；两人全身紧贴（拥抱、背起来）或胸像特写时不分块，写一段连贯的短文`;
    }
    return '你只写各个字段，程序按固定顺序把它们拼成提示词：字段里不要写 <|……|> 标签';
}

/**
 * The skill's part of a MOSS-Image parser System prompt: the sections for what the parser writes, word for word —
 * §7 (people side by side) when others may be drawn, §11 (what does not work) always, §16 (closed-tag blocks)
 * when it writes the whole prompt, §19 (speech bubbles) for comic pages with dialogue — under a note on how they
 * apply here. Without the file (download failed) the parse goes on without it.
 * @param {{ mode: 'fixed'|'ai', comic: { dialogue: boolean }|null, allowOthers: boolean, chinese?: boolean }} request
 *   chinese: 中文提示词 (the picture is written in Chinese)
 * @returns {Promise<{ text: string, note: string }>}
 */
export async function mossSkillBlock({ mode, comic, allowOthers, chinese = false }) {
    const skill = await skillForParse();
    if (!skill) return { text: '', note: 'MOSS 提示词 skill 还没下载成功，这次解析没带上（设置最上方「提示词写法」那里可以重新下载或从文件导入）' };
    const keys = comic
        ? ['useless', ...(comic.dialogue ? ['bubbles'] : [])]
        : [...(allowOthers ? ['people'] : []), 'useless', ...(mode === 'ai' ? ['blocks'] : [])];
    const used = keys.map(key => SECTIONS[key]);
    const text = `【MOSS-Image 提示词写法参考】
下面几节是 Moeblack《MOSS-Image 提示词编译 SKILL》v${MOSS_SKILL_VERSION} 的原文（https://github.com/${REPO} ，CC BY-NC-ND 4.0）。写${chinese ? '' : '英文'}画面描述时按这些写法来${chinese ? '（这次用中文写，它举的英文写法换成同样意思的中文）' : ''}；和上面的要求冲突时，以上面的为准：
- 只输出上面要求的 JSON：它说的 Positive / Negative 两段格式、采样参数和自检都不用写
- 画风由程序在提示词开头加的触发词和画风前缀决定：不要换画风，不要写画师名或 <|artist|> 标签
- 人物的外貌、年龄、身材和穿着只按【角色设定】和正文写
- ${howToUse(mode, comic, chinese)}

${used.map(item => section(skill, item)).join('\n\n')}`;
    return { text, note: `参考了 MOSS 提示词 skill 的 ${used.map(item => `§${item.number}`).join('、')}` };
}
