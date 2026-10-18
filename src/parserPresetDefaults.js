/**
 * Built-in parser presets (the instructions sent to the parser model). Pure data, no imports.
 *
 * A preset's system prompt contains {{output_rules}}; it is replaced by the output rules of the prompt mode
 * (buildOutputRules), so every preset works in both modes.
 *
 * Each image model mode has its own copy of the built-ins (same ids, so 'story' always exists): Krea 2 reads
 * natural English, Anima (an anime model) reads Danbooru-style tags, so the language rules differ.
 */

/** Wording that depends on the image model. */
const MODEL_TEXT = {
    krea2: {
        model: '文生图模型（Krea 2，擅长理解英文自然语言描述）',
        language: '所有字段值使用英文，写成具体、可视化的短语或短句',
        camera: '如 medium shot、full body shot、close-up，以及机位角度',
        others: '英文，自然语言',
    },
    anima: {
        model: '动漫文生图模型（Anima，用 Danbooru 风格的英文标签和英文描述训练）',
        language: '所有字段值使用英文 Danbooru 风格标签（小写，用空格代替下划线，例如 long hair、school uniform、looking at viewer；多个标签用英文逗号隔开，标签说不清的细节可以补一个很短的英文短语）',
        camera: '如 upper body、cowboy shot、full body、close-up，以及 from above、from side 等机位',
        others: '英文 Danbooru 风格标签，每人一组，先写 1boy / 1girl 这样的人数标签',
    },
    /** Anima with the "英文自然语言" switch: the same model, written to in plain English sentences. */
    'anima-natural': {
        model: '动漫文生图模型（Anima，能理解英文自然语言描述，也认识 Danbooru 标签）',
        language: '所有字段值使用英文自然语言，写成具体、可视化的短语或短句（不要写成逗号分隔的标签串）',
        camera: '如 medium shot、full body shot、close-up，以及从上往下、侧面等机位',
        others: '英文，自然语言',
    },
};

/**
 * Appended to the system prompt in Anima's natural-language mode. Built-in and saved parser presets were written
 * for tags, so this overrides their wording for this request.
 */
export const NATURAL_STYLE_RULE = `写法（优先于上面所有关于 Danbooru 标签的要求）：这次所有画面字段和 prompt 都用英文自然语言来写——具体、可视化的短语或完整的句子，像描述一张插画那样连贯地写，不要写成逗号分隔的 Danbooru 标签串（例如写 "a red wool coat buttoned to the neck"，不要写 "red coat, buttons"）。人数可以在 prompt 开头用一句话说明，例如 "A solo illustration of one girl"。`;

function modelText(model) {
    return MODEL_TEXT[model] ?? MODEL_TEXT.krea2;
}

export const PARSER_USER_TEMPLATE = `【目标角色】{{target}}
{{appearance}}
{{candidates}}
{{world_info}}
{{fixed_fields}}
【上一次状态】
{{last_state}}

{{prev_outputs}}

【最近剧情】
{{history}}

【当前楼层 #{{floor}}】
{{latest}}

{{status_bar}}

{{user_hints}}

请按要求只输出 JSON。`;

/**
 * Shared by both output modes: plans and intentions are not events. Without this, models draw "she is about to
 * change and go to dinner" as already changed and eating.
 */
