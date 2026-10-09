export const MODULE = 'comfy_portrait';
/** Key used inside message.extra. Custom extra keys are never sent to the main model. */
export const EXTRA_KEY = 'comfy_portrait';
export const LOG_PREFIX = '[ComfyPortrait]';

export const TARGET_USER = '__user__';
export const TARGET_CHAR = '__char__';
export const TARGET_AUTO = '__auto__';

export const DEFAULT_PARSER_SYSTEM = `你是「角色状态解析器」。你的输出会被直接拼进文生图模型（Krea 2，擅长理解英文自然语言描述）的提示词里。

任务：阅读给出的剧情，判断【目标角色】在【当前楼层】结束时刻的视觉状态，输出一个 JSON 对象。

规则：
1. 画面中只有目标角色一个人。不要描写任何其他人物，也不要让其他人物的身体部位入镜。
2. 目标角色的固定外貌（发型、发色、瞳色、五官、肤色、体型等）已由用户预设，不要描写、也不要改动这些内容。
3. 你需要推断并描写：
   - outfit：此刻的穿着（款式、颜色、材质、配饰、穿着状态），要具体
   - action：身体姿势与动作、手部动作、与道具或环境的互动
   - expression：面部表情（眉眼、嘴角、视线方向）
   - demeanor：神态与气质、情绪、肢体语言给人的感觉
   - scene：所处场景与背景细节、时间、天气
   - camera：景别与构图（如 medium shot、full body shot、close-up，以及机位角度）
   - lighting：光线与色调
4. 剧情没写明的部分，参考【上一次状态】保持连贯（尤其是服装：没有换装情节就保持不变），再合理补全。
5. 所有字段值使用英文，写成具体、可视化的短语或短句；不要比喻、不要抽象形容、不要出现人名、不要要求画面里出现文字或标志。
6. 如果当前楼层里目标角色不在场，或者没有任何可以画面化的内容，输出 {"skip": true, "reason": "原因"}。
7. 只输出 JSON 本身，不要解释，不要 markdown 代码块。

输出格式：
{"skip": false, "target": "目标角色名", "outfit": "", "action": "", "expression": "", "demeanor": "", "scene": "", "camera": "", "lighting": ""}`;

export const DEFAULT_PARSER_USER = `【目标角色】{{target}}
{{appearance}}
{{candidates}}
【上一次状态】
{{last_state}}

【最近剧情】
{{history}}

【当前楼层 #{{floor}}】
{{latest}}

请按要求只输出 JSON。`;

export const DEFAULT_PROMPT_TEMPLATE = `{{trigger}} {{prefix}}
A solo image of a single person, only one person in the frame.
{{appearance}}
Wearing {{outfit}}.
{{action}}.
Facial expression: {{expression}}. {{demeanor}}.
Setting: {{scene}}.
{{camera}}, {{lighting}}.
{{suffix}}`;

/** Fields the parser model is asked to produce. */
export const PARSED_FIELDS = ['outfit', 'action', 'expression', 'demeanor', 'scene', 'camera', 'lighting'];

export const RESOLUTION_PRESETS = [
    { label: '竖 832×1216', w: 832, h: 1216 },
    { label: '竖 896×1152', w: 896, h: 1152 },
    { label: '竖 768×1344', w: 768, h: 1344 },
    { label: '竖 1088×1920', w: 1088, h: 1920 },
    { label: '方 1024×1024', w: 1024, h: 1024 },
    { label: '方 1536×1536', w: 1536, h: 1536 },
    { label: '横 1216×832', w: 1216, h: 832 },
    { label: '横 1152×896', w: 1152, h: 896 },
    { label: '横 1344×768', w: 1344, h: 768 },
    { label: '横 1920×1088', w: 1920, h: 1088 },
];

export function makeId() {
    return Math.random().toString(36).slice(2, 10);
}

export function defaultPresets() {
    return [
        {
            id: 'user',
            name: '{{user}}',
            aliases: '',
            appearance: 'a young woman in her early twenties with long straight black hair reaching her waist, blunt bangs, amber eyes, a small beauty mark under her left eye, fair skin, slender build',
            trigger: '',
            lora: '',
            loraStrength: 0.8,
            negative: '',
            personas: [],
        },
    ];
}

/** Bump when a stored setting needs a one-time migration (see migrateSettings in utils.js). */
export const SETTINGS_VERSION = 2;

export const EMPTY_LISTS = { unet: [], clip: [], vae: [], lora: [], sampler: [], scheduler: [] };

export const DEFAULT_SETTINGS = {
    settingsVersion: SETTINGS_VERSION,
    enabled: true,
    autoGenerate: true,
    everyN: 1,
    includeFirstMessage: false,
    regenOnContinue: false,
    debug: false,
    imagePosition: 'below',
    imagePositionNarrow: 'below',
    sideWidth: 40,
    sideTextWrap: false,
    imageMaxWidth: 480,
    maxVersions: 10,

    parser: {
        source: 'custom',
        customUrl: 'https://api.deepseek.com/v1',
        customKey: '',
        customModel: 'deepseek-chat',
        profileId: '',
        temperature: 0.6,
        maxTokens: 2048,
        extraBody: '',
        models: [],
        contextDepth: 4,
        maxCharsPerMessage: 3000,
        includePersona: false,
        includeCharDescription: false,
        timeoutSec: 90,
        systemPrompt: DEFAULT_PARSER_SYSTEM,
        userTemplate: DEFAULT_PARSER_USER,
    },

    targetMode: TARGET_USER,
    presets: defaultPresets(),
    continuity: true,

    promptTemplate: DEFAULT_PROMPT_TEMPLATE,
    prefix: '',
    suffix: '',
    negativePrompt: '',

    comfy: {
        url: 'http://127.0.0.1:8188',
        browserUrl: '',
        mode: 'proxy',
        workflowSource: 'builtin',
        workflow: '',
        width: 832,
        height: 1216,
        steps: 8,
        cfg: 1,
        sampler: 'euler',
        scheduler: 'simple',
        seed: -1,
        unet: 'krea2_turbo_fp8_scaled.safetensors',
        clip: 'qwen3vl_4b_fp8_scaled.safetensors',
        vae: 'qwen_image_vae.safetensors',
        lora: '',
        loraStrength: 0.8,
        filenamePrefix: 'ST_portrait',
        timeoutSec: 300,
        lists: EMPTY_LISTS,
    },
};
