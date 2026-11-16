/**
 * 供应商 of the parser's independent API: where its requests go, and what each one keeps for itself. A provider has
 * its own API key, model, model list, thinking format and extra request body. The active provider's are the parser's
 * flat settings (customUrl, customKey, customModel …), as before there were providers; the others' wait in
 * parser.providerStore and are put in place when their provider is chosen, so switching the provider switches the key.
 */
import { getSettings, isPlainObject } from './utils.js';

/**
 * url: the provider's own address (OpenAI-compatible, up to /v1); without one the user fills it in.
 * native: not OpenAI-compatible, called in its own way ('vertex', see vertex.js).
 * chat: the query that leaves only chat models in its model list.
 * models: suggestions for a provider whose list may be refused (Vertex AI, to some keys).
 */
export const PROVIDERS = {
    custom: {
        label: '自定义（OpenAI 兼容，自己填地址）',
        hint: '任何 OpenAI 兼容的接口：填 API 地址（到 /v1 为止）和 Key。',
    },
    openrouter: {
        label: 'OpenRouter',
        url: 'https://openrouter.ai/api/v1',
        hint: '地址固定是 https://openrouter.ai/api/v1，Key 在 openrouter.ai 的 Keys 页面创建。模型名是「厂商/模型」的形式，点「获取模型」读取列表。思考参数自动用 OpenRouter 的 reasoning 格式。',
    },
    siliconflow: {
        label: '硅基流动 SiliconFlow（国内站）',
        url: 'https://api.siliconflow.cn/v1',
        chat: 'type=text&sub_type=chat',
        hint: '地址固定是 https://api.siliconflow.cn/v1，用国内站（cloud.siliconflow.cn）的 Key。模型名是「厂商/模型」的形式，点「获取模型」读取对话模型的列表。思考参数自动用 enable_thinking + thinking_budget：只有能开关思考的模型认它，别的模型把「思考模式」留在默认。',
    },
    'siliconflow-global': {
        label: 'SiliconFlow（国际站）',
        url: 'https://api.siliconflow.com/v1',
        chat: 'type=text&sub_type=chat',
        hint: '地址固定是 https://api.siliconflow.com/v1，用国际站（cloud.siliconflow.com）的 Key，和国内站的 Key 不通用。其他和国内站一样。',
    },
    vertex: {
        label: 'Google Vertex AI',
        native: 'vertex',
        // The Gemini text models SillyTavern lists for Vertex AI, until 获取模型 reads Vertex AI's own list; any other name can be typed in.
        models: [
            'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview',
            'gemini-3.1-flash-lite', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
            'gemini-2.0-flash',
        ],
        hint: 'Vertex AI 上的 Gemini 模型，用 Gemini 原生接口，由浏览器直接连接 Google（这台设备要能访问 aiplatform.googleapis.com，不经过酒馆后端）。Key 填快速模式（Express Mode）的 API Key；或者把服务账号 JSON 密钥文件的全部内容粘贴进来（要用 https 或 127.0.0.1 / localhost 打开酒馆，浏览器才能给它签名；它和别的 Key 一样明文存在酒馆的扩展设置里，建议这个服务账号只给 Vertex AI 的权限）。模型点「获取模型」：服务账号读取 Vertex AI 的列表，快速模式的 Key 读不了列表，改为把已知的 Gemini 模型逐个试一遍、留下能用的；也可以手动填 gemini-2.5-flash 这样的名字（不带 google/）。',
    },
};

/** What a provider keeps for itself; the rest of the API settings (temperature, thinking mode …) is shared by all. */
const OWN_KEYS = ['customUrl', 'customKey', 'customModel', 'models', 'thinkingFormat', 'extraBody'];

/** The provider in use (settings from before there were providers are 'custom'). */
export function providerOf(parser = getSettings().parser) {
    return Object.hasOwn(PROVIDERS, parser.provider) ? parser.provider : 'custom';
}

/** Whether the independent API is called in the provider's own way (Vertex AI) instead of OpenAI's. */
export function nativeProvider(parser = getSettings().parser) {
    return parser.source === 'custom' || !parser.source ? PROVIDERS[providerOf(parser)].native ?? '' : '';
}

/** The address requests go to, without a trailing slash: the provider's own, else the one filled in. */
export function providerUrl(parser = getSettings().parser) {
    return String(PROVIDERS[providerOf(parser)].url || parser.customUrl || '').trim().replace(/\/+$/, '');
}

function hostOf(url) {
    try {
        return new URL(String(url).trim()).host.toLowerCase();
    } catch {
        return '';
    }
}

/**
 * Makes `next` the provider: the current one's key, model, model list, thinking format and extra body are put away
 * and `next`'s are put in place (empty the first time). Someone who already used the provider through 自定义, with
 * its address typed in, keeps that key and model on the first switch. Returns whether anything changed.
 */
export function switchProvider(next) {
    const parser = getSettings().parser;
    const current = providerOf(parser);
    if (!Object.hasOwn(PROVIDERS, next) || next === current) return false;
    if (!isPlainObject(parser.providerStore)) parser.providerStore = {};
    const mine = Object.fromEntries(OWN_KEYS.map(key => [key, structuredClone(parser[key])]));
    const { url = '', models = [] } = PROVIDERS[next];
    const typedIn = !parser.providerStore[next] && current === 'custom' && !!url && hostOf(parser.customUrl) === hostOf(url);
    const kept = typedIn
        ? structuredClone(mine)
        : { customUrl: '', customKey: '', customModel: '', models: [...models], thinkingFormat: 'auto', extraBody: '', ...parser.providerStore[next] };
    // A provider with an address of its own always uses it.
    if (url) kept.customUrl = url;
    parser.providerStore[current] = mine;
    delete parser.providerStore[next];
    Object.assign(parser, kept);
    parser.provider = next;
    return true;
}