const TIMELINE_RULES = `时间线（最重要，先想清楚再写画面）：
- 画面时刻就是任务里说的那个时刻（通常是【当前楼层】结束的那一刻；需要挑瞬间的预设，也只能挑正文真正写到的瞬间）。只画到这一刻为止已经发生、或正在进行的事。
- 「准备、打算、想要、要去、正要、待会、等一下、马上、决定去、说要、起身去……」这类只是计划或意图。正文没有写到做完，就当作还没发生，画面保持之前的状态。
  例：正文写到「她说先去换件衣服，然后一起去吃饭」就结束了 → 她还穿着原来的衣服、还在原来的地方，不能画成已经换好衣服，也不能画成正在吃饭。
- 换装：只有正文明确写到已经换好（或画面时刻正在换）才算换了；否则服装和【上一次状态】/【之前的配图输出】里的穿着保持一致。
- 【之前的配图输出】里的 pending 是当时还没做的事：只有当前楼层的正文写到它做完了，才算完成。
- 【用户画图指令】优先级最高，不受这条限制。

JSON 里先写三个分析字段，再根据它们写画面字段。这三个字段是例外：用中文简短地写，只用来分析和检查，不会进提示词（画面字段照常用英文）：
- now_doing：画面时刻角色实际在做什么（只写已经发生或正在进行的）
- now_wearing：画面时刻角色身上实际穿着什么（还没换就写原来的衣服）
- pending：正文里提到、但到画面时刻还没做或还没做完的事（准备、打算、即将要做的）；没有就写「无」
画面字段必须和 now_doing、now_wearing 一致，pending 里的事一律不能画进画面。`;

const APPEARANCE_FIXED = '外貌：目标角色的固定外貌（发型、发色、瞳色、五官、肤色、体型等）已由用户预设，会自动加进提示词，你不要描写、也不要改动这些内容。';

const APPEARANCE_AI = '外貌：【角色设定】是这个角色的固定外貌，必须完整、准确地写进 prompt（翻译成英文），不能遗漏或改动；没有角色设定时根据剧情合理描写。';

/** Only for presets that allow other people; overrides the "only the target" rule of the preset's own prompt. */
function othersRules(model) {
    return `其他人物：这个预设允许画面里出现其他人物，前面「画面中只有目标角色一个人 / 其他人物不要入镜」的要求在这里不适用：
- 目标角色仍是画面主角；outfit、action、expression、demeanor 只写目标角色
- 画面时刻和目标角色在同一个场景、参与这一幕的其他人物可以画进来，最多 3 人；不在场或和这一幕无关的人不要画
- 把他们写进 others（${modelText(model).others}）：每人写外貌（性别、年龄感、发型发色、体型）、穿着、在画面中的位置、动作和表情，不写人名；【可能同框的其他角色】里给了外貌的人，照着那个外貌写
- 没有其他人同框时，others 留空`;
}

function promptRule(allowOthers, model) {
    if (model === 'anima-natural') {
        const order = allowOthers
            ? '开头说明画面里有几个人、谁是主角；先完整写主角的外貌、服装、动作姿势、表情神态，再写 others 里每个人的样子和位置，最后写镜头构图、场景环境、光线色彩'
            : '开头说明画面中只有一个人，然后依次写角色外貌、服装、动作姿势、表情神态、镜头构图、场景环境、光线色彩';
        return `除了上面的字段，还要写 prompt：一段完整、流畅的英文画面描述（自然语言，适合 Anima 这样的动漫插画模型）。${order}；【固定内容】里的字段必须原样体现。画质 / 评分标签（masterpiece、best quality、score_7 等）由程序自动加，不要写。不要写人名，不要要求画面里出现文字。`;
    }
    if (model === 'anima') {
        const order = allowOthers
            ? '先写人数标签（如 1girl, 1boy 或 2girls），然后先完整写主角的外貌、服装、表情、动作姿势，再写 others 里每个人的样子和位置，最后写构图镜头、背景场景、光影'
            : '先写 1girl / 1boy 这样的人数标签和 solo，然后依次写角色外貌、服装、表情、动作姿势、构图镜头、背景场景、光影';
        return `除了上面的字段，还要写 prompt：一串英文 Danbooru 风格标签（小写，用空格代替下划线，英文逗号隔开，最后可以补一两句简短的英文描述），适合 Anima。${order}；【固定内容】里的字段必须原样体现。画质 / 评分标签（masterpiece、best quality、score_7 等）由程序自动加，不要写。不要写人名，不要要求画面里出现文字。`;
    }
    const order = allowOthers
        ? '开头说明画面里有几个人、谁是主角；先完整写主角的外貌、服装、动作姿势、表情神态，再写 others 里每个人的样子和位置，最后写镜头构图、场景环境、光线色彩'
        : '开头说明画面中只有一个人，然后依次写角色外貌、服装、动作姿势、表情神态、镜头构图、场景环境、光线色彩';
    return `除了上面的字段，还要写 prompt：一段完整、流畅的英文画面描述（自然语言，适合 Krea 2）。${order}；【固定内容】里的字段必须原样体现。不要写人名，不要要求画面里出现文字。`;
}

