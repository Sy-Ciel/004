/**
 * 正文状态栏: the main AI ends each reply with a collapsible <details> block describing one character's clothing,
 * action, state and mood at the end of the reply. The block is part of the message, so the main AI keeps seeing
 * it in later turns; the parser takes it out of the current floor and reads it first.
 */
import { DEFAULT_STATUS_TEMPLATE, TARGET_CHAR, TARGET_USER } from './constants.js';
import { resolveTarget } from './targets.js';
import { ctx, fillTemplate, getSettings, plainText } from './utils.js';

const PROMPT_KEY = 'comfy_portrait_status';
// SillyTavern's extension_prompt_types.IN_CHAT and extension_prompt_roles.SYSTEM
const IN_CHAT = 1;
const ROLE_SYSTEM = 0;

function statusLabel() {
    return String(getSettings().statusBar.label || '').trim() || '状态栏';
}

/** Name of the character the status bar describes; '' lets the main AI pick (target "auto"). */
export function statusTargetName() {
    const { statusBar } = getSettings();
    if (statusBar.target === 'custom') return String(statusBar.name || '').trim() || ctx().name1 || '';
    const override = statusBar.target === 'user' ? TARGET_USER : statusBar.target === 'char' ? TARGET_CHAR : undefined;
    const target = resolveTarget({ name: ctx().name2, is_user: false }, override);
    return target.auto ? '' : target.name;
}

/** The instruction sent to the main AI. */
export function buildStatusInstruction() {
    const { statusBar } = getSettings();
    const name = statusTargetName();
    const fields = String(statusBar.fields || '').split(/[,，、;；\n]/).map(field => field.trim()).filter(Boolean);
    const lines = [`角色：${name || '（写明是谁）'}`, ...fields.map(field => `${field}：……`)].join('\n');
    return fillTemplate(String(statusBar.template || DEFAULT_STATUS_TEMPLATE), {
        name: name ? `「${name}」` : '本次回复里戏份最重的一个角色',
        label: statusLabel(),
        lines,
        fields: fields.join('、'),
    });
}

/**
 * Puts the instruction into (or takes it out of) the main AI's prompt. Called before every generation with its
 * type: quiet generations (summaries, other extensions) and impersonation must not get a status bar.
 */
export function updateStatusPrompt(type) {
    const { setExtensionPrompt } = ctx();
    if (typeof setExtensionPrompt !== 'function') return;
    const settings = getSettings();
    const active = settings.enabled && settings.statusBar.enabled && !['quiet', 'impersonate'].includes(type);
    const depth = Math.max(0, Math.trunc(Number(settings.statusBar.depth) || 0));
    setExtensionPrompt(PROMPT_KEY, active ? buildStatusInstruction() : '', IN_CHAT, depth, false, ROLE_SYSTEM);
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The last status block in a message (the AI may forget the closing tag, so the end of the text also counts).
 * @returns {{ text: string, start: number, end: number } | null}
 */
export function findStatusBar(text) {
    const source = String(text ?? '');
    const pattern = new RegExp(`<details[^>]*>\\s*<summary[^>]*>[^<]*${escapeRegExp(statusLabel())}[^<]*</summary>([\\s\\S]*?)(?:</details>|$)`, 'gi');
    let last = null;
    for (const match of source.matchAll(pattern)) last = match;
    if (!last) return null;
    const inner = plainText(last[1]);
    return inner ? { text: inner, start: last.index, end: last.index + last[0].length } : null;
}

/** The message text without the status block. */
export function withoutStatusBar(text, found) {
    const source = String(text ?? '');
    return found ? `${source.slice(0, found.start)}${source.slice(found.end)}`.trim() : source;
}

/** Marks rendered status blocks so they get the extension's styling. */
export function decorateStatusBars(element) {
    const label = statusLabel();
    element.find('.mes_text details').each(function () {
        const summary = this.querySelector(':scope > summary');
        if (summary?.textContent.includes(label)) this.classList.add('ctp-status-bar');
    });
}
