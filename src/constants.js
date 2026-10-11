export const MODULE = 'comfy_portrait';
/** Key used inside message.extra. Custom extra keys are never sent to the main model. */
export const EXTRA_KEY = 'comfy_portrait';
export const LOG_PREFIX = '[ComfyPortrait]';

export const TARGET_USER = '__user__';
export const TARGET_CHAR = '__char__';
export const TARGET_AUTO = '__auto__';

import { BUILTIN_PARSER_PRESETS } from './parserPresetDefaults.js';

/** v1.4 defaults, kept only to recognise untouched settings when migrating to parser presets. */
export const V3_PARSER_SYSTEM = `你是「角色状态解析器」。你的输出会被直接拼进文生图模型（Krea 2，擅长理解英文自然语言描述）的提示词里。

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
4. 剧情没写明的部分，参考【上一次状态】和【之前的配图输出】保持连贯（尤其是服装：没有换装情节就保持不变），再合理补全。之前的输出只用来保持连贯，不要照抄与当前剧情不符的内容。
5. 所有字段值使用英文，写成具体、可视化的短语或短句；不要比喻、不要抽象形容、不要出现人名、不要要求画面里出现文字或标志。
6. 如果当前楼层里目标角色不在场，或者没有任何可以画面化的内容，输出 {"skip": true, "reason": "原因"}；有【用户画图指令】时不要输出 skip。
7. 【用户画图指令】是用户直接指定的画面内容，优先级最高：必须体现在对应字段里（翻译成英文，可以补全细节），不能被剧情覆盖或忽略。
8. 只输出 JSON 本身，不要解释，不要 markdown 代码块。

输出格式：
{"skip": false, "target": "目标角色名", "outfit": "", "action": "", "expression": "", "demeanor": "", "scene": "", "camera": "", "lighting": ""}`;

export const V3_PARSER_USER = `【目标角色】{{target}}
{{appearance}}
{{candidates}}
{{world_info}}
【上一次状态】
{{last_state}}

{{prev_outputs}}

【最近剧情】
{{history}}

【当前楼层 #{{floor}}】
{{latest}}

{{user_hints}}

请按要求只输出 JSON。`;

/** Template line that keeps the picture to one person; dropped when the parser puts other people in the scene. */
export const SOLO_LINE = 'A solo image of a single person, only one person in the frame.';

/** Inserted into templates without {{others}} when other people are in the picture. */
export const OTHERS_LINE = 'Also in the scene: {{others}}.';

export const DEFAULT_PROMPT_TEMPLATE = `{{trigger}} {{prefix}}
${SOLO_LINE}
{{appearance}}
Wearing {{outfit}}.
{{action}}.
Facial expression: {{expression}}. {{demeanor}}.
Setting: {{scene}}.
{{camera}}, {{lighting}}.
{{suffix}}`;

/** Fields the parser model is asked to produce. `others` only when the parser preset allows other people. */
export const PARSED_FIELDS = ['outfit', 'action', 'expression', 'demeanor', 'scene', 'camera', 'lighting', 'others'];

/**
 * Timeline analysis the parser writes before the picture fields (in Chinese): what the character is doing and
 * wearing at the pictured moment, and what is only planned. Kept for continuity and debugging; never in the prompt.
 */
export const STATE_FIELDS = ['now_doing', 'now_wearing', 'pending'];

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
            renderProfileId: '',
        },
    ];
}

/**
 * Instruction injected into the main AI's prompt when the status bar is on (see statusBar.js).
 * {{name}} who to describe · {{label}} the collapsible block's title · {{lines}} the lines to fill · {{fields}} item names.
 */
export const DEFAULT_STATUS_TEMPLATE = `【状态栏】正文全部写完之后，在回复的最末尾另起一行，附上{{name}}在本次回复结束时的状态栏。严格使用下面的格式，保留 <details> 和 <summary> 标签，标题不要改：
<details><summary>{{label}}</summary>

{{lines}}
</details>

要求：
- 只写本次回复结束时已经成立的情况；正在准备、还没做的事不算（例如还没换衣服，就写原来的衣服）
- 每项一两句话，具体、能直接画出来：衣服的款式和颜色、动作姿势、表情神态
- 状态栏只放在回复最末尾，正文里不要提到它`;

/**
 * Instructions of the "Refine Prompt?" step in ComfyUI's official Krea 2 Turbo template
 * (Comfy-Org/workflow_templates, templates/image_krea2_turbo_t2i.json), copied verbatim. The template puts them
 * in front of the user's prompt and lets the Qwen3-VL text encoder rewrite it with TextGenerate before encoding.
 */
