/**
 * 流式传输: a parser reply read as it arrives (server-sent events), so a reverse proxy or gateway that cuts a
 * connection after a while without data keeps it open, and the parse can show how far it is. One reader for the
 * formats the APIs stream in, as SillyTavern's server passes them on untouched: OpenAI's chat completion chunks (and
 * every API that copies them), Gemini's GenerateContentResponse, Claude's message events and Cohere's v2 events.
 * A server that answers with plain JSON anyway (no stream) is read the usual way.
 */
import { TOOL_NAME } from './parserTool.js';

/** Why Gemini stopped without an answer, when it was not the output limit. */
const BLOCKED = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY']);

/** Finish reasons as the parser reads them: 'stop', or 'length' for a reply cut off by the output limit. */
function finishOf(reason) {
    const value = String(reason ?? '');
    return { STOP: 'stop', end_turn: 'stop', COMPLETE: 'stop', MAX_TOKENS: 'length', max_tokens: 'length', tool_use: 'tool_calls' }[value] ?? value.toLowerCase();
}

/** The message of an error sent in place of a chunk ({ error: … } or Claude's { type: 'error' }). */
function errorText(chunk) {
    const error = chunk?.error;
    if (typeof error === 'string') return error;
    return String(error?.message || chunk?.message || '解析模型在流式回复里报了错（没有说明）');
}

/** Collects a streamed reply, chunk by chunk, whatever the API's format. */
class Reply {
    text = '';
    reasoning = '';
    finish = '';
    tier = '';
    /** OpenAI-style tool calls by index: { name, arguments }. */
    calls = [];
    /** Claude's content blocks by index: { type, name, input }. */
    blocks = [];
    /** Gemini's function calls: { name, args }. */
    functions = [];
    blocked = '';

    add(chunk) {
        if (!chunk || typeof chunk !== 'object') return;
        if (chunk.error || chunk.type === 'error') throw new Error(errorText(chunk));
        if (Array.isArray(chunk.candidates) || chunk.promptFeedback || chunk.usageMetadata) this.gemini(chunk);
        else if (typeof chunk.type === 'string' && /^(?:message_|content_block_|ping$)/.test(chunk.type)) this.claude(chunk);
        else if (typeof chunk.type === 'string' && /^(?:content|message|tool-call|citation)-/.test(chunk.type)) this.cohere(chunk);
        else this.openai(chunk);
    }

    openai(chunk) {
        if (chunk.service_tier) this.tier = String(chunk.service_tier);
        const choice = chunk.choices?.[0];
        if (!choice) return;
        const delta = choice.delta ?? choice.message ?? {};
        if (typeof delta.content === 'string') this.text += delta.content;
        else if (Array.isArray(delta.content)) {
            // Mistral's reasoning models: text and thinking parts.
            for (const part of delta.content) {
                if (part?.type === 'thinking') this.reasoning += Array.isArray(part.thinking) ? part.thinking.map(item => item?.text ?? '').join('') : String(part.thinking ?? '');
                else if (typeof part?.text === 'string') this.text += part.text;
            }
        }
        if (typeof choice.text === 'string') this.text += choice.text;
        const thought = delta.reasoning_content ?? delta.reasoning;
        if (typeof thought === 'string') this.reasoning += thought;
        for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
            const index = Number.isInteger(call?.index) ? call.index : this.calls.length ? this.calls.length - 1 : 0;
            const entry = (this.calls[index] ??= { name: '', arguments: '' });
            if (call?.function?.name) entry.name = call.function.name;
            const args = call?.function?.arguments;
            if (typeof args === 'string') entry.arguments += args;
            else if (args && typeof args === 'object') entry.arguments = JSON.stringify(args);
        }
        if (choice.finish_reason) this.finish = finishOf(choice.finish_reason);
    }

    gemini(chunk) {
        if (chunk.usageMetadata?.trafficType) this.tier = String(chunk.usageMetadata.trafficType);
        if (chunk.promptFeedback?.blockReason) this.blocked = String(chunk.promptFeedback.blockReason);
        const candidate = chunk.candidates?.[0];
        if (!candidate) return;
        for (const part of Array.isArray(candidate.content?.parts) ? candidate.content.parts : []) {
            if (part?.functionCall) this.functions.push(part.functionCall);
            else if (typeof part?.text === 'string') {
                if (part.thought) this.reasoning += part.text;
                else this.text += part.text;
            }
        }
        if (candidate.finishReason) this.finish = finishOf(candidate.finishReason);
        if (BLOCKED.has(String(candidate.finishReason ?? ''))) this.blocked = String(candidate.finishReason);
    }

    claude(chunk) {
        const index = Number(chunk.index ?? 0);
        switch (chunk.type) {
            case 'content_block_start': {
                const block = chunk.content_block ?? {};
                this.blocks[index] = { type: block.type, name: block.name ?? '', input: '' };
                if (block.type === 'text' && typeof block.text === 'string') this.text += block.text;
                if (block.type === 'thinking' && typeof block.thinking === 'string') this.reasoning += block.thinking;
                break;
            }
            case 'content_block_delta': {
                const delta = chunk.delta ?? {};
                if (delta.type === 'text_delta') this.text += String(delta.text ?? '');
                else if (delta.type === 'thinking_delta') this.reasoning += String(delta.thinking ?? '');
                else if (delta.type === 'input_json_delta' && this.blocks[index]) this.blocks[index].input += String(delta.partial_json ?? '');
                break;
            }
            case 'message_delta':
                if (chunk.delta?.stop_reason) this.finish = finishOf(chunk.delta.stop_reason);
                break;
        }
    }

    cohere(chunk) {
        const content = chunk.delta?.message?.content;
        if (chunk.type === 'content-delta' && content) {
            if (typeof content.text === 'string') this.text += content.text;
            if (typeof content.thinking === 'string') this.reasoning += content.thinking;
        }
        if (chunk.type === 'message-end' && chunk.delta?.finish_reason) this.finish = finishOf(chunk.delta.finish_reason);
    }

    /** The submit_picture call's arguments so far, as JSON text (null without a call). */
    call() {
        const named = list => list.find(item => item?.name === TOOL_NAME) ?? list[0];
        const call = named(this.calls.filter(Boolean));
        if (call) return call.arguments;
        const use = named(this.blocks.filter(block => block?.type === 'tool_use'));
        if (use) return use.input;
        const fn = named(this.functions);
        return fn ? JSON.stringify(fn.args ?? {}) : null;
    }

    /** The submit_picture call's arguments as JSON text ('' without a call): the parser's result then. */
    tool() {
        const call = this.call();
        return call === null ? '' : call || '{}';
    }

    /** @returns {{ content: string, reasoning: string, finish: string, tool: boolean, tier: string }} */
    result() {
        const tool = this.tool();
        if (!tool && !this.text.trim() && this.blocked) throw new Error(`解析模型没有回答：回复被拦下了（${this.blocked}）`);
        return { content: tool || this.text, reasoning: this.reasoning, finish: this.finish, tool: !!tool, tier: this.tier };
    }
}

