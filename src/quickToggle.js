/**
 * 一键开关: turns the extension on and off (the setting 「启用」) without opening the settings, so pictures can be
 * stopped for a while. Off: no new picture (automatic or by hand, see enqueue) and nothing added to the main AI's
 * prompt; pictures already made still show. Where it is (quickTogglePlace): in the wand menu by the chat input (one
 * more tap, so it is not hit by accident), as a 🖼 button left of the chat input, or nowhere.
 */
import { cancelAllJobs, cancelUpscales, hasActiveJobs, resumeUpscales } from './pipeline.js';
import { updateRatingPrompt } from './rating.js';
import { updateStatusPrompt } from './statusBar.js';
import { getSettings, saveSettings } from './utils.js';

const BUTTON_ID = 'ctp_quick_toggle';
const MENU_ID = 'ctp_wand_toggle';

function toggle() {
    setEnabled(!getSettings().enabled);
}

/** The 🖼 button left of the chat input, next to the wand. */
function inputButton() {
    let button = $(`#${BUTTON_ID}`);
    if (button.length) return button;
    const form = $('#leftSendForm');
    if (!form.length) return button;
    button = $(`<div id="${BUTTON_ID}" class="fa-solid fa-image interactable" role="button" tabindex="0"></div>`);
    button.on('click', toggle);
    button.on('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        toggle();
    });
    form.append(button);
    return button;
}

/** The wand menu's 「ComfyUI 配图：开 / 关」, next to its 「为最新楼层生成配图」. */
function menuItem() {
    let item = $(`#${MENU_ID}`);
    if (item.length) return item;
    const menu = $('#extensionsMenu');
    if (!menu.length) return item;
    item = $(`<div id="${MENU_ID}" class="list-group-item flex-container flexGap5" role="button">
        <div class="fa-solid extensionsMenuExtensionButton"></div>
        <span></span>
    </div>`);
    item.on('click', toggle);
    const generate = $('#ctp_wand');
    if (generate.length) generate.before(item);
    else menu.append(item);
    return item;
}

/** Puts the switch where the settings say, showing whether pictures are on. */
export function updateQuickToggle() {
    const settings = getSettings();
    const place = ['wand', 'input', 'none'].includes(settings.quickTogglePlace) ? settings.quickTogglePlace : 'wand';
    const on = !!settings.enabled;
    if (place === 'input') {
        inputButton()
            .toggleClass('ctp-on', on)
            .toggleClass('ctp-off', !on)
            .attr('aria-pressed', String(on))
            .attr('title', on ? 'ComfyUI 角色配图：开（点一下关闭配图）' : 'ComfyUI 角色配图：关（点一下打开）');
    } else {
        $(`#${BUTTON_ID}`).remove();
    }
    if (place === 'wand') {
        const item = menuItem();
        item.toggleClass('ctp-on', on).toggleClass('ctp-off', !on).attr('aria-pressed', String(on))
            .attr('title', on ? '现在会配图，点一下关闭（不再生成新图，已有的图照常显示）' : '现在不配图，点一下打开');
        item.children('.extensionsMenuExtensionButton').toggleClass('fa-toggle-on', on).toggleClass('fa-toggle-off', !on);
        item.children('span').text(on ? 'ComfyUI 配图：开' : 'ComfyUI 配图：关');
    } else {
        $(`#${MENU_ID}`).remove();
    }
}

/**
 * What follows the switch wherever it was flipped: the main AI's instructions (status bar, picture rating), the
 * switch itself, and pictures in the making, which stop when it goes off (pictures waiting for the upscale model
 * wait until it is on again). Returns whether any were cancelled.
 */
export function applyEnabled() {
    updateStatusPrompt();
    updateRatingPrompt();
    updateQuickToggle();
    if (getSettings().enabled) {
        resumeUpscales();
        return false;
    }
    cancelUpscales();
    if (!hasActiveJobs()) return false;
    cancelAllJobs();
    return true;
}

/** Turns the extension on or off (the switch, /ctimg-enable); the 「启用」 box in the settings follows. */
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
