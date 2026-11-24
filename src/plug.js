/**
 * 酒馆 API 连接（插头）: the parser asks through SillyTavern's own API connection — the one chosen under the plug
 * icon: its API, key, reverse proxy, Vertex AI region and authentication … — and SillyTavern's server sends the
 * request, as it sends the chat's. Only the model is the parser's own: any model of that API (Vertex AI with a
 * reverse proxy: the chat on one Gemini, the parser on another). Chat Completion connections only.
 */
import { toolBody } from './parserTool.js';
import { GEMINI_ROOM, geminiModel, geminiThinks, plugThinking } from './thinking.js';
import { ctx, getSettings, isPlainObject } from './utils.js';

/** The chat completion source's name as SillyTavern's API panel shows it (its id when the panel is not there). */
function sourceLabel(source) {
    const option = document.querySelector(`#chat_completion_source option[value="${CSS.escape(source)}"]`);
    return option?.textContent?.trim() || source;
}

/**
 * The plug's connection now: its chat completion source and name, the model the chat uses, the reverse proxy in use,
 * and the fields a request through it needs. null when SillyTavern is not on a Chat Completion API.
 * @returns {{ source: string, label: string, chatModel: string, proxy: string, fields: object } | null}
 */
export function plugConnection() {
    const context = ctx();
    const settings = context.chatCompletionSettings;
    if (context.mainApi !== 'openai' || !isPlainObject(settings) || !settings.chat_completion_source) return null;
    const source = String(settings.chat_completion_source);
    const fields = connectionFields(settings, source);
    return {
        source,
        label: sourceLabel(source),
        chatModel: chatModel(settings, source),
        proxy: String(fields.reverse_proxy ?? ''),
        fields,
    };
}

/** The model the chat uses (SillyTavern's own lookup when it has one, else its setting for the source). */
function chatModel(settings, source) {
    let model = '';
    try {
        model = typeof ctx().getChatCompletionModel === 'function' ? ctx().getChatCompletionModel(settings) : '';
    } catch {
        model = '';
    }
    return String(model || settings[MODEL_KEYS[source] ?? `${source}_model`] || '').trim();
}

/** oai_settings keys of the sources whose model setting is not named after them. */
const MODEL_KEYS = { makersuite: 'google_model' };

/** Sources whose requests SillyTavern sends to the plug's reverse proxy (as its chat requests do); others ignore it. */
const PROXY_SOURCES = ['claude', 'openai', 'mistralai', 'makersuite', 'vertexai', 'deepseek', 'xai', 'zai', 'moonshot'];

/** Sources that take the plug's 「use system prompt」 switch. */
const SYSPROMPT_SOURCES = ['claude', 'makersuite', 'vertexai'];

/**
 * A source's connection fields: request field → oai_settings key, as SillyTavern's own chat request carries them
 * (createGenerationParameters in its openai.js). Sampling and prompt settings are left out: the parser has its own.
 */
const SOURCE_FIELDS = {
    vertexai: { vertexai_auth_mode: 'vertexai_auth_mode', vertexai_region: 'vertexai_region', vertexai_express_project_id: 'vertexai_express_project_id' },
    openrouter: { use_fallback: 'openrouter_use_fallback', provider: 'openrouter_providers', quantizations: 'openrouter_quantizations', allow_fallbacks: 'openrouter_allow_fallbacks', middleout: 'openrouter_middleout' },
    nanogpt: { nanogpt_provider: 'nanogpt_provider', nanogpt_payg_override: 'nanogpt_payg_override' },
    azure_openai: { azure_base_url: 'azure_base_url', azure_deployment_name: 'azure_deployment_name', azure_api_version: 'azure_api_version' },
    custom: { custom_url: 'custom_url' },
    siliconflow: { siliconflow_endpoint: 'siliconflow_endpoint' },
    minimax: { minimax_endpoint: 'minimax_endpoint' },
    workers_ai: { workers_ai_account_id: 'workers_ai_account_id' },
};

/** Endpoints SillyTavern sends a default for when none is set. */
const DEFAULT_ENDPOINTS = { zai: ['zai_endpoint', 'common'], pollinations: ['pollinations_endpoint', 'authenticated'] };

/** Fields of the plug's connection that SillyTavern fills macros in (custom headers and body). */
const MACRO_FIELDS = ['custom_include_body', 'custom_exclude_body', 'custom_include_headers'];

