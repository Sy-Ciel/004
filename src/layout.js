import { getSettings } from './utils.js';

/** Same breakpoint SillyTavern uses for its mobile layout. */
const narrowScreen = window.matchMedia('(max-width: 1000px)');

export function onLayoutChange(callback) {
    narrowScreen.addEventListener('change', callback);
}

/**
 * Where images go right now.
 * - below / above: in the message, under / over the text
 * - inline: in the message, floated beside the text (side = left / right)
 * - panel: a movable panel in the empty margin beside the chat column (side = left / right)
 * Desktop-only modes fall back to above / below on narrow screens.
 * @returns {{ kind: 'below'|'above'|'inline'|'panel', side: 'left'|'right'|null }}
 */
export function layoutMode() {
    const settings = getSettings();
    const position = String(settings.imagePosition || 'below');
    const desktopOnly = ['left', 'right', 'inline-left', 'inline-right'].includes(position);
    if (desktopOnly && narrowScreen.matches) {
        return { kind: settings.imagePositionNarrow === 'above' ? 'above' : 'below', side: null };
    }
    if (position === 'left' || position === 'right') return { kind: 'panel', side: position };
    if (position === 'inline-left') return { kind: 'inline', side: 'left' };
    if (position === 'inline-right') return { kind: 'inline', side: 'right' };
    return { kind: position === 'above' ? 'above' : 'below', side: null };
}
