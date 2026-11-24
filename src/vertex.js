/**
 * Google Vertex AI for the parser (the vertex provider): Gemini's own generateContent API, called from the browser.
 * Vertex AI has no OpenAI-compatible route for express mode keys, and SillyTavern's server only uses the credentials
 * saved in its own API panel, so this request does not go through the server like the other providers' do.
 * The key field holds either kind of credential:
 * - an express mode API key (sent as x-goog-api-key to the endpoint without a project, or with the project filled in);
 * - the JSON key file of a service account: signed into a short-lived access token with the browser's WebCrypto,
 *   which needs https or localhost, for the project in the file.
 */
import { geminiModel, thinkingMaxTokens, vertexThinking } from './thinking.js';
import { readStream } from './stream.js';
import { errorMessage, isAbortError, isPlainObject, settingsError, truncate } from './utils.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** Safety filters are switched off, as SillyTavern does for Vertex AI: a story is not to be refused as a prompt. */
const SAFETY = [
    'HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT',
    'HARM_CATEGORY_CIVIC_INTEGRITY', 'HARM_CATEGORY_IMAGE_HATE', 'HARM_CATEGORY_IMAGE_DANGEROUS_CONTENT', 'HARM_CATEGORY_IMAGE_HARASSMENT',
    'HARM_CATEGORY_IMAGE_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_JAILBREAK',
];

/** Gemini models that take no sampling settings (temperature …), as SillyTavern lists them. */
const NO_SAMPLING = /gemini-3\.[678]-flash|gemini-3\.5-flash-lite/;

/** Why Gemini stopped without an answer, when it was not the output limit. */
const BLOCKED = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY']);

/**
 * What the key field holds: { key } for an API key, { account } for a service account's JSON key file, null when
 * it is empty.
 */
export function vertexCredential(text) {
    const value = String(text ?? '').trim();
    if (!value) return null;
    if (!value.startsWith('{')) return { key: value };
    let account;
    try {
        account = JSON.parse(value);
    } catch (error) {
        throw settingsError(`Key 里的服务账号 JSON 读不出来（要粘贴整个文件的内容）：${error.message}`);
    }
    if (!account?.client_email || !account?.private_key) {
        throw settingsError('Key 里的 JSON 不是服务账号的密钥文件（里面要有 client_email 和 private_key）');
    }
    return { account };
}

function base64url(bytes) {
    return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeJson(value) {
    return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

/** Access tokens by service account: { token, keyId, expires }. They last an hour; a new one is asked for a minute early. */
const tokens = new Map();

/** The signed request for an access token (a JWT, RS256), for one hour from `now` (seconds). */
export async function signedAssertion(account, now) {
    const unsigned = `${encodeJson({ alg: 'RS256', typ: 'JWT' })}.${encodeJson({ iss: account.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })}`;
    const pem = String(account.private_key).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), char => char.charCodeAt(0)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    return `${unsigned}.${base64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)))}`;
}

async function accessToken(account, signal) {
    const cached = tokens.get(account.client_email);
    if (cached && cached.keyId === account.private_key_id && Date.now() < cached.expires) return cached.token;
    if (!globalThis.crypto?.subtle) {
        throw settingsError('服务账号 JSON 要由浏览器签名，这个页面不是安全连接所以做不了：请用 https 或 http://127.0.0.1（localhost）打开酒馆，或者改用快速模式的 API Key');
    }
    let assertion;
    try {
        assertion = await signedAssertion(account, Math.floor(Date.now() / 1000));
    } catch (error) {
        throw settingsError(`服务账号 JSON 里的 private_key 用不了：${errorMessage(error)}`);
    }
    const response = await request(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
        signal,
    }, 'oauth2.googleapis.com');
    const json = await response.json().catch(() => null);
    if (!response.ok || !json?.access_token) {
        // A refused key (deleted, disabled, wrong clock) stays refused.
        throw settingsError(`Google 没有给这个服务账号发访问令牌（${response.status}）：${json?.error_description || json?.error || '没有说明'}`);
    }
    tokens.set(account.client_email, { token: json.access_token, keyId: account.private_key_id, expires: Date.now() + (Number(json.expires_in) || 3600) * 1000 - 60000 });
    return json.access_token;
}

