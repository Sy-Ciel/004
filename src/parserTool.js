/**
 * 用工具调用返回结果: the parser model hands its result over by calling a tool (submit_picture) instead of writing
 * the JSON in its reply, for models that do better with tools (Gemini, for one). Independent API only: the tool goes
 * into the request body like the thinking parameters (in Gemini's own format for Vertex AI, see vertex.js), and the
 * call's arguments are read as the parser's JSON (a reply that writes the JSON in the text instead is still read).
 */
import { getSettings } from './utils.js';

export const TOOL_NAME = 'submit_picture';

const text = description => ({ type: 'string', ...(description ? { description } : {}) });

/** The picture fields, as the output format names them. */
const PICTURE = {
    outfit: text('服装'),
    action: text('动作姿势'),
    expression: text('表情'),
    demeanor: text('神态'),
    scene: text('场景'),
    camera: text('镜头'),
    lighting: text('光线'),
    others: text('同框的其他人'),
    rating: text('安全分级（Anima）'),
    prompt: text('「AI 写完整提示词」时的整段提示词'),
    negative: text('反向提示词'),
};

/** 漫画模式: one page in MOSS-Image's JSON layout (summary + items). */
const LAYOUT = {
    type: 'object',
    description: '漫画模式：这一页的 JSON 版面，照 System 里的格式示例写',
    properties: {
        summary: {
            type: 'object',
            properties: { meta: { type: 'array', items: text() }, canvas: text(), caption: text() },
        },
        items: {
            type: 'array',
            items: {
                type: 'object',
                properties: { label: text('object / character / text'), caption: text(), text: text('文字框里的字'), bbox: { type: 'array', items: { type: 'number' } } },
            },
        },
    },
};

/**
 * The tool: every field of the output format as a parameter, none required (each request asks for its own; the
 * System prompt says which). Plain types only, which every provider's tool format takes.
 */
const TOOL = {
    type: 'function',
    function: {
        name: TOOL_NAME,
        description: '提交这一楼的配图结果：System 要求输出的 JSON 里的每个字段作为参数传入，用不到的字段不传。',
        parameters: {
            type: 'object',
            properties: {
                skip: { type: 'boolean', description: '这一楼不出图时为 true' },
                reason: text('不出图的原因'),
                target: text('画面主角'),
                absent: { type: 'boolean', description: '画谁不在画面里' },
                looks: text('改画的人的外貌'),
                now_doing: text(),
                now_wearing: text(),
                pending: text(),
                ...PICTURE,
                aspect: text('宽高比'),
                place: text('图插在第几段后面（段落编号）'),
                start: text('这一段从第几段开始（段落编号）'),
                earlier_scenes: {
                    type: 'array',
                    description: '多张图：前面几段各自的画面',
                    items: {
                        type: 'object',
                        properties: { label: text(), start: text(), place: text(), absent: { type: 'boolean' }, target: text(), looks: text(), ...PICTURE },
                    },
                },
                layout: LAYOUT,
                pages: {
                    type: 'array',
                    description: '漫画模式画几页时的每一页',
                    items: { type: 'object', properties: { label: text(), start: text(), place: text(), layout: LAYOUT } },
                },
            },
        },
    },
};

/**
 * Whether this request asks for the tool: the switch on, with the independent API or the plug (SillyTavern's server
 * passes the tool on, as Gemini's function declarations for Google AI Studio / Vertex AI).
 */
export function usesTool(parser = getSettings().parser) {
    return (parser.source === 'custom' || parser.source === 'plug') && !!parser.toolCall;
}

/** Request-body fields for the tool, or none. The user's own 「附加请求参数」 are merged after these. */
export function toolBody(parser = getSettings().parser) {
    if (!usesTool(parser)) return {};
    return { tools: [TOOL], tool_choice: parser.toolChoice === 'required' ? 'required' : 'auto' };
}

/**
 * The tool for an API with a format of its own (Gemini on Vertex AI): its declaration (name, description,
 * parameters) and whether calling it is required; null when it is not used.
 */
export function toolDeclaration(parser = getSettings().parser) {
    return usesTool(parser) ? { declaration: structuredClone(TOOL.function), required: parser.toolChoice === 'required' } : null;
}

/** Added to the System prompt: hand the result over with the tool, not as text. */
export const TOOL_RULE = `输出方式（优先于上面「只输出 JSON」的要求）：调用 ${TOOL_NAME} 工具提交结果——上面要求的 JSON 里的每个字段作为这个工具的参数传入（JSON 示例怎么写，参数就怎么填；用不到的字段不传），正文里不要写 JSON 或提示词。不出图时同样用这个工具提交 skip 和 reason。`;

/** The last words of the User message with the tool. */
export const TOOL_REMINDER = `【输出方式】调用 ${TOOL_NAME} 工具提交结果，不要在正文里写 JSON。`;

/**
 * The arguments of the parser's tool call in a chat completion message, as JSON text ('' without one). Arguments
 * come as a JSON string from OpenAI-style APIs; some give an object.
 */
export function toolArguments(message) {
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    const call = calls.find(item => item?.function?.name === TOOL_NAME) ?? calls[0];
    const args = call?.function?.arguments;
    if (args === undefined || args === null) return '';
    return typeof args === 'string' ? args : JSON.stringify(args);
}
