import { makeId } from './constants.js';
import { readInput, registerPickerOwner, renderPicker, writeInput } from './form.js';
import { newRenderProfile, presetsUsing } from './renderProfiles.js';
import { presetName } from './targets.js';
import { ctx, escapeHtml, getSettings, saveSettings } from './utils.js';

let selectedId = null;
let notifyChange = () => {};

function currentProfile() {
    return getSettings().renderProfiles.find(profile => profile.id === selectedId) ?? null;
}

registerPickerOwner('profilePicker', currentProfile);

function usedByText(profile) {
    const names = presetsUsing(profile.id).map(preset => presetName(preset) || preset.name);
    return names.length ? `使用这个配置的角色预设：${names.join('、')}` : '还没有角色预设使用这个配置（在「角色预设」里选择）';
}

/** Re-reads the profile list and the selected profile into the editor. */
export function refreshRenderProfileUi() {
    const profiles = getSettings().renderProfiles;
    if (!profiles.some(profile => profile.id === selectedId)) selectedId = profiles[0]?.id ?? null;
    $('#ctp_rp_select')
        .html(profiles.map(profile => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}</option>`).join(''))
        .val(selectedId)
        .toggle(profiles.length > 0);
    $('#ctp_rp_clone, #ctp_rp_delete').toggle(profiles.length > 0);
    $('#ctp_rp_empty').toggle(!profiles.length);

    const profile = currentProfile();
    $('#ctp_rp_editor').toggle(!!profile);
    if (!profile) return;
    document.querySelectorAll('#ctp_rp_editor [data-rp]').forEach(element => writeInput(element, profile[element.dataset.rp]));
    document.querySelectorAll('#ctp_rp_editor select[data-list]').forEach(renderPicker);
    $('#ctp_rp_used').text(usedByText(profile));
}

/** Updates the "used by" line after a character preset changed its render profile. */
export function refreshRenderProfileUsage() {
    const profile = currentProfile();
    if (profile) $('#ctp_rp_used').text(usedByText(profile));
}

function changed() {
    saveSettings();
    refreshRenderProfileUi();
    notifyChange();
}

/**
 * @param {{ onChange: () => void, validateWorkflow: (text: string) => void }} hooks
 *   onChange: the profile list or a name changed (character presets list them);
 *   validateWorkflow: checks a workflow JSON and reports the result.
 */
export function initRenderProfileUi({ onChange, validateWorkflow }) {
    notifyChange = onChange;

    $('#ctp_rp_select').on('change', function () {
        selectedId = String($(this).val());
        refreshRenderProfileUi();
    });

    document.querySelectorAll('#ctp_rp_editor [data-rp]').forEach(element => {
        element.addEventListener('input', () => {
            const profile = currentProfile();
            if (!profile) return;
            profile[element.dataset.rp] = readInput(element);
            saveSettings();
            if (element.dataset.rp === 'name') {
                $('#ctp_rp_select option:selected').text(profile.name);
                notifyChange();
            }
        });
    });

    $('#ctp_rp_add').on('click', () => {
        const profile = newRenderProfile();
        getSettings().renderProfiles.push(profile);
        selectedId = profile.id;
        changed();
    });

    $('#ctp_rp_clone').on('click', () => {
        const source = currentProfile();
        if (!source) return;
        const profile = newRenderProfile({ ...structuredClone(source), id: makeId(), name: `${source.name} 副本` });
        getSettings().renderProfiles.push(profile);
        selectedId = profile.id;
        changed();
    });

    $('#ctp_rp_delete').on('click', async () => {
        const profile = currentProfile();
        if (!profile) return;
        const users = presetsUsing(profile.id);
        const note = users.length ? `<br>使用它的角色预设（${users.map(preset => escapeHtml(presetName(preset) || preset.name)).join('、')}）会改回默认设置。` : '';
        const { callGenericPopup, POPUP_TYPE, POPUP_RESULT } = ctx();
        const confirmed = await callGenericPopup(`删除渲染配置「${escapeHtml(profile.name)}」？${note}`, POPUP_TYPE.CONFIRM);
        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) return;
        const settings = getSettings();
        settings.renderProfiles = settings.renderProfiles.filter(item => item.id !== profile.id);
        for (const preset of users) preset.renderProfileId = '';
        changed();
    });

    $('#ctp_rp_validate').on('click', () => {
        const workflow = String(currentProfile()?.workflow ?? '');
        if (!workflow.trim()) toastr.info('没有填专用工作流，会用 ComfyUI 区的工作流');
        else validateWorkflow(workflow);
    });

    refreshRenderProfileUi();
}