/**
 * Only when the parser fills in the negative prompt (setting parserNegative, on in Anima): what the picture must
 * not show. The extension adds it after the global negative prompt and drops tags that are in the positive prompt.
 */
function negativeRules(model) {
    // Negative prompts stay tag lists in Anima, also when the positive one is written in sentences.
    const style = String(model).startsWith('anima')
        ? '英文 Danbooru 风格标签（小写，用空格代替下划线），逗号隔开'
        : '英文短语，逗号隔开';
    return `反向提示词：再写 negative，列出这张图里不该出现、模型容易画错的东西，${style}：
- 按这个画面写：画面只有一个人时写 multiple girls、multiple boys 这类多人标签；角色此刻没穿戴、但模型容易加上的衣物或配饰；和场景、时间不符的东西；pending 里还没发生的动作或道具
- 针对这张图实际可能出错的地方写，不要堆砌。人物画面常见的问题有 duplicate person、extra arms、extra legs、extra fingers、fused fingers、malformed hands、duplicated limbs、multiple faces、ghosting、afterimage、duplicated body、bad proportions、cropped head，按画面的实际风险挑着用（例如手部动作复杂写手部相关的，翘腿、交叉腿写 extra legs，动作幅度大写 ghosting、afterimage）
- 不要写画面本来就要画的内容（例如画面要画 smile，就不能写 smile），也不要写会和正向字段冲突的词
- 画质类的通用反向词（worst quality、low quality、score_1、blurry 等）程序会自动加，不要写
- 最多 15 个，没有需要补充的就写空字符串 ""（不要写「无」或 none）`;
}

/**
 * Only when the parser picks the picture's aspect ratio (resolution selector + parserAspect): the ratio list and
 * which compositions suit which. The pixel count stays as set.
 * @param {{ ratios: string[], fallback: string }} aspect
 */
function aspectRules(aspect) {
    return `宽高比：再写 aspect，为这张图选一个最合适的宽高比，只能从 ${aspect.ratios.join('、')} 里选一个，原样写（例如 "2:3"）：
- 全身、站姿 → 2:3 或 9:16；半身、上半身 → 3:4 或 2:3；脸部特写 → 1:1 或 3:4
- 环境占比大、横向展开的场景、几个人并排 → 3:2、16:9 或 21:9
- 拿不准就写 ${aspect.fallback}`;
}

/**
 * Only with 多张图 (parser.multiScene): a floor whose text moves on to another time or place gets a picture for
 * each earlier part as well, in `earlier_scenes`; the main fields stay the end of the floor.
 * @param {number} scenes Pictures per floor at most, the end of the floor included
 */
