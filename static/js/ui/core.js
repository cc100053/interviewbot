import { state } from '../state.js';

export function showToast(message, type = 'info') {
    const borderColors = {
        info: 'border-blue-500',
        error: 'border-rose-500',
        warning: 'border-amber-500',
    };
    const container = document.createElement('div');
    const borderColor = borderColors[type] ?? borderColors.info;
    container.className = `fixed bottom-6 right-6 text-sm px-5 py-3 rounded-lg shadow-xl bg-white text-slate-700 border-l-4 ${borderColor} font-medium z-50`;
    container.textContent = message;
    document.body.appendChild(container);
    setTimeout(() => container.remove(), 2500);
}

export function createLucideIcons() {
    if (typeof lucide === 'undefined') {
        console.error('Lucide library is not loaded.');
        return;
    }
    try {
        lucide.createIcons(document.body);
    } catch (error) {
        console.error('Error creating Lucide icons:', error);
    }
}

export function iconMarkup(name, className = 'w-5 h-5') {
    const classes = ['lucide-icon', className].filter(Boolean).join(' ');
    return `<i class="${classes}" data-lucide="${name}" aria-hidden="true"></i>`;
}

export function setPlayPauseButtonIcon(button, isPlaying) {
    if (!button) return;
    const playSvg = `
        <svg viewBox="0 0 20 20" width="20" height="20" fill="currentColor" aria-hidden="true">
            <path d="M6 4l10 6-10 6V4z"></path>
        </svg>
    `;
    const pauseSvg = `
        <svg viewBox="0 0 20 20" width="20" height="20" fill="currentColor" aria-hidden="true">
            <path d="M6 4h3v12H6zM11 4h3v12h-3z"></path>
        </svg>
    `;
    button.innerHTML = isPlaying ? pauseSvg : playSvg;
    button.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
    button.title = isPlaying ? 'Pause' : 'Play';
}

export function setStatus(message = '', visible = false) {
    const statusIndicator = document.getElementById('status-indicator');
    const statusText = document.getElementById('status-text');
    if (!statusIndicator || !statusText) return;

    if (!visible) {
        statusIndicator.classList.add('hidden');
        return;
    }
    statusText.textContent = message;
    statusIndicator.classList.remove('hidden');
}

export function setTrainingStatusMessage(message = '') {
    const trainingStatusMessageEl = document.getElementById('training-status-message');
    const trainingStatusTextEl = document.getElementById('training-status-text');
    if (!trainingStatusMessageEl || !trainingStatusTextEl) {
        return;
    }
    trainingStatusTextEl.textContent = message;
    trainingStatusMessageEl.classList.toggle('hidden', !message);
}

export function autoResizeUserInput() {
    const userInputEl = document.getElementById('user-input');
    if (!userInputEl) {
        return;
    }
    userInputEl.style.height = 'auto';
    const minHeight = 110;
    const nextHeight = Math.max(userInputEl.scrollHeight, minHeight);
    userInputEl.style.height = `${nextHeight}px`;
}

export function scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

export function showConfirmDialog(message) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50';

        const dialog = document.createElement('div');
        dialog.className = 'bg-white border border-slate-200 rounded-2xl p-6 w-full max-w-xs text-sm space-y-5 shadow-2xl';

        const text = document.createElement('p');
        text.className = 'text-slate-700 leading-relaxed';
        text.textContent = message;

        const actions = document.createElement('div');
        actions.className = 'flex justify-end gap-2';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'secondary-button px-3 py-1';
        cancelBtn.textContent = 'キャンセル';

        const confirmBtn = document.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.className = 'primary-button px-3 py-1';
        confirmBtn.textContent = 'クリアする';

        const close = (value) => {
            overlay.remove();
            resolve(value);
        };

        cancelBtn.addEventListener('click', () => close(false));
        confirmBtn.addEventListener('click', () => close(true));

        actions.append(confirmBtn, cancelBtn);
        dialog.append(text, actions);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    });
}

export function updateModeIndicator(mode) {
    const modeIndicatorEl = document.getElementById('mode-indicator');
    if (!modeIndicatorEl) return;
    const label = mode === 'interview' ? '面接モード (最後にまとめてフィードバック)' : '訓練モード (毎回フィードバック)';
    modeIndicatorEl.textContent = state.interviewId ? `現在のモード：${label}` : '';
}

export function updateModeSummaryLabel(modeValue) {
    const modeSummaryEl = document.getElementById('current-setting-summary');
    if (!modeSummaryEl) return;
    const text =
        modeValue === 'interview'
            ? '現在の設定: 面接モード (最後にまとめてフィードバック)'
            : '現在の設定: 訓練モード (毎回フィードバック)';
    modeSummaryEl.textContent = text;
}

export function getSelectedModeValue() {
    const modeRadioEls = document.querySelectorAll('input[name="mode"]');
    if (!modeRadioEls || !modeRadioEls.length) {
        return 'training';
    }
    const checked = Array.from(modeRadioEls).find((radio) => radio.checked);
    return checked ? checked.value : modeRadioEls[0].value;
}

export function setSelectedModeValue(modeValue) {
    const modeRadioEls = document.querySelectorAll('input[name="mode"]');
    if (!modeRadioEls || !modeRadioEls.length) {
        updateModeSummaryLabel(modeValue);
        return;
    }
    let matched = false;
    modeRadioEls.forEach((radio) => {
        const isMatch = radio.value === modeValue;
        radio.checked = isMatch;
        if (isMatch) {
            matched = true;
        }
    });
    if (!matched) {
        const fallback = modeRadioEls[0];
        fallback.checked = true;
        modeValue = fallback.value;
    }
    updateModeSummaryLabel(modeValue);
}
