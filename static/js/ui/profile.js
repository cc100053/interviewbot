import { state, saveProfileToStorage, getDefaultProfile } from '../state.js';
import { showToast, scrollToTop, iconMarkup } from './core.js';
import { PROFILE_STATUS_DESCRIPTIONS, DEFAULT_AVATAR_SRC } from '../config.js';

export function renderProfile() {
    if (!state.profile) {
        state.profile = getDefaultProfile();
    }
    const profile = state.profile;

    const avatarSrc = profile.avatarData || DEFAULT_AVATAR_SRC;

    const profileAvatarPreviewEl = document.getElementById('profile-avatar-preview');
    const headerProfileAvatarEl = document.getElementById('header-profile-avatar');
    const profileNameDisplayEl = document.getElementById('profile-name-display');
    const profileRoleDisplayEl = document.getElementById('profile-role-display');
    const profileStatusBadgeEl = document.getElementById('profile-status-display');
    const profileStatusDescriptionEl = document.getElementById('profile-status-description');
    const profileNotesDisplayEl = document.getElementById('profile-notes-display');

    const profileNameInputEl = document.getElementById('profile-name');
    const profileEmailInputEl = document.getElementById('profile-email');
    const profileStatusSelectEl = document.getElementById('profile-status');
    const profileRoleInputEl = document.getElementById('profile-role');
    const profileNotesInputEl = document.getElementById('profile-notes');
    const profileAvatarInputEl = document.getElementById('profile-avatar');

    if (profileAvatarPreviewEl) {
        profileAvatarPreviewEl.src = avatarSrc;
    }
    if (headerProfileAvatarEl) {
        headerProfileAvatarEl.src = avatarSrc;
    }
    if (profileNameDisplayEl) {
        profileNameDisplayEl.textContent = profile.name || '名前未設定';
    }
    if (profileRoleDisplayEl) {
        profileRoleDisplayEl.textContent = profile.role || '未設定';
    }
    if (profileStatusBadgeEl) {
        const baseClass = 'inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold';
        const statusStyle = profile.status === '内定'
            ? 'background:rgba(58,125,92,0.1); color:#3a7d5c; border:1px solid rgba(58,125,92,0.2);'
            : profile.status === '最終面接' || profile.status === '二次面接'
                ? 'background:rgba(200,90,58,0.08); color:#c85a3a; border:1px solid rgba(200,90,58,0.15);'
                : profile.status === '一次面接'
                    ? 'background:rgba(26,26,26,0.06); color:#1a1a1a; border:1px solid rgba(26,26,26,0.1);'
                    : 'background:#f5f2ed; color:#5c5c5c; border:1px solid #e0dcd5;';
        profileStatusBadgeEl.className = baseClass;
        profileStatusBadgeEl.style.cssText = statusStyle;
        profileStatusBadgeEl.textContent = profile.status || '未設定';
    }
    if (profileStatusDescriptionEl) {
        profileStatusDescriptionEl.textContent = PROFILE_STATUS_DESCRIPTIONS[profile.status] || '応募状況を設定してください。';
    }
    if (profileNotesDisplayEl) {
        profileNotesDisplayEl.textContent = profile.notes ? profile.notes : '自己紹介メモはまだありません。';
    }

    if (profileNameInputEl) profileNameInputEl.value = profile.name || '';
    if (profileEmailInputEl) profileEmailInputEl.value = profile.email || '';
    if (profileStatusSelectEl) profileStatusSelectEl.value = profile.status || '書類選考';
    if (profileRoleInputEl) profileRoleInputEl.value = profile.role || '';
    if (profileNotesInputEl) profileNotesInputEl.value = profile.notes || '';
    if (profileAvatarInputEl) profileAvatarInputEl.value = '';
}

export function handleProfileSubmit(event) {
    event.preventDefault();
    const profileNameInputEl = document.getElementById('profile-name');
    const profileEmailInputEl = document.getElementById('profile-email');
    const profileStatusSelectEl = document.getElementById('profile-status');
    const profileRoleInputEl = document.getElementById('profile-role');
    const profileNotesInputEl = document.getElementById('profile-notes');

    const updatedProfile = {
        ...state.profile,
        name: profileNameInputEl?.value.trim() || '',
        email: profileEmailInputEl?.value.trim() || '',
        status: profileStatusSelectEl?.value || '書類選考',
        role: profileRoleInputEl?.value.trim() || '',
        notes: profileNotesInputEl?.value.trim() || '',
    };
    state.profile = updatedProfile;
    saveProfileToStorage(updatedProfile, state.currentUserId);
    renderProfile();
    showToast('プロフィールを更新しました。', 'info');
}

export function handleProfileAvatarChange(event) {
    const file = event.target?.files?.[0];
    if (!file) {
        return;
    }
    const reader = new FileReader();
    reader.onload = (loadEvent) => {
        const dataUrl = typeof loadEvent.target?.result === 'string' ? loadEvent.target.result : null;
        state.profile.avatarData = dataUrl;
        saveProfileToStorage(state.profile, state.currentUserId);
        renderProfile();
        showToast('プロフィール画像を更新しました。', 'info');
    };
    reader.readAsDataURL(file);
}

// We need a way to switch to profile tab.
// Since we can't import switchTab here (cycle), we will export a function that main.js can use,
// or we just use the event handler in main.js.
// `openProfileTab` in app.js called `switchView` and `switchTab`.
// We'll leave `openProfileTab` logic to be composed in main.js or router.js.