function scenesRules(scenes, mode = 'fixed', allowOthers = false, negative = false) {
    const fields = ['outfit', 'action', 'expression', 'demeanor', 'scene', 'camera', 'lighting'];
    if (allowOthers) fields.push('others');
    if (mode === 'ai') fields.push('prompt');
    if (negative) fields.push('negative');
    return `多张图：这一楼的正文如果明显分成了前后几个时间段或场景（例如前半段是晚上，后半段跳到了第二天早上；或者从酒馆换到了森林），除了主字段写的结束时刻这一张，再为前面的每一段各写一张，按时间顺序放进 earlier_scenes（最多 ${scenes - 1} 个）：
- 只有时间、地点或画面明显变化才分开；整段都是同一个时间段、同一个场景时，earlier_scenes 写 []（只出一张图）
- 每一段是一个对象：label（中文，几个字说明是哪一段，例如「前半段·深夜」）；start（这一段在【当前楼层】正文里开头的那句话，原样复制开头的 10～20 个字，用原文的语言，不要翻译、改写或概括，用来把图插到正文里对应的位置；第一段就复制正文开头那句）；再加上和主字段一样的画面字段（${fields.join('、')}），全部按那一段当时的情况写，规则和长度限制都一样；那一段的衣服、地点、光线和结束时刻不一样，就按那一段写
- 主字段永远写结束时刻（最后一段），不要再放进 earlier_scenes；顶层再写一个 start：最后这一段在正文里开头的那句话，同样原样复制开头的 10～20 个字。earlier_scenes 是 [] 时，顶层 start 写 ""
- 「画面时刻是当前楼层结束的那一刻」只管主字段；earlier_scenes 画的就是前面已经发生过的那几段`;
}

/**
 * For a custom system prompt without {{output_rules}} that keeps its own output format: only the rules of the
 * extra fields asked for (negative, aspect, earlier scenes), plus the fields to add to that format.
 */
export function extraOnlyRules(model, negative = false, aspect = null, scenes = 0) {
    const fields = [
        negative ? '"negative"（字符串，没有就写 ""）' : '',
        aspect ? '"aspect"（字符串，例如 "2:3"）' : '',
        scenes > 1 ? '"start"（字符串，没有分段就写 ""）、"earlier_scenes"（数组，没有就写 []）' : '',
    ].filter(Boolean);
    return [
        negative ? negativeRules(model) : '',
        aspect ? aspectRules(aspect) : '',
        scenes > 1 ? scenesRules(scenes, 'fixed', false, negative) : '',
        `在你输出的 JSON 里再加 ${fields.join('、')} 字段。`,
    ].filter(Boolean).join('\n\n');
}

function outputFormat(mode, allowOthers, negative = false, aspect = null, scenes = 0) {
    const fields = [
        '"skip": false', '"target": "目标角色名"', '"now_doing": ""', '"now_wearing": ""', '"pending": ""',
        '"outfit": ""', '"action": ""', '"expression": ""', '"demeanor": ""', '"scene": ""', '"camera": ""', '"lighting": ""',
    ];
    if (allowOthers) fields.push('"others": ""');
    if (negative) fields.push('"negative": ""');
    if (aspect) fields.push(`"aspect": "${aspect.fallback}"`);
    if (mode === 'ai') fields.push('"prompt": "完整的英文提示词"');
    if (scenes > 1) fields.push('"start": ""', '"earlier_scenes": []');
    return `输出格式：\n{${fields.join(', ')}}`;
}

/**
 * The rules that replace {{output_rules}} in a preset's system prompt.
 * - mode "fixed": the preset's appearance is added to the prompt by the extension.
 * - mode "ai": the appearance is handed to the model, which must work it into `prompt`.
 * - allowOthers: other people in the scene may be drawn too (field `others`).
 * - model: the image model mode ('krea2' natural language, 'anima' Danbooru tags).
 * - negative: the parser also writes a negative prompt for this picture (field `negative`).
 * - aspect: { ratios, fallback } when the parser picks the aspect ratio (field `aspect`).
 * - scenes: with 多张图, pictures per floor at most (field `earlier_scenes`); 0 = one picture.
 */
export function buildOutputRules(mode, allowOthers = false, model = 'krea2', negative = false, aspect = null, scenes = 0) {
    return [
        TIMELINE_RULES,
        mode === 'ai' ? APPEARANCE_AI : APPEARANCE_FIXED,
        allowOthers ? othersRules(model) : '',
        mode === 'ai' ? promptRule(allowOthers, model) : '',
        negative ? negativeRules(model) : '',
        aspect ? aspectRules(aspect) : '',
        scenes > 1 ? scenesRules(scenes, mode, allowOthers, negative) : '',
        outputFormat(mode, allowOthers, negative, aspect, scenes),
    ].filter(Boolean).join('\n\n');
}

