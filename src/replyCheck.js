/**
 * 正文截断、安全检查、提示词过滤: replies that should not get an automatic picture. SillyTavern does not keep why a
 * reply ended, so the reply itself is read:
 * - cut off: the story tag, a ``` code block or a <details> status bar opened and never closed, or a reply as long as
 *   the response limit that stops mid-sentence;
 * - blocked: an API's or proxy's notice (a safety block, a filtered prompt) instead of a reply, or a refusal when there
 *   is no story.
 */
import { storyTagName } from './parser.js';
import { ctx, log, plainText } from './utils.js';

/** Tokens in a text as SillyTavern counts them (the number shown on a message). */
async function tokenCount(text) {
    try {
        const count = await ctx().getTokenCountAsync?.(text, 0);
        if (Number.isFinite(count)) return count;
    } catch (error) {
        log('token 计数失败，改用估算', error);
    }
    // Rough fallback: about one token per CJK character, four characters per token otherwise.
    const cjk = (text.match(/[぀-ヿ㐀-鿿가-힯＀-￯]/g) || []).length;
    return Math.ceil(cjk + (text.length - cjk) / 4);
}

/** The longest reply the API may write (Chat Completion's response length), 0 when it is not known. */
function maxResponseTokens() {
    const context = ctx();
    return context.mainApi === 'openai' ? Number(context.chatCompletionSettings?.openai_max_tokens) || 0 : 0;
}

/** Whether `<name>` is opened after its last `</name>`. */
function unclosed(text, name) {
    const lower = text.toLowerCase();
    const open = Math.max(lower.lastIndexOf(`<${name}>`), lower.lastIndexOf(`<${name} `));
    return open >= 0 && lower.lastIndexOf(`</${name}`) < open;
}

/** Whether a reply ends a sentence or a block: closing punctuation, an emoji, a closing tag or code fence. */
function endsCleanly(text) {
    const end = String(text).replace(/(?:\s|<!--[\s\S]*?-->)+$/, '');
    if (/(?:<\/[\w:-]+\s*>|```)$/.test(end)) return true;
    return /[。！？!?….」』”’"'）)】》〉~～—♪♥❤☆★*\]]$|\p{Extended_Pictographic}$/u.test(end);
}

/** Why a reply was cut off, or ''. */
async function truncation(message) {
    const text = String(message?.mes ?? '');
    const tag = storyTagName().toLowerCase();
    if (unclosed(text, tag)) return `正文被截断（<${tag}> 没有写完）`;
    if ((text.match(/```/g) ?? []).length % 2) return '正文被截断（代码块没有写完）';
    if (unclosed(text, 'details')) return '正文被截断（状态栏没有写完）';
    const max = maxResponseTokens();
    if (max > 0 && !endsCleanly(text)) {
        const reasoning = String(message?.extra?.reasoning ?? '');
        const tokens = await tokenCount(text) + (reasoning ? await tokenCount(reasoning) : 0);
        if (tokens >= max * 0.95) return `正文被截断（写到了最大回复长度 ${max} token，停在句子中间）`;
    }
    return '';
}

/**
 * Error codes of APIs and proxies for a blocked prompt or reply. They are never a story's words, so they are looked
 * for in all of a reply except its story.
 */
// No word boundaries: an error shown as raw JSON reads "…candidate\nPrompt was blocked…".
const PROMPT_CODES = /blockReason|Prompt was blocked|data_inspection_failed|Input data may contain inappropriate content/i;
const SAFETY_CODES = /PROHIBITED_CONTENT|\bBLOCKLIST\b|\bSPII\b|IMAGE_SAFETY|content_filter|ResponsibleAIPolicyViolation|content management policy|Content Exists Risk|Candidate text empty|finish_?reason\W{1,4}SAFETY/i;

/**
 * Notices and refusals worded for a person. A story can say such things too (「抱歉，我不能告诉你」, a system novel's
 * 「系统检测到……」), so they only count in a short reply without a story.
 */
const PROMPT_NOTICE = /输入内容可能包含|输入.{0,6}(?:违规|敏感|不安全)|提示词.{0,6}(?:违规|敏感|被过滤|被拦截)|\b(?:prompt|input)\b[^.\n]{0,40}\b(?:blocked|filtered|flagged|rejected)\b/i;
const NOTICES = [
    /\b(?:I'?m sorry|I am sorry|I apologi[sz]e|Unfortunately)\b[^.!?\n]{0,80}\b(?:can(?:no|')?t|cannot|unable|won'?t|not able|not allowed)\b/i,
    /\bI\s+(?:can(?:no|')?t|cannot|won'?t|am unable to|am not able to|must decline to)\s+(?:help|assist|continue|comply|create|generate|write|provide|fulfil+|engage|produce|do that|go on|participate)/i,
    /\b(?:as an ai|an ai language model)\b/i,
    /\b(?:against|violat\w*)\s+(?:my|the|our|\w+'s)\s+(?:content\s+)?(?:guidelines|polic(?:y|ies)|usage polic(?:y|ies)|terms)\b/i,
    /\b(?:content|request|message|output|response)\s+(?:was|has been|is|were|got)\s+(?:blocked|filtered|flagged|rejected|refused|censored|moderated)\b/i,
    /\bsafety (?:filter|system|settings|guidelines|reasons|check)\b/i,
    /(?:抱歉|对不起|很遗憾|不好意思).{0,24}(?:无法|不能|不可以|没办法|不便)/,
    /我(?:无法|不能|不会|没办法)(?:继续|提供|生成|完成|协助|参与|满足|创作|写|回答|帮助|处理)/,
    /(?:违反|违背|不符合).{0,12}(?:政策|规定|准则|规范|法律|法规|条款)/,
    /(?:内容|请求|消息|回复|输出|文本).{0,8}(?:违规|不合规|被拦截|被屏蔽|被过滤|已过滤|被阻止|未通过审核|审核未通过|涉及敏感|包含敏感|存在风险)/,
    /触发.{0,6}(?:审核|审查|过滤|风控|安全策略|敏感)/,
    /(?:安全|内容)(?:审核|审查|过滤|拦截)|内容安全策略|系统检测到.{0,10}(?:不安全|敏感)/,
];

/** A short reply: a notice or a refusal, not a story. */
const SHORT_REPLY = 300;

/** Why a reply was blocked (the prompt filtered, a safety check), or ''. */
function blocking(message) {
    const text = String(message?.mes ?? '');
    const tag = storyTagName();
    const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)(?:</${tag}\\s*>|$)`, 'gi');
    const story = [...text.matchAll(pattern)].map(match => match[1]).join('\n');
    const outside = text.replace(pattern, '');
    if (PROMPT_CODES.test(outside)) return '提示词被过滤';
    if (SAFETY_CODES.test(outside)) return '回复被安全检查拦截';
    if (plainText(story).length >= 20) return '';
    const plain = plainText(text.replace(/```[\s\S]*?(?:```|$)/g, '')).trim();
    if (plain.length > SHORT_REPLY) return '';
    if (PROMPT_NOTICE.test(plain)) return '提示词被过滤';
    if (NOTICES.some(notice => notice.test(plain))) return '回复被安全检查拦截（AI 拒绝了这次回复）';
    return '';
}

/**
 * Why a reply should not get an automatic picture (cut off, blocked by a safety check, prompt filtered), or '' when it
 * is fine.
 */
export async function replyProblem(message) {
    return blocking(message) || await truncation(message);
}