/** fetch, with a failure to connect explained: the browser itself has to reach Google. */
async function request(url, init, host) {
    try {
        return await fetch(url, init);
    } catch (error) {
        if (isAbortError(error) || init.signal?.aborted) throw error;
        throw new Error(`浏览器连不上 Google（${host}）：${errorMessage(error)}。Vertex AI 由浏览器直接连接，这台设备要能访问 Google；连不上时可以改用「酒馆连接配置」，让酒馆后端去连`);
    }
}

/** Where a model's generateContent is: the global endpoint or a region's, under the project when there is one. */
export function vertexEndpoint(parser, credential) {
    const model = geminiModel(parser.customModel);
    if (!model) throw settingsError('未填写解析模型名称');
    const region = String(parser.vertexRegion ?? '').trim().toLowerCase() || 'global';
    const project = String(parser.vertexProject ?? '').trim() || String(credential.account?.project_id ?? '');
    if (!/^[a-z0-9-]+$/.test(region)) throw settingsError(`Vertex AI 的区域「${region}」不对：填 global，或 us-central1 这样的区域名`);
    if (credential.account && !project) throw settingsError('服务账号 JSON 里没有 project_id：在「项目 ID」里填上');
    const host = region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`;
    const scope = project ? `projects/${encodeURIComponent(project)}/locations/${region}/` : '';
    return { host, url: `https://${host}/v1/${scope}publishers/google/models/${encodeURIComponent(model)}:generateContent` };
}

/** `extra` merged into `body`, objects inside objects too (附加请求参数, e.g. {"generationConfig": {"topP": 0.9}}). */
function merge(body, extra) {
    for (const [key, value] of Object.entries(extra ?? {})) {
        if (isPlainObject(value) && isPlainObject(body[key])) merge(body[key], value);
        else body[key] = value;
    }
    return body;
}

/**
 * The generateContent request of a parse: the System prompt as the system instruction, the User message, safety
 * filters off, the output limit and temperature, the thinking setting, the submit_picture tool when it is used, and
 * the Flex tier when it is asked for (serviceTier in the body, as Google's own SDK sends it: a browser may not send
 * the X-Vertex-AI-LLM-* request headers).
 * @param {{ tool?: { declaration: object, required: boolean } | null, extraBody?: object | null, flex?: boolean }} [options]
 */
export function vertexBody(system, user, parser, { tool = null, extraBody = null, flex = false } = {}) {
    const generationConfig = { candidateCount: 1, maxOutputTokens: thinkingMaxTokens(parser) };
    const temperature = Number(parser.temperature);
    if (NO_SAMPLING.test(geminiModel(parser.customModel).toLowerCase())) delete generationConfig.candidateCount;
    else if (Number.isFinite(temperature)) generationConfig.temperature = temperature;
    const thinking = vertexThinking(parser);
    if (thinking) generationConfig.thinkingConfig = thinking;
    const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        safetySettings: SAFETY.map(category => ({ category, threshold: 'OFF' })),
        generationConfig,
    };
    if (tool) {
        body.tools = [{ functionDeclarations: [tool.declaration] }];
        body.toolConfig = { functionCallingConfig: { mode: tool.required ? 'ANY' : 'AUTO' } };
    }
    if (flex) body.serviceTier = 'flex';
    return merge(body, extraBody);
}

/**
 * A generateContent response as a parser reply: the answer's text, or the arguments of the tool call; the thoughts'
 * summary as the reasoning; MAX_TOKENS as the finish reason "length".
 */
export function readVertexReply(json) {
    const candidate = json?.candidates?.[0];
    if (!candidate) {
        const blocked = json?.promptFeedback?.blockReason;
        throw new Error(blocked ? `Vertex AI 没有回答：这次请求被拦下了（${blocked}）` : 'Vertex AI 没有返回内容');
    }
    const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
    const call = parts.find(part => part?.functionCall)?.functionCall;
    const text = thought => parts.filter(part => typeof part?.text === 'string' && !!part.thought === thought).map(part => part.text).join(thought ? '\n' : '');
    const reason = String(candidate.finishReason ?? '');
    if (!call && !text(false).trim() && BLOCKED.has(reason)) throw new Error(`Vertex AI 没有回答：回复被拦下了（${reason}）`);
    return {
        content: call ? JSON.stringify(call.args ?? {}) : text(false),
        reasoning: text(true),
        finish: { STOP: 'stop', MAX_TOKENS: 'length' }[reason] ?? reason.toLowerCase(),
        tool: !!call,
        // How Google served it: ON_DEMAND (standard), ON_DEMAND_FLEX, PROVISIONED_THROUGHPUT …
        tier: String(json?.usageMetadata?.trafficType ?? ''),
    };
}