export const OUTPUT_RULES_FIXED = buildOutputRules('fixed');
export const OUTPUT_RULES_AI = buildOutputRules('ai');

/**
 * What the story prompt says per image model: how to write, length limits (upper bounds, so the prompt stays
 * short and the action and outfit carry the weight) and setting examples. Anima counts tags; its natural-language
 * switch adds NATURAL_STYLE_RULE after the preset, so the word counts are given too.
 */
const STORY_TEXT = {
    krea2: {
        style: '不要堆砌关键词，也不要写 beautiful、masterpiece、best quality、highly detailed 这类没有画面信息的词',
        limit: n => `最多 ${n.words} 个英文单词`,
        scene: '"a medieval tavern"、"a modern bedroom"、"a fantasy forest at night"',
    },
    anima: {
        style: '按 Danbooru 标签的习惯写，一个标签只说一件事，常用标签优先；画质 / 评分标签（masterpiece、best quality、score_7 等）由程序自动加，不要写',
        limit: n => `最多 ${n.tags} 个标签（用自然语言写时最多 ${n.words} 个词）`,
        scene: '"medieval, tavern, indoors"、"modern, bedroom"、"fantasy, forest, night"',
    },
};

const LIMITS = {
    outfit: { tags: 6, words: 20 },
    action: { tags: 6, words: 25 },
    expression: { tags: 2, words: 6 },
    demeanor: { tags: 1, words: 3 },
    scene: { tags: 3, words: 6 },
    camera: { tags: 1, words: 3 },
    others: { tags: 8, words: 20 },
    prompt: { tags: 30, words: 60 },
};

function storySystem(model) {
    const text = modelText(model);
    const story = STORY_TEXT[model] ?? STORY_TEXT.krea2;
    const limit = field => story.limit(LIMITS[field]);
    return `你是一名专业的 AI 绘图提示词工程师，为${text.model}写提示词。读懂剧情，把【目标角色】在【当前楼层】结束时刻的画面，用最简短的话整理成下面几项，输出一个 JSON 对象。

不要繁琐：每项只抓要点，长度是上限不是目标，能更短就更短。多写的词只会冲淡重点，让模型画错。

只写这几项：
- 角色：就是【目标角色】，名字填在 target；外貌按下面「外貌」那一条处理，不用你另外描写
- 心情：demeanor 写心情，${limit('demeanor')}（如 happy、nervous）；expression 写脸上的表情和视线，${limit('expression')}
- 衣服：outfit 写此刻穿着的主要衣物和颜色，${limit('outfit')}
- 在做什么、什么动作：action 写此刻在做什么、身体姿势（站 / 坐 / 跪 / 蹲 / 躺）、手在做什么，${limit('action')}；不要只写 dynamic pose 这类笼统的词，也不要逐个肢体罗列
- 和谁：和别人一起时，在 action 里写出和谁在做什么（不写名字，写 a young man、an old woman 这类称呼）。输出格式里有 others 字段时，同框的人写进 others，每人${limit('others')}；没有 others 字段时，画面里只有目标角色一个人，对方不入镜，action 只写角色自己的动作
- 大概的环境：scene 只写时代或风格 + 地点类型，例如 ${story.scene}，${limit('scene')}；不要写楼层（第几楼、几层、xx 楼）、门牌号、地名、建筑名，也不要罗列家具和摆设
- camera 写一个景别（${text.camera}），${limit('camera')}；lighting 没有特别的光线就写 ""
- prompt（只在要求写 prompt 时）：不算角色设定的外貌，${limit('prompt')}；同样只写上面这几项

要点：
- 目标角色是画面主角。同一个人、同一件衣服只描述一次，不要换个说法重复写（重复描写容易画出重影、多人）
- 字段之间、字段和【固定内容】之间不能矛盾；【固定内容】里的字段原样使用
- ${text.language}；${story.style}
- 不要比喻、不要人名、不要写剧情的楼层编号（#12、第 12 楼这类）、不要要求画面里出现文字或标志、不要写画风词（画风由画风前缀和 LoRA 负责）
- 剧情没写明的部分，参考【上一次状态】和【之前的配图输出】保持连贯（尤其衣服：没有换装情节就不变）；之前的输出只用来保持连贯，不要照抄与当前剧情不符的内容
- 【用户画图指令】是用户直接指定的画面内容，优先级最高：必须体现在对应字段里（翻译成英文），不能被剧情覆盖或忽略
- 当前楼层里目标角色不在场，或者没有任何可以画面化的内容，输出 {"skip": true, "reason": "原因"}；有【用户画图指令】时不要输出 skip

只输出 JSON 本身，不要解释，不要 markdown 代码块。

{{output_rules}}`;
}