/**
 * Reads a streamed reply to the end.
 * @param {Response} response
 * @param {{ onData?: () => void, onProgress?: (progress: { text: number, reasoning: number, answer: () => string }) => void, fallback: (json: object) => object }} options
 *   onData: something arrived (keeps the time without data from running out); onProgress: what has come in so far
 *   (how many characters of answer and thinking, and the answer itself);
 *   fallback: how to read the reply when the server answered with plain JSON instead of a stream
 */
export async function readStream(response, { onData, onProgress, fallback }) {
    const reply = new Reply();
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = '';
    let raw = '';
    let events = 0;
    let data = [];
    const dispatch = () => {
        if (!data.length) return;
        const payload = data.join('\n').trim();
        data = [];
        if (!payload || payload === '[DONE]') return;
        let chunk;
        try {
            chunk = JSON.parse(payload);
        } catch {
            return;
        }
        events++;
        reply.add(chunk);
        onProgress?.({
            text: reply.text.length + reply.calls.reduce((sum, call) => sum + (call?.arguments?.length ?? 0), 0),
            reasoning: reply.reasoning.length,
            // The answer so far (边解析边出图 reads it): the submit_picture call's arguments once it is made, else the text.
            answer: () => reply.call() ?? reply.text,
        });
    };
    const line = text => {
        if (text === '') dispatch();
        else if (text.startsWith('data:')) data.push(text.slice(5).replace(/^ /, ''));
        // event:, id:, retry: and comments (:) carry nothing the reply needs.
    };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        onData?.();
        const piece = decoder.decode(value, { stream: true });
        // Kept whole until it is clear the server streams (a plain JSON reply is read at the end).
        if (!events && raw.length < 1e6) raw += piece;
        buffer += piece;
        let end;
        while ((end = buffer.search(/\r?\n/)) >= 0) {
            line(buffer.slice(0, end));
            buffer = buffer.slice(buffer[end] === '\r' ? end + 2 : end + 1);
        }
    }
    buffer += decoder.decode();
    if (buffer) line(buffer);
    dispatch();
    if (!events) {
        // Not a stream after all: a JSON reply (an error, or a server that does not stream).
        let json = null;
        try {
            json = JSON.parse(raw.trim() || 'null');
        } catch {
            json = null;
        }
        if (json && typeof json === 'object') {
            if (json.error) throw new Error(errorText(json));
            return fallback(json);
        }
    }
    return reply.result();
}

/** The message of a failed (non-2xx) streamed request: the API's own words when it sent JSON. */
export async function streamError(response) {
    const text = await response.text().catch(() => '');
    try {
        const json = JSON.parse(text);
        return String(json?.error?.message || json?.message || (typeof json?.error === 'string' ? json.error : '') || text).slice(0, 500);
    } catch {
        return text.slice(0, 500);
    }
}
