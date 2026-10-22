/**
 * The 🖼 button on messages: generate this floor's picture again (parse it again and draw). It is always in the
 * message's 「…」 menu; with 「在回复上显示重新生成配图按钮」 (quickRegenButton) also right in the reply's button bar,
 * next to ✏️, one click away (style.css hides that one on the user's own messages and the menu copy where it shows).
 */
import { getSettings } from './utils.js';

const MENU_BUTTON = '<div title="ComfyUI 角色配图：生成 / 重新生成这一楼的配图" class="mes_button ctp_mes_gen fa-solid fa-image"></div>';
const QUICK_BUTTON = '<div title="重新生成配图（重新解析这一楼并出图）" class="mes_button ctp_mes_gen ctp_mes_quick fa-solid fa-image"></div>';

/** One message's button bar (or the template of future ones): the menu button, and the quick one when it is on. */
function placeButtons(buttons, quick) {
    const menu = buttons.children('.extraMesButtons');
    if (menu.length && !menu.children('.ctp_mes_gen').length) menu.prepend(MENU_BUTTON);
    const shown = buttons.children('.ctp_mes_quick');
    if (!quick) {
        shown.remove();
        return;
    }
    if (shown.length) return;
    const edit = buttons.children('.mes_edit');
    if (edit.length) edit.before(QUICK_BUTTON);
    else buttons.append(QUICK_BUTTON);
}

/** Adds the buttons to the message template (future messages) and to the messages already shown. */
export function injectMessageButtons() {
    const quick = getSettings().quickRegenButton !== false;
    $('#message_template .mes_buttons, #chat .mes .mes_buttons').each(function () {
        placeButtons($(this), quick);
    });
}
