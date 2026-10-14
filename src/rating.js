/**
 * Automatic model choice by content rating: the main AI ends each reply with a hidden marker,
 * <!-- 画面:NSFW --> or <!-- 画面:SFW -->, and a floor is drawn with Anima (NSFW) or Krea 2 (SFW) accordingly.
 * HTML comments are not shown in the chat and never reach the parser (plainText drops them).
 */
import { MODEL_ANIMA, MODEL_KREA2 } from './constants.js';
import { ctx, getSettings } from './utils.js';

const PROMPT_KEY = 'comfy_portrait_rating';
// SillyTavern's extension_prompt_types.IN_CHAT and extension_prompt_roles.SYSTEM
const IN_CHAT = 1;
const ROLE_SYSTEM = 0;

export const RATING_INSTRUCTION = `【画面分级】正文写完后，在回复的最后另起一行，用一个 HTML 注释标记这次回复描写的画面是否含有露骨的性内容或裸露：
- 含有：写 <!-- 画面:NSFW -->
- 不含：写 <!-- 画面:SFW -->
只写这一行，原样照抄格式，不要解释，正文里也不要提到它。`;

/** Puts the instruction into (or takes it out of) the main AI's prompt, like the status bar's. */
export function updateRatingPrompt(type) {
    const { setExtensionPrompt } = ctx();
    if (typeof setExtensionPrompt !== 'function') return;
    const settings = getSettings();
    const active = settings.enabled && settings.autoModelByRating && !['quiet', 'impersonate'].includes(type);
    setExtensionPrompt(PROMPT_KEY, active ? RATING_INSTRUCTION : '', IN_CHAT, 0, false, ROLE_SYSTEM);
}

/** The last rating marker in a message: 'nsfw', 'sfw', or '' when there is none. */
export function readRating(text) {
    const matches = [...String(text ?? '').matchAll(/<!--\s*(?:画面|picture|rating)\s*[:：]\s*(NSFW|SFW)\s*-->/gi)];
    return matches.length ? matches.at(-1)[1].toLowerCase() : '';
}

/** The model mode a rating asks for ('' = no marker: keep the current mode). */
export function modeForRating(rating) {
    return rating === 'nsfw' ? MODEL_ANIMA : rating === 'sfw' ? MODEL_KREA2 : '';
}