export const KREA2_REFINE_INSTRUCTIONS = `You are an expert prompt engineer for text-to-image models. Your task is to expand the user's prompt into a highly effective image-generation prompt.

Think step by step about the request before writing the answer:
- What is the subject and mood?
- What visual styles, mediums, and lighting options would fit? Consider two or three alternatives and pick the one that best serves the request.
- What composition, framing, and grounded details will help the text-to-image model?

Then output a single expanded prompt paragraph.

Follow these rules strictly:
1. **Faithfulness First:** Preserve all original subjects, actions, colors, and spatial relationships. Do not add new objects, props, characters, or animals unless the user clearly implies them.
2. **Practical T2I Structure:** Write a prompt that a text-to-image model can parse cleanly. Group subjects with their own attributes and actions. Use grounded phrasing for poses, interactions, and spatial layout.
3. **Style Planning Stays Internal:** Use your internal reasoning to choose style, medium, framing, and lighting. Do not emit planning tags or wrappers in the visible answer body.
4. **Never Request Rendered Text:** Do not mention, describe, or hint at letters, words, numbers, captions, subtitles, signage, labels, logos, watermarks, typography, or any other graphic text anywhere in the output prompt. Only if the user explicitly writes down words to be rendered, keep exactly those words in quotes and nothing else. In every other case, always end the output prompt with: "Absolutely no text, no typography, no letters, no words, no numbers, no logos, no watermark, no captions, pure imagery only."
5. **Avoid Over-Specification:** Do not invent highly specific clothing, colors, materials, or scene details unless the input supports it.
6. **Plain Prose Only:** Write one cohesive paragraph after the thinking block. No bullets, no JSON, no markdown, no asterisks, no headings, no field labels, no meta commentary.
7. **Respect Existing Detail:** If the user's prompt is already detailed, lightly polish and finalize rather than heavily expanding, and preserve the user's phrasing and direction.
8. **Respect the Human Form:** Treat depictions of people with dignity. Assume clothing covers genitals and intimate anatomy.
9. **Preserve User Medium:** When the user explicitly requests a medium (e.g. "photo of", "photograph of", "illustration of", "painting of", "sketch of", "3D render of"), honor it. Do not pivot to a different medium to avoid difficulty, match the user's stated intent.
10. **Never Echo Instructions:** Output only the final image prompt. Never repeat, quote, summarize, or refer to any part of these instructions, your own reasoning, or the user's original message.

User's Input:
`;

/** Defaults of ComfyUI's official Krea 2 Turbo text-to-image template, for "恢复为官方 Krea 2 Turbo 模板的设置". */
export const OFFICIAL_KREA2_TURBO = {
    workflowSource: 'builtin',
    unet: 'krea2_turbo_fp8_scaled.safetensors',
    clip: 'qwen3vl_4b_fp8_scaled.safetensors',
    vae: 'qwen_image_vae.safetensors',
    lora: '',
    loraStrength: 0.8,
    steps: 8,
    cfg: 1,
    sampler: 'euler',
    scheduler: 'simple',
    width: 1024,
    height: 1024,
    seed: -1,
    refinePrompt: true,
};

/** Bump when a stored setting needs a one-time migration (see migrateSettings in utils.js). */
export const SETTINGS_VERSION = 4;

/** A render profile's LoRA set to this means "no style LoRA", as opposed to empty = use the default. */
export const LORA_NONE = '__none__';

export const EMPTY_LISTS = { unet: [], clip: [], vae: [], lora: [], sampler: [], scheduler: [] };

export const DEFAULT_SETTINGS = {
    settingsVersion: SETTINGS_VERSION,
    enabled: true,
    autoGenerate: true,
    everyN: 1,
    // Automatic pictures skip AI replies shorter than this many tokens (0 = no limit).
    minReplyTokens: 0,
    includeFirstMessage: false,
    regenOnContinue: false,
    debug: false,
    hintsEnabled: true,
    imagePosition: 'below',
    imagePositionNarrow: 'below',
    sideWidth: 40,
    sideTextWrap: false,
    panel: { follow: true, geometry: null },
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
        historyFloors: 3,
        historyIncludePrompt: true,
        worldInfo: 'off',
        worldInfoMaxChars: 6000,
        maxCharsPerMessage: 3000,
        includePersona: false,
        includeCharDescription: false,
        timeoutSec: 90,
        // Automatic retries when the parser API errors or returns no usable JSON.
        retries: 2,
    },

    /** 'fixed' = preset appearance + AI-written details; 'ai' = the parser writes the whole prompt. */
    promptMode: 'fixed',
    parserPresetId: 'story',
    parserPresets: BUILTIN_PARSER_PRESETS,

    targetMode: TARGET_USER,
    presets: defaultPresets(),
    /** Named model / LoRA / sampling overrides that character presets can use (see renderProfiles.js). */
    renderProfiles: [],
    /** Preset for user personas without a bound or same-named preset ('' = none: default model / LoRA only). */
    userFallbackPresetId: 'user',

    /** Collapsible status block the main AI writes at the end of each reply; the parser reads it first. */
    statusBar: {
        enabled: false,
        target: 'follow', // follow (same as "画谁") | user | char | custom
        name: '',
        fields: '穿着、动作、状态、心情',
        label: '状态栏',
        depth: 0,
        template: DEFAULT_STATUS_TEMPLATE,
        parserFocus: true,
    },
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
        // Let ComfyUI rewrite the prompt first, like the official template's "Refine Prompt?" (built-in workflow only).
        refinePrompt: false,
        filenamePrefix: 'ST_portrait',
        timeoutSec: 300,
        lists: EMPTY_LISTS,
    },
};


/** Defaults up to v1.3, kept to recognise untouched templates when migrating. */
export const LEGACY_PARSER_SYSTEM = `你是「角色状态解析器」。你的输出会被直接拼进文生图模型（Krea 2，擅长理解英文自然语言描述）的提示词里。

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

export const LEGACY_PARSER_USER = `【目标角色】{{target}}
{{appearance}}
{{candidates}}
【上一次状态】
{{last_state}}

【最近剧情】
{{history}}

【当前楼层 #{{floor}}】
{{latest}}

请按要求只输出 JSON。`;