/** Models that are not for writing text: embeddings, pictures, speech, live audio and the like. */
const NOT_TEXT = /embedding|image|imagen|tts|live|audio|robotics|computer-use|veo|lyria/;

/** Whether a model name is a Gemini model that writes text (what the parser can use). */
export function isGeminiTextModel(name) {
    const model = geminiModel(String(name ?? ''));
    return model.startsWith('gemini-') && !NOT_TEXT.test(model);
}

const newestFirst = (a, b) => b.localeCompare(a, 'en', { numeric: true });

/** A refused request in Google's own words: 「401：API keys are not supported by this API.」 */
async function refusal(response) {
    const text = await response.text().catch(() => '');
    let message = text;
    try {
        message = JSON.parse(text)?.error?.message || text;
    } catch {
        // not JSON: the text as it is
    }
    return `${response.status}：${truncate(message || '没有说明', 300)}`;
}

/** Vertex AI's own list of publisher models (publishers.models.list, v1beta1), every page: the Gemini text models. */
async function listedModels(host, headers, signal) {
    const names = new Set();
    let pageToken = '';
    // The list holds every publisher model, a page at a time; twenty pages are more than it has.
    for (let page = 0; page < 20; page++) {
        const query = new URLSearchParams({ pageSize: '100', ...(pageToken ? { pageToken } : {}) });
        const response = await request(`https://${host}/v1beta1/publishers/google/models?${query}`, { headers, signal }, host);
        if (!response.ok) {
            const error = new Error(await refusal(response));
            error.status = response.status;
            throw error;
        }
        const json = await response.json().catch(() => null);
        for (const model of json?.publisherModels ?? []) {
            if (isGeminiTextModel(model?.name)) names.add(geminiModel(String(model.name)));
        }
        pageToken = String(json?.nextPageToken ?? '');
        if (!pageToken) break;
    }
    return [...names].sort(newestFirst);
}

/**
 * Which of `candidates` this API key can use, found by asking each one. First to count the tokens of one word
 * (free); a key that may not count tokens either is asked the way a parse asks, the call SillyTavern's own Vertex
 * AI connection makes with the same key: generateContent, here for one word with a single token of output. A model
 * that answers is usable; one Google does not know (404) is left out; one that could not be asked (rate limit,
 * server error) stays. Throws with Google's words when the key is refused for every one of them.
 */
async function probedModels(parser, credential, candidates, signal) {
    const names = [...new Set(candidates.map(name => geminiModel(String(name ?? ''))).filter(isGeminiTextModel))];
    const usable = new Set();
    const contents = [{ role: 'user', parts: [{ text: 'hi' }] }];
    let countRefused = false;
    let refused = '';
    const post = (url, host, body) => request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': credential.key },
        body: JSON.stringify(body),
        signal,
    }, host);
    const denied = response => response.status === 401 || response.status === 403;
    const ask = async name => {
        const { host, url } = vertexEndpoint({ ...parser, customModel: name }, credential);
        let response = countRefused ? null : await post(url.replace(/:generateContent$/, ':countTokens'), host, { contents });
        if (!response || denied(response)) {
            countRefused = true;
            response = await post(url, host, { contents, generationConfig: { maxOutputTokens: 1 } });
        }
        // 400: Google knows the model and only minds the request.
        if (response.ok || response.status === 400 || response.status === 429 || response.status >= 500) usable.add(name);
        else if (denied(response)) refused ||= await refusal(response);
    };
    // A few at a time: an express mode key has a low rate limit.
    const queue = [...names];
    await Promise.all(Array.from({ length: 4 }, async () => {
        while (queue.length) await ask(queue.shift());
    }));
    if (!usable.size && refused) throw new Error(`读模型列表被拒绝，把已知的 ${names.length} 个模型逐个试了一遍也都被拒绝——${refused}`);
    return names.filter(name => usable.has(name)).sort(newestFirst);
}

/**
 * The Gemini models this credential can use, newest names first.
 * - A service account: Vertex AI's own list.
 * - An API key: the list when Google gives it; an express mode key may only generate and count tokens, so the
 *   `candidates` (the names known here and in SillyTavern) are tried one by one instead.
 * @param {string[]} [candidates] names to try with an API key
 * @returns {Promise<{ models: string[], tried: number }>} tried: how many names were tried one by one (0 = listed)
 */
