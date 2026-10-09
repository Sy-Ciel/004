import { PARSED_FIELDS } from './constants.js';
import { findPresetByName } from './targets.js';
import {
    ctx,
    fillTemplate,
    getMessageData,
    getSettings,
    plainText,
    resolveMacros,
    truncate,
    withTimeout,
} from './utils.js';

function formatMessage(message, maxChars) {
    const name = message.name || (message.is_user ? ctx().name1 : ctx().name2);
    return `${name}: ${truncate(plainText(message.mes), maxChars)}`;
}

/** Most recent parsed state of the same character on an earlier floor (for outfit/scene continuity). */
export function findLastState(mesId, targetName) {
    const chat = ctx().chat;
    const wanted = String(targetName || '').toLowerCase();
    for (let i = mesId - 1; i >= 0; i--) {
        const data = getMessageData(chat[i]);
        if (!data?.parsed || data.skipped) continue;
        if (wanted && String(data.target || '').toLowerCase() !== wanted) continue;
        return { floor: i, parsed: data.parsed };
    }
    return null;
}

function formatState(state) {
    if (!state) return '（无）';
    const lines = PARSED_FIELDS
        .filter(field => state.parsed[field])
        .map(field => `${field}: ${state.parsed[field]}`);
    return lines.length ? `（来自 #${state.floor}）\n${lines.join('\n')}` : '（无）';
}

function referenceBlock(target) {
    const settings = getSettings();
    const blocks = [];
    if (target.auto) {
        for (const name of target.candidates) {
            const preset = findPresetByName(name);
            if (preset?.appearance) {
                blocks.push(`【${name} 的固定外貌（仅供识别，不要输出）】\n${resolveMacros(preset.appearance)}`);
            }
        }
        return blocks.join('\n');
    }

    if (target.preset?.appearance) {
        blocks.push(`【固定外貌（已由用户设定，仅供理解，不要输出）】\n${resolveMacros(target.preset.appearance)}`);
    }
    const isUser = target.name && target.name === ctx().name1;
    if (settings.parser.includePersona && isUser) {
        const persona = ctx().powerUserSettings?.persona_description;
        if (persona) blocks.push(`【人设描述】\n${truncate(resolveMacros(persona), 2000)}`);
    }
    if (settings.parser.includeCharDescription && !isUser) {
        try {
            const description = ctx().getCharacterCardFields?.()?.description;
            if (description) blocks.push(`【角色卡描述】\n${truncate(description, 2000)}`);
        } catch {
            // Character card not available (e.g. no character selected)
        }
    }
    return blocks.join('\n');
}

/**
 * Builds the system + user messages for the parser model.
 * @returns {{ system: string, user: string }}
 */
export function buildParserPrompt(mesId, target) {
    const settings = getSettings();
    const chat = ctx().chat;
    const depth = Math.max(0, Number(settings.parser.contextDepth) || 0);
    const maxChars = Number(settings.parser.maxCharsPerMessage) || 0;

    const history = [];
    for (let i = mesId - 1; i >= 0 && history.length < depth; i--) {
        const message = chat[i];
        if (!message || message.is_system) continue;
        history.unshift(formatMessage(message, maxChars));
    }

    const lastState = settings.continuity && !target.auto ? findLastState(mesId, target.name) : null;
    const candidates = target.auto
        ? `【候选角色】请从以下角色中选出当前楼层最适合作为画面主角的一位（通常是动作、情绪描写最集中的人），把名字原样填入 target：\n${target.candidates.map(name => `- ${name}`).join('\n')}`
        : '';

    const vars = {
        target: target.auto ? '（由你从候选角色中选择）' : target.name,
        appearance: referenceBlock(target),
        candidates,
        last_state: target.auto ? '（自动模式下不提供）' : formatState(lastState),
        history: history.length ? history.join('\n\n') : '（无）',
        latest: formatMessage(chat[mesId], maxChars),
        floor: String(mesId),
    };

    return {
        system: fillTemplate(settings.parser.systemPrompt, vars),
        user: fillTemplate(settings.parser.userTemplate, vars).replace(/\n{3,}/g, '\n\n'),
    };
}

function authHeaders(key) {
    return key ? JSON.stringify({ Authorization: `Bearer ${key}` }) : undefined;
}