/** Fingerprint of a prompt text, to recognise earlier built-in prompts without keeping their whole text. */
function fingerprint(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `${text.length}:${hash.toString(16)}`;
}

/** Earlier built-in story prompts (up to v1.23, v1.24). */
const PREVIOUS_STORY = {
    krea2: ['807:cda41aea', '1532:d6d556eb'],
    anima: ['939:558892a3', '1641:584cb314'],
};

/** Whether a story preset still has an earlier built-in prompt nobody edited (it is upgraded, see migrateSettings). */
export function isPreviousStorySystem(text, model) {
    return typeof text === 'string' && (PREVIOUS_STORY[model] ?? []).includes(fingerprint(text));
}

function spriteSystem(model) {
    const text = modelText(model);
    return `你是「角色立绘设计师」。你的输出会被拼进${text.model}的提示词里，用来生成同一个角色的一组立绘：姿势、构图、背景都固定不变，只随剧情改变服装、表情和神态。

任务：阅读给出的剧情，判断【目标角色】在【当前楼层】结束时刻穿着什么、是什么表情和神态，输出一个 JSON 对象。

规则：
1. 画面中只有目标角色一个人，没有任何其他人物。
2. 姿势、镜头、背景、光线以【固定内容】为准，必须原样使用，不要根据剧情改动。剧情里的动作只体现在表情、神态和手里拿的小物件上。
3. 你需要根据剧情描写：
   - outfit：此刻完整的穿着（款式、颜色、材质、配饰），要具体；手里拿的东西写在末尾，例如 "holding a paper lantern"
   - expression：面部表情（眉眼、嘴角、视线方向）
   - demeanor：情绪与神态，以及在固定姿势范围内的细微肢体语言（例如微微歪头、手指交握）
   - 【固定内容】没有给出的其他字段，按「站姿全身立绘、纯色背景」补全
4. 服装：没有换装情节时，参考【上一次状态】和【之前的配图输出】保持不变。
5. 【用户画图指令】是用户直接指定的画面内容，优先级最高：必须体现在对应字段里（翻译成英文，可以补全细节）。
6. ${text.language}；不要比喻、不要出现人名、不要要求画面里出现文字或标志。
7. 立绘每一层都可以画：只要目标角色在剧情里出现过就不要输出 skip。
8. 只输出 JSON 本身，不要解释，不要 markdown 代码块。

{{output_rules}}`;
}

const SPRITE_FIXED_ANIMA = `action: standing, facing viewer, arms at sides, full body
camera: full body, straight-on, centered, eye level
scene: simple background, grey background, no other people
lighting: soft lighting`;

const SPRITE_FIXED = `action: standing upright and facing the viewer, full body visible from head to feet, arms relaxed at the sides
camera: full body shot, front view, centered composition, eye level
scene: plain light grey studio background, no props, no other people
lighting: soft even studio lighting`;

