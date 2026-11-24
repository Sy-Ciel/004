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

/** OpenRouter's 「the model set on OpenRouter's website」: no model name is sent then. */
const OPENROUTER_WEBSITE = 'OR_Website';

/**
 * The model the chat uses: SillyTavern's own lookup when it has one (its answer stands, none included: OpenRouter's
 * website model is none), else its setting for the source.
 */
function chatModel(settings, source) {
    if (typeof ctx().getChatCompletionModel === 'function') {
        try {
            return String(ctx().getChatCompletionModel(settings) ?? '').trim();
        } catch {
            // fall back to the setting
        }
    }
    const model = String(settings[MODEL_KEYS[source] ?? `${source}_model`] ?? '').trim();
    return model === OPENROUTER_WEBSITE ? '' : model;
}

/** Whether the plug is on OpenRouter with the model set on OpenRouter's website (the request then names none). */
export function openRouterWebsite(connection) {
    return connection?.source === 'openrouter' && ctx().chatCompletionSettings?.openrouter_model === OPENROUTER_WEBSITE;
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
        // Always sent: without it the server's header would read 「Bearer undefined」.
        fields.proxy_password = String(settings.proxy_password ?? '');
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
const MODEL_SELECTS = { makersuite: 'model_google_select', azure_openai: 'azure_openai_model' };

/**
 * The plug's models for a source, read from SillyTavern's API panel (its own list for that source: fixed for some,
 * read from the API for others once connected).
 */
export function plugModelList(source) {
    const select = document.getElementById(MODEL_SELECTS[source] ?? `model_${source}_select`);
    if (!select) return [];
    return [...new Set([...select.options].map(option => option.value.trim()).filter(value => value && value !== OPENROUTER_WEBSITE))];
}

/** The model the parser asks: its own choice for this source, else the chat's. */
export function plugModel(parser = getSettings().parser, connection = plugConnection()) {
    if (!connection) return '';
    const own = isPlainObject(parser.plugModels) ? String(parser.plugModels[connection.source] ?? '').trim() : '';
    return own || connection.chatModel;
}

/** Sources that take the effort as a string: SillyTavern's client maps its own efforts for them first. */
const STRING_EFFORT_SOURCES = ['openai', 'azure_openai', 'custom', 'xai', 'aimlapi', 'openrouter', 'pollinations', 'perplexity', 'cometapi', 'electronhub', 'chutes', 'deepseek', 'fireworks'];

/**
 * SillyTavern's effort (auto / min / low / medium / high / max) as its client sends it for a source and model
 * (getReasoningEffort in its openai.js, which extensions cannot call): Google AI Studio, Vertex AI, Claude … take it
 * as it is and their server code maps it; the string sources get the API's own value, or none for auto.
 * @returns {string | undefined}
 */
export function sourceEffort(source, model, effort, showThoughts) {
    if (!STRING_EFFORT_SOURCES.includes(source)) return effort;
    const gpt = source === 'openai' || source === 'azure_openai';
    if (effort === 'auto') return undefined;
    if (source === 'deepseek') return effort === 'min' || effort === 'low' ? 'low' : effort === 'max' ? 'max' : 'high';
    if (source === 'fireworks') return effort === 'min' ? 'low' : effort;
    if (source === 'custom' && /^koboldcpp\/(.+)$/.test(model)) return { min: 'minimal', max: 'xhigh' }[effort] ?? effort;
    if (effort === 'min') {
        if (source === 'openrouter' && !showThoughts) return 'none';
        if (gpt && /^(?:gpt-5\.(?:4|5|6)|gpt-6-(?:sol|luna)|gpt-6\.1-terra)/.test(model)) return 'none';
        if (gpt && /^gpt-5/.test(model)) return 'min';
        return 'low';
    }
    if (effort === 'max') {
        if (gpt && /^gpt-6(?:\.\d+)?-/.test(model)) return 'max';
        if (gpt && /^gpt-5\.6/.test(model)) return 'xhigh';
        return 'high';
    }
    return effort;
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
    const thinking = plugThinking(parser, settings);
    const effort = sourceEffort(connection.source, model, thinking.reasoning_effort, thinking.include_reasoning);
    const tool = toolBody(parser);
    // Claude takes tool_choice as its own type: 「必须调用」 is its 'any'.
    if (connection.source === 'claude' && tool.tool_choice === 'required') tool.tool_choice = 'any';
    return {
        stream: false,
        messages,
        // OpenRouter's website model: none named, as SillyTavern's chat request does.
        model: model || null,
        chat_completion_source: connection.source,
        max_tokens: plugMaxTokens(parser, connection, model),
        temperature: Number(parser.temperature),
        ...connection.fields,
        ...(auth !== undefined ? { custom_auth: auth } : {}),
        include_reasoning: thinking.include_reasoning,
        ...(effort !== undefined ? { reasoning_effort: effort } : {}),
        ...tool,
    };
}