export async function listVertexModels(parser, signal, candidates = []) {
    const credential = vertexCredential(parser.customKey);
    if (!credential) throw settingsError('未填写 Vertex AI 的 Key（快速模式的 API Key，或服务账号 JSON）');
    const region = String(parser.vertexRegion ?? '').trim().toLowerCase() || 'global';
    if (!/^[a-z0-9-]+$/.test(region)) throw settingsError(`Vertex AI 的区域「${region}」不对：填 global，或 us-central1 这样的区域名`);
    const host = region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`;
    if (credential.account) {
        try {
            return { models: await listedModels(host, { Authorization: `Bearer ${await accessToken(credential.account, signal)}` }, signal), tried: 0 };
        } catch (error) {
            // An access token Google no longer takes: the next try signs a new one.
            if (error.status === 401) tokens.delete(credential.account.client_email);
            throw error;
        }
    }
    try {
        return { models: await listedModels(host, { 'x-goog-api-key': credential.key }, signal), tried: 0 };
    } catch (error) {
        // Refused to this key (express mode): try the known names. Anything else (no connection, timeout) is the answer.
        if (error.status !== 401 && error.status !== 403) throw error;
    }
    const names = [...new Set(candidates.map(name => geminiModel(String(name ?? ''))).filter(isGeminiTextModel))];
    return { models: await probedModels(parser, credential, names, signal), tried: names.length };
}

/** Models Google refused the Flex tier for in this page load: they are asked the standard way from then on. */
const noFlex = new Set();

/**
 * One parser request to Vertex AI.
 * Flex 模式 (options.flex): the request asks for the Flex tier and goes to the global endpoint, the only one that has
 * it. A model Google does not offer Flex for (a 400 that says so) is asked again the standard way, and the reply
 * says so in `note`.
 * @param {{ tool?: { declaration: object, required: boolean } | null, extraBody?: object | null, flex?: boolean, stream?: boolean, io?: object }} [options]
 *   stream: read the reply as it arrives (流式传输); io: what to tell while it does (see readStream)
 * @returns {Promise<{ content: string, reasoning: string, finish: string, tool: boolean, tier: string, note?: string }>}
 */
export async function callVertex(system, user, signal, parser, options = {}) {
    const credential = vertexCredential(parser.customKey);
    if (!credential) throw settingsError('未填写 Vertex AI 的 Key（快速模式的 API Key，或服务账号 JSON）');
    const model = geminiModel(parser.customModel).toLowerCase();
    const headers = { 'Content-Type': 'application/json' };
    if (credential.key) headers['x-goog-api-key'] = credential.key;
    else headers.Authorization = `Bearer ${await accessToken(credential.account, signal)}`;
    const send = async flex => {
        const { host, url } = vertexEndpoint(flex ? { ...parser, vertexRegion: 'global' } : parser, credential);
        // 流式传输: streamGenerateContent as server-sent events (see stream.js).
        const target = options.stream ? `${url.replace(/:generateContent$/, ':streamGenerateContent')}?alt=sse` : url;
        const response = await request(target, { method: 'POST', headers, body: JSON.stringify(vertexBody(system, user, parser, { ...options, flex })), signal }, host);
        if (response.ok) return { reply: options.stream ? await readStream(response, { ...options.io, fallback: readVertexReply }) : readVertexReply(await response.json()) };
        const text = await response.text().catch(() => '');
        let message = truncate(text, 500);
        try {
            message = JSON.parse(text)?.error?.message || message;
        } catch {
            // not JSON: the text as it is
        }
        return { status: response.status, message: truncate(message, 500) };
    };
    const flex = !!options.flex && !noFlex.has(model);
    let result = await send(flex);
    let note = '';
    if (flex && result.status === 400 && /flex|service.?tier/i.test(result.message)) {
        noFlex.add(model);
        note = `Flex 模式：Google 不给 ${model} 提供 Flex（${truncate(result.message, 160)}），这次按标准发送`;
        result = await send(false);
    }
    if (!result.reply) {
        // An access token Google no longer takes: the next try signs a new one.
        if (result.status === 401 && credential.account) tokens.delete(credential.account.client_email);
        const error = new Error(`Vertex AI 返回 ${result.status}：${result.message}`);
        // The key, the model name or the request itself is wrong: asking again gives the same answer.
        error.noRetry = [400, 403, 404].includes(result.status) || (result.status === 401 && !!credential.key);
        throw error;
    }
    return { ...result.reply, ...(note ? { note } : {}) };
}