async function callCustom(system, user, signal) {
    const { parser } = getSettings();
    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
    const url = parser.customUrl.trim().replace(/\/+$/, '');
    if (!url) throw new Error('未填写解析模型的 API 地址');
    if (!parser.customModel.trim()) throw new Error('未填写解析模型名称');

    const service = ctx().ChatCompletionService;
    if (service?.processRequest) {
        // Routed through the SillyTavern server: no CORS problems, key is sent only as a request header.
        const result = await service.processRequest({
            stream: false,
            messages,
            model: parser.customModel.trim(),
            chat_completion_source: 'custom',
            custom_url: url,
            custom_include_headers: authHeaders(parser.customKey.trim()),
            max_tokens: Number(parser.maxTokens) || 800,
            temperature: Number(parser.temperature),
        }, {}, true, signal);
        return typeof result === 'string' ? result : result?.content ?? '';
    }

    const response = await fetch(`${url}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(parser.customKey ? { Authorization: `Bearer ${parser.customKey.trim()}` } : {}),
        },
        body: JSON.stringify({
            model: parser.customModel.trim(),
            messages,
            max_tokens: Number(parser.maxTokens) || 800,
            temperature: Number(parser.temperature),
            stream: false,
        }),
        signal,
    });
    if (!response.ok) {
        throw new Error(`解析模型返回 ${response.status}: ${truncate(await response.text(), 500)}`);
    }
    const json = await response.json();
    return json?.choices?.[0]?.message?.content ?? '';
}

async function callProfile(system, user, signal) {
    const { parser } = getSettings();
    const service = ctx().ConnectionManagerRequestService;
    if (!service) throw new Error('当前酒馆版本没有 Connection Manager 接口，请改用「独立 API」');
    if (!parser.profileId) throw new Error('未选择连接配置');
    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
    const result = await service.sendRequest(
        parser.profileId,
        messages,
        Number(parser.maxTokens) || 800,
        { stream: false, signal, extractData: true, includePreset: true, includeInstruct: true },
        { temperature: Number(parser.temperature) },
    );
    return typeof result === 'string' ? result : result?.content ?? '';
}

async function callMain(system, user, signal) {
    const { parser } = getSettings();
    const { generateRaw } = ctx();
    const request = generateRaw.length > 1
        // Older SillyTavern: positional arguments
        ? generateRaw(user, null, false, false, system, Number(parser.maxTokens) || 800)
        : generateRaw({ prompt: user, systemPrompt: system, responseLength: Number(parser.maxTokens) || 800 });
    const aborted = new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')), { once: true });
    });
    return await Promise.race([request, aborted]);
}

export function parserLabel() {
    const { parser } = getSettings();
    switch (parser.source) {
        case 'profile': {
            const profile = ctx().extensionSettings?.connectionManager?.profiles?.find(p => p.id === parser.profileId);
            return `连接配置: ${profile?.name ?? parser.profileId}${profile?.model ? ` (${profile.model})` : ''}`;
        }
        case 'main':
            return '酒馆当前 API';
        default:
            return `独立 API: ${parser.customModel}`;
    }
}

/**
 * Calls the parser model.
 * @returns {Promise<string>} Raw text returned by the model
 */
export async function callParser(system, user, parentSignal) {
    const { parser } = getSettings();
    const { signal, dispose } = withTimeout(parentSignal, Number(parser.timeoutSec) || 0);
    try {
        switch (parser.source) {
            case 'profile':
                return await callProfile(system, user, signal);
            case 'main':
                return await callMain(system, user, signal);
            default:
                return await callCustom(system, user, signal);
        }
    } catch (error) {
        if (signal.aborted && signal.reason instanceof Error) throw signal.reason;
        throw error;
    } finally {
        dispose();
    }
}

function repairJson(text) {
    return text
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, '\'')
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/\r?\n/g, ' ');
}

function normalizeValue(value) {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.map(normalizeValue).filter(Boolean).join(', ');
    if (typeof value === 'object') return Object.values(value).map(normalizeValue).filter(Boolean).join(', ');
    return String(value).replace(/\s+/g, ' ').trim().replace(/[.。]+$/, '');
}

/**
 * Extracts the JSON object from the parser's reply. Tolerates code fences, thinking blocks and minor syntax slips.
 * @returns {{ skip: boolean, reason?: string, target?: string } & Record<string, string>}
 */
export function parseParserOutput(raw) {
    let text = String(raw ?? '')
        .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
        .trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) text = fence[1];

    let object = null;
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
        const body = text.slice(start, end + 1);
        for (const candidate of [body, repairJson(body)]) {
            try {
                object = JSON.parse(candidate);
                break;
            } catch {
                // try next candidate
            }
        }
    }

    if (!object) {
        object = {};
        for (const key of ['skip', 'reason', 'target', ...PARSED_FIELDS]) {
            const match = text.match(new RegExp(`["']?${key}["']?\\s*[:：]\\s*["']?([^"'\\n}]+)`, 'i'));
            if (match) object[key] = match[1];
        }
        if (!Object.keys(object).length) {
            throw new Error('解析模型没有返回可识别的 JSON');
        }
    }

    const result = {
        skip: object.skip === true || String(object.skip).toLowerCase() === 'true',
        reason: normalizeValue(object.reason),
        target: normalizeValue(object.target),
    };
    for (const field of PARSED_FIELDS) {
        result[field] = normalizeValue(object[field]);
    }
    if (!result.skip && PARSED_FIELDS.every(field => !result[field])) {
        throw new Error('解析结果里没有任何画面字段');
    }
    return result;
}
