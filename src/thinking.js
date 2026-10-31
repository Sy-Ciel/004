/**
 * Thinking (reasoning) mode of the parser model: off / on with an effort, sent in the request body in whatever
 * format the provider understands. Providers disagree on the parameter, so the format is picked from the API
 * address and model name (or chosen by hand). Nothing is sent in "default", so the model behaves as before.
 */
import { getSettings } from './utils.js';

export const THINKING_FORMATS = {
    openai: 'OpenAI 格式 reasoning_effort（OpenAI、Gemini、Grok 等）',
    openrouter: 'OpenRouter 格式 reasoning',
    type: 'thinking.type 格式（智谱 GLM、豆包、DeepSeek）',
    qwen: '通义千问格式 enable_thinking + thinking_budget',
    claude: 'Claude 格式 thinking + effort（Claude 4.5 及更早用 budget_tokens）',
};

/** The efforts, lowest first: OpenAI's names (minimal … xhigh) and Claude's max; providers take what they know. */
export const THINKING_EFFORTS = { minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大' };

/** Thinking budget (tokens) of each effort, for providers that take a budget instead of an effort. */
const BUDGET = { minimal: 512, low: 1024, medium: 4096, high: 16384, xhigh: 24576, max: 32768 };

/** The efforts of SillyTavern's own setting (min, low, medium, high, max), which it turns into each provider's. */
const SILLYTAVERN_EFFORT = { minimal: 'min', xhigh: 'max' };

function effortOf(parser) {
    return Object.hasOwn(THINKING_EFFORTS, parser.thinkingEffort) ? parser.thinkingEffort : 'medium';
}

/**
 * Claude models from before adaptive thinking (Claude 3, 4.0 – 4.5), read from the model name (claude-sonnet-4-5,
 * claude-3-7-sonnet, anthropic/claude-opus-4.1 …): they think with a token budget. Later ones (4.6 and on) take
 * thinking.type "adaptive" with an effort and reject a budget; a name that does not say counts as one of those.
 */
export function budgetClaude(model) {
    const match = String(model ?? '').toLowerCase()
        .match(/claude-(?:(\d+)(?:[-.](\d)(?!\d))?-(?:opus|sonnet|haiku)|(?:opus|sonnet|haiku)-(\d+)(?:[-.](\d)(?!\d))?)/);
    if (!match) return false;
    const major = Number(match[1] ?? match[3]);
    const minor = Number(match[2] ?? match[4] ?? 0);
    return major < 4 || (major === 4 && minor < 6);
}

/** The format used for the independent API: chosen by hand, or guessed from the address and the model name. */
export function thinkingFormat(parser = getSettings().parser) {
    if (THINKING_FORMATS[parser.thinkingFormat]) return parser.thinkingFormat;
    const url = String(parser.customUrl || '').toLowerCase();
    const model = String(parser.customModel || '').toLowerCase();
    if (url.includes('openrouter.ai')) return 'openrouter';
    if (url.includes('anthropic.com') || model.includes('claude')) return 'claude';
    if (url.includes('dashscope') || model.includes('qwen') || model.includes('qwq')) return 'qwen';
    if (url.includes('bigmodel.cn') || url.includes('z.ai') || url.includes('volces.com') || url.includes('deepseek.com')
        || model.startsWith('glm') || model.includes('doubao') || model.includes('deepseek')) return 'type';
    return 'openai';
}

/** Whether the format can take an effort (the thinking.type format only switches thinking on or off). */
export function formatHasEffort(format) {
    return format !== 'type';
}

/**
 * Request-body fields for the independent API, or null in "default". The user's own 「附加请求参数」 are merged
 * after these, so they win.
 */
export function thinkingBody(parser = getSettings().parser) {
    const mode = parser.thinking;
    if (mode !== 'on' && mode !== 'off') return null;
    const on = mode === 'on';
    const effort = effortOf(parser);
    switch (thinkingFormat(parser)) {
        case 'openrouter':
            return { reasoning: on ? { enabled: true, effort } : { enabled: false } };
        case 'type':
            return { thinking: { type: on ? 'enabled' : 'disabled' } };
        case 'qwen':
            return on ? { enable_thinking: true, thinking_budget: BUDGET[effort] } : { enable_thinking: false };
        case 'claude':
            // Claude 3 to 4.5: a token budget (1024 at least), only at temperature 1.
            if (budgetClaude(parser.customModel)) {
                return on ? { thinking: { type: 'enabled', budget_tokens: Math.max(1024, BUDGET[effort]) }, temperature: 1 } : { thinking: { type: 'disabled' } };
            }
            // Later Claude models: adaptive thinking at an effort (low to max). Some cannot switch thinking off at all,
            // so 关闭 asks for the lowest effort and leaves thinking unset (no thinking where the model allows that).
            return on
                ? { thinking: { type: 'adaptive' }, output_config: { effort: effort === 'minimal' ? 'low' : effort } }
                : { output_config: { effort: 'low' } };
        default:
            return { reasoning_effort: on ? effort : 'none' };
    }
}

/**
 * Output limit for a request: the thinking is part of the output, so the limit is raised to leave room for the JSON
 * after it (formats with a budget, and Claude's, whose thinking at an effort counts the same way).
 */
export function thinkingMaxTokens(parser = getSettings().parser) {
    const limit = Number(parser.maxTokens) || 2048;
    if (parser.thinking !== 'on' || !['qwen', 'claude'].includes(thinkingFormat(parser))) return limit;
    return Math.max(limit, BUDGET[effortOf(parser)] + 2048);
}

/**
 * Request fields to leave out with the thinking parameters: Claude models after 4.5 take no temperature (with
 * thinking it is 1 anyway).
 */
export function thinkingOmits(parser = getSettings().parser) {
    const set = parser.thinking === 'on' || parser.thinking === 'off';
    return set && thinkingFormat(parser) === 'claude' && !budgetClaude(parser.customModel) ? ['temperature'] : [];
}

/**
 * Extra payload for a SillyTavern connection profile: SillyTavern turns reasoning_effort into each provider's
 * own parameter. Only the effort is supported there; "off" keeps the profile's own setting.
 */
export function profileThinking(parser = getSettings().parser) {
    if (parser.thinking !== 'on') return {};
    const effort = effortOf(parser);
    return { reasoning_effort: SILLYTAVERN_EFFORT[effort] ?? effort };
}

/** One line describing what is sent, for the settings hint and the debug notes. */
export function describeThinking(parser = getSettings().parser) {
    if (parser.thinking !== 'on' && parser.thinking !== 'off') return '';
    const label = parser.thinking === 'on' ? `开启（强度 ${THINKING_EFFORTS[effortOf(parser)]}）` : '关闭';
    if (parser.source === 'main') return `思考模式：${label} · 「酒馆当前 API」用酒馆自己的设置，这里的思考设置不生效`;
    if (parser.source === 'profile') {
        const payload = profileThinking(parser);
        const rounded = parser.thinking === 'on' && effortOf(parser) === 'xhigh' ? '（酒馆没有「超高」，按「最大」发送）' : '';
        return `思考模式：${label} · 连接配置${Object.keys(payload).length ? `：发送 ${JSON.stringify(payload)}${rounded}，由酒馆按服务商转换` : '：关闭时沿用连接配置自己的设置'}`;
    }
    const auto = THINKING_FORMATS[parser.thinkingFormat] ? '' : '（自动判断）';
    const omitted = thinkingOmits(parser).length ? `，不发送 ${thinkingOmits(parser).join('、')}` : '';
    return `思考模式：${label} · ${THINKING_FORMATS[thinkingFormat(parser)].split('（')[0]}${auto}：发送 ${JSON.stringify(thinkingBody(parser))}${omitted}`;
}
