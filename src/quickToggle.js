/**
 * 一键开关: the 🖼 button left of the chat input, next to SillyTavern's wand, turns the extension on and off (the
 * setting 「启用」), so pictures can be stopped for a while without opening the settings. Off: no new picture
 * (automatic or by hand, see enqueue) and nothing added to the main AI's prompt; pictures already made still show.
 * The button can be hidden (「在输入框左边显示一键开关」, quickToggleButton).
 */
import { cancelAllJobs, hasActiveJobs } from './pipeline.js';
import { updateRatingPrompt } from './rating.js';
import { updateStatusPrompt } from './statusBar.js';
import { getSettings, saveSettings } from './utils.js';

const BUTTON_ID = 'ctp_quick_toggle';

/** Adds, updates or removes the button to match the settings. */
export function updateQuickToggle() {
    const settings = getSettings();
    let button = $(`#${BUTTON_ID}`);
    if (settings.quickToggleButton === false) {
        button.remove();
        return;
    }
    if (!button.length) {
        const form = $('#leftSendForm');
        if (!form.length) return;
        button = $(`<div id="${BUTTON_ID}" class="fa-solid fa-image interactable" role="button" tabindex="0"></div>`);
        button.on('click', () => setEnabled(!getSettings().enabled));
        button.on('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            setEnabled(!getSettings().enabled);
        });
        form.append(button);
    }
    const on = !!settings.enabled;
    button
        .toggleClass('ctp-on', on)
        .toggleClass('ctp-off', !on)
        .attr('aria-pressed', String(on))
        .attr('title', on ? 'ComfyUI 角色配图：开（点一下关闭配图）' : 'ComfyUI 角色配图：关（点一下打开）');
}

/**
 * What follows the switch wherever it was flipped: the main AI's instructions (status bar, picture rating), the
 * button, and pictures in the making, which stop when it goes off. Returns whether any were cancelled.
 */
export function applyEnabled() {
    updateStatusPrompt();
    updateRatingPrompt();
    updateQuickToggle();
    if (getSettings().enabled || !hasActiveJobs()) return false;
    cancelAllJobs();
    return true;
}

/** Turns the extension on or off (the button, /ctimg-enable); the 「启用」 box in the settings follows. */
export function setEnabled(on) {
    const settings = getSettings();
    settings.enabled = !!on;
    saveSettings();
    $('.ctp-settings [data-ctp="enabled"]').prop('checked', settings.enabled);
    const cancelled = applyEnabled();
    if (settings.enabled) {
        toastr.success('配图已打开', 'ComfyUI 角色配图', { timeOut: 2000 });
    } else {
        toastr.info(`配图已关闭：不再生成新图，已有的图照常显示${cancelled ? '；正在进行的配图已取消' : ''}`, 'ComfyUI 角色配图', { timeOut: 3000 });
    }
}