/** A connection's fields besides the model: the reverse proxy, the source's own settings, how prompts are processed. */
function connectionFields(settings, source) {
    const fields = {};
    if (settings.reverse_proxy && PROXY_SOURCES.includes(source)) {
        fields.reverse_proxy = settings.reverse_proxy;
        fields.proxy_password = settings.proxy_password;
    }
    for (const [field, key] of Object.entries(SOURCE_FIELDS[source] ?? {})) {
        if (settings[key] !== undefined) fields[field] = structuredClone(settings[key]);
    }
    if (DEFAULT_ENDPOINTS[source]) {
        const [field, fallback] = DEFAULT_ENDPOINTS[source];
        fields[field] = settings[field] || fallback;
    }
    if (source === 'custom') {
        const fill = text => (typeof ctx().substituteParams === 'function' ? ctx().substituteParams(String(text ?? '')) : String(text ?? ''));
        for (const key of MACRO_FIELDS) if (settings[key]) fields[key] = fill(settings[key]);
    }
    // The plug's own 「use system prompt」 switch and prompt post-processing, as for the chat.
    if (SYSPROMPT_SOURCES.includes(source) && settings.use_sysprompt !== undefined) fields.use_sysprompt = !!settings.use_sysprompt;
    if (settings.custom_prompt_post_processing) fields.custom_prompt_post_processing = settings.custom_prompt_post_processing;
    return fields;
}

/** Element ids of the model lists of the sources whose list is not model_<source>_select. */
const MODEL_SELECTS = { makersuite: 'model_google_select' };

/**
 * The plug's models for a source, read from SillyTavern's API panel (its own list for that source: fixed for some,
 * read from the API for others once connected).
 */
export function plugModelList(source) {
    const select = document.getElementById(MODEL_SELECTS[source] ?? `model_${source}_select`);
    if (!select) return [];
    return [...new Set([...select.options].map(option => option.value.trim()).filter(Boolean))];
}

/** The model the parser asks: its own choice for this source, else the chat's. */
export function plugModel(parser = getSettings().parser, connection = plugConnection()) {
    if (!connection) return '';
    const own = isPlainObject(parser.plugModels) ? String(parser.plugModels[connection.source] ?? '').trim() : '';
    return own || connection.chatModel;
}

/** Sources that are Gemini's own API (Google AI Studio, Vertex AI). */
const GOOGLE_SOURCES = ['makersuite', 'vertexai'];

/**
 * The output limit of a request: a Gemini that thinks (2.5 Flash / Pro, 3 and later) counts its thinking as output and
 * can spend a small limit on it alone, so it gets GEMINI_ROOM at least unless thinking is off.
 */
export function plugMaxTokens(parser, connection, model) {
    const limit = Number(parser.maxTokens) || 2048;
    const thinks = GOOGLE_SOURCES.includes(connection.source) && parser.thinking !== 'off' && geminiThinks(geminiModel(model).toLowerCase());
    return thinks ? Math.max(limit, GEMINI_ROOM) : limit;
}

let customProviders = null;

/**
 * 自定义（OpenAI 兼容）in a SillyTavern that keeps custom providers' keys itself: the provider's credentials as its
 * chat request names them (getCustomAuth of its custom-providers.js). undefined in a SillyTavern without it (the
 * server then uses the custom key it keeps).
 */
async function customAuth(settings) {
    customProviders ??= import(new URL('../../../../custom-providers.js', import.meta.url).href).catch(() => null);
    const module = await customProviders;
    try {
        return typeof module?.getCustomAuth === 'function' ? module.getCustomAuth(settings) ?? undefined : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The request SillyTavern's server sends over the plug's connection: the parser's model, messages, temperature,
 * output limit and thinking, the connection's own fields, and the submit_picture tool when it is used.
 */
export async function plugRequest(messages, parser, connection, model) {
    const settings = ctx().chatCompletionSettings ?? {};
    const auth = connection.source === 'custom' ? await customAuth(settings) : undefined;
    return {
        stream: false,
        messages,
        model,
        chat_completion_source: connection.source,
        max_tokens: plugMaxTokens(parser, connection, model),
        temperature: Number(parser.temperature),
        ...connection.fields,
        ...(auth !== undefined ? { custom_auth: auth } : {}),
        ...plugThinking(parser, settings),
        ...toolBody(parser),
    };
}