function novelSystem(model) {
    const text = modelText(model);
    return `你是「小说插画分镜师」。你的输出会被拼进${text.model}的提示词里，为当前这一层剧情画一张小说插画。

任务：从【当前楼层】里挑出最有画面感、最能代表这段情节的一个瞬间，以【目标角色】为画面中唯一的人物设计一张插画，输出一个 JSON 对象。

规则：
1. 画面中只有目标角色一个人；其他人物不要出现在画面里，可以用环境、光影、道具或视线方向暗示他们的存在。
2. 选情节里最关键、最有情绪张力的瞬间，而不是平淡的站立状态。
3. 你需要描写：
   - outfit：此刻的穿着（款式、颜色、材质、穿着状态），要具体
   - action：这个瞬间的动作和姿势，要有动态和叙事感
   - expression：面部表情（眉眼、嘴角、视线方向）
   - demeanor：情绪与氛围、肢体语言
   - scene：具体、有故事感的环境（地点、时间、天气、关键物件）
   - camera：像电影分镜一样选择景别和机位（远景 / 中景 / 特写，仰拍 / 俯拍 / 侧面），为情绪服务
   - lighting：有氛围的光线和色调（例如逆光、烛光、雨夜霓虹）
4. 剧情没写明的部分，参考【上一次状态】和【之前的配图输出】保持人物服装连贯。
5. 【固定内容】里列出的字段必须原样使用，不要改。
6. 【用户画图指令】是用户直接指定的画面内容，优先级最高：必须体现在对应字段里（翻译成英文，可以补全细节）。
7. ${text.language}；不要出现人名，不要要求画面里出现文字或标志。
8. 如果当前楼层没有任何可以画面化的情节，输出 {"skip": true, "reason": "原因"}；有【用户画图指令】时不要输出 skip。
9. 只输出 JSON 本身，不要解释，不要 markdown 代码块。

{{output_rules}}`;
}

/**
 * @typedef {Object} ParserPreset
 * @property {string} id
 * @property {string} name
 * @property {string} system System prompt; {{output_rules}} marks where the mode-specific rules go
 * @property {string} user User message template
 * @property {string} fixedFields "field: value" lines that stay the same on every image
 * @property {string} prefix Extra words placed after the global style prefix
 * @property {number} width Resolution override (0 = global setting)
 * @property {number} height
 * @property {boolean} [allowOthers] Other people in the scene may be drawn too (field `others`)
 */

function makeBuiltins(model) {
    const anima = model === 'anima';
    return [
        { id: 'story', name: '剧情状态（默认）', system: storySystem(model), user: PARSER_USER_TEMPLATE, fixedFields: '', prefix: '', width: 0, height: 0, allowOthers: true },
        { id: 'sprite', name: '立绘模式', system: spriteSystem(model), user: PARSER_USER_TEMPLATE, fixedFields: anima ? SPRITE_FIXED_ANIMA : SPRITE_FIXED, prefix: '', width: 0, height: 0, allowOthers: false },
        { id: 'novel', name: '小说插画模式', system: novelSystem(model), user: PARSER_USER_TEMPLATE, fixedFields: '', prefix: anima ? 'illustration, cinematic composition' : 'A narrative story illustration with cinematic composition.', width: 0, height: 0, allowOthers: false },
    ];
}

const BUILTINS = { krea2: makeBuiltins('krea2'), anima: makeBuiltins('anima') };

/**
 * The built-in presets of an image model mode ('krea2' or 'anima'). Shared objects: clone before changing them.
 * @returns {ParserPreset[]}
 */
export function builtinParserPresets(model = 'krea2') {
    return BUILTINS[model] ?? BUILTINS.krea2;
}

/** Krea 2's built-ins (also what settings from before the Anima mode were made with). */
export const BUILTIN_PARSER_PRESETS = BUILTINS.krea2;
export const ANIMA_PARSER_PRESETS = BUILTINS.anima;
