import { state } from '../state.js';
import { thinkingMessages, DASHBOARD_SKILLS, SKILL_LABELS } from '../config.js';
import { normalizeSummary, formatScore, formatTotalTime, formatDateToJst } from '../utils.js';
import { showToast, setStatus, setTrainingStatusMessage, autoResizeUserInput, createLucideIcons, iconMarkup, updateModeIndicator, updateModeSummaryLabel, getSelectedModeValue, setSelectedModeValue } from './core.js';
import { apiRequest } from '../api.js';
import { createMiniAudioPlayer, stopCurrentAiAudio, startRecording, stopRecording, setRecordingState, resetTranscriptState } from '../audio.js';

let refreshHistory = async () => { };

export function setRefreshHistory(fn) {
    refreshHistory = fn;
}

// We need to export these for audio.js to call, but to avoid cycle, we will register them.
// For now, let's define them and export them, and we will fix audio.js to use a callback registration.
// Actually, let's just export them and see if we can use the callback pattern.

export function getChatHistoryElement() {
    return document.getElementById('chat-history');
}

export function createTextFragment(text) {
    const fragment = document.createDocumentFragment();
    const lines = String(text ?? '').split(/\r?\n/);
    lines.forEach((line, index) => {
        fragment.appendChild(document.createTextNode(line));
        if (index < lines.length - 1) {
            fragment.appendChild(document.createElement('br'));
        }
    });
    return fragment;
}

export function setUserInputValue(value) {
    const userInputEl = document.getElementById('user-input');
    if (!userInputEl) {
        return;
    }
    userInputEl.value = value;
    autoResizeUserInput();
}

export function appendFinalTranscript(text) {
    // audio.js now handles transcript accumulation and passes the FULL accumulated text.
    // We simply set the value directly.
    const userInputEl = document.getElementById('user-input');
    if (!userInputEl) return;

    const clean = text.trim();
    if (!clean) return;

    setUserInputValue(clean);
}

export function updateInterimTranscript(text) {
    // Show the interim transcript in the user input field in real-time
    // This displays the text being recognized while the user speaks
    const userInputEl = document.getElementById('user-input');
    if (!userInputEl) return;

    // Simply show the interim text - it updates as recognition progresses
    if (text && text.trim()) {
        userInputEl.value = text.trim();
        autoResizeUserInput();
    }
}

// Re-implementing the UI logic from app.js
export function appendChatMessage({ role, content, audioUrl = '', autoPlay = true }) {
    const chatEl = getChatHistoryElement();
    if (!chatEl) {
        return;
    }
    const placeholder = chatEl.querySelector('[data-placeholder]');
    if (placeholder) {
        placeholder.remove();
    }

    const wrapper = document.createElement('div');
    wrapper.className = `chat-message ${role === 'ai' ? 'ai' : 'user'}`;

    const label = document.createElement('div');
    label.className = 'chat-role';
    label.textContent = role === 'ai' ? 'AI面接官' : 'あなた';

    const body = document.createElement('div');
    body.className = 'chat-content';
    body.appendChild(createTextFragment(content));

    wrapper.append(label, body);

    chatEl.appendChild(wrapper);
    wrapper.scrollIntoView({ behavior: 'smooth', block: 'end' });

    if (audioUrl) {
        const player = createMiniAudioPlayer(audioUrl, { autoPlay });
        body.appendChild(player.wrapper);
        createLucideIcons();
    } else if (role === 'ai') {
        createLucideIcons();
    }
}

export function appendUserMessage(content) {
    state.chatHistory.push({ role: 'user', content });
    appendChatMessage({ role: 'user', content, autoPlay: false });
}

export function appendAiMessage(content, audioUrl = '', options = {}) {
    const { autoPlay = true } = options;
    state.chatHistory.push({ role: 'ai', content, audioUrl });
    appendChatMessage({ role: 'ai', content, audioUrl, autoPlay });
}

export function handleAiResponse(data) {
    if (!data) {
        appendAiMessage('回答を生成できませんでした。', '', { autoPlay: false });
        return;
    }
    const aiText = data.aiMessageText ?? data.aiMessage ?? '回答を生成できませんでした。';
    const audioUrl = data.aiAudioUrl || data.nextQuestionAudioUrl || '';
    appendAiMessage(aiText, audioUrl, { autoPlay: Boolean(audioUrl) });
}

export function updateSendDisabled(disabled) {
    state.controlsDisabled = disabled;
    applyControlState();
}

export function applyControlState() {
    const sendButtonEl = document.getElementById('send-button');
    const userInputEl = document.getElementById('user-input');
    const recordButtonEl = document.getElementById('record-voice-btn');

    const textDisabled = state.controlsDisabled || state.isRecording;
    if (sendButtonEl) {
        sendButtonEl.disabled = textDisabled;
    }
    if (userInputEl) {
        userInputEl.disabled = state.controlsDisabled || state.isRecording;
    }
    if (recordButtonEl) {
        recordButtonEl.disabled = state.controlsDisabled;
    }
}

export function randomThinkingMessage() {
    const index = Math.floor(Math.random() * thinkingMessages.length);
    return thinkingMessages[index];
}

export async function handleSend(event) {
    if (event) {
        event.preventDefault();
    }
    if (!state.interviewId) {
        showToast('面接を開始してください。', 'warning');
        return;
    }
    const userInputEl = document.getElementById('user-input');
    if (!userInputEl) return;
    const message = userInputEl.value.trim();
    if (!message) return;

    stopCurrentAiAudio();
    appendUserMessage(message);

    // Reset transcript state in audio.js
    resetTranscriptState();

    setUserInputValue('');
    updateSendDisabled(true);
    try {
        const data = await apiRequest('/chat', {
            method: 'POST',
            body: JSON.stringify({
                interviewId: state.interviewId,
                userMessage: message,
                chatHistory: state.chatHistory,
            }),
            statusMessage: randomThinkingMessage(),
        });
        handleAiResponse(data);
        await refreshHistory();
    } catch (error) {
        showToast(error.message || '回答の送信に失敗しました。', 'error');
    } finally {
        updateSendDisabled(false);
        if (userInputEl) {
            userInputEl.focus();
        }
    }
}

export function resetInterviewState(options = {}) {
    const { keepTab = false } = options;

    // Stop recording and audio
    stopRecording(); // This also cleans up audio graph
    stopCurrentAiAudio();
    resetTranscriptState();

    state.interviewId = null;
    state.chatHistory = [];
    state.currentMode = 'training';
    const chatEl = getChatHistoryElement();
    if (chatEl) {
        chatEl.innerHTML = '';
        const placeholder = document.createElement('p');
        placeholder.dataset.placeholder = 'true';
        placeholder.className = 'text-slate-500 text-sm';
        placeholder.textContent = '面接を開始するとやり取りが表示されます。';
        chatEl.appendChild(placeholder);
    }
    setUserInputValue('');
    updateSendDisabled(true);
    setStatus('', false);
    updateModeIndicator(state.currentMode);
    setSelectedModeValue('training');

    // We need to switch tab, but switchTab is in main/router.
    // We will dispatch an event or assume main.js handles this?
    // Or we import `switchTab` from a router file.
    // For now, let's dispatch a custom event 'reset-interview' and let main.js listen?
    // Or just leave the tab switching to the caller if possible.
    // The original code called `switchTab`.

    if (!keepTab && state.currentView === 'app') {
        // Dispatch event to switch tab
        document.dispatchEvent(new CustomEvent('request-switch-tab', { detail: { tabId: 'top-page-view' } }));
    }
}

export async function handleSetupSubmit(event) {
    event.preventDefault();
    const formData = new FormData(event.target);
    const selectedMode = getSelectedModeValue();
    const payload = {
        interviewType: formData.get('interviewType'),
        targetIndustry: formData.get('targetIndustry'),
        mode: selectedMode,
    };
    setTrainingStatusMessage('最初の質問を準備中…');
    try {
        const data = await apiRequest('/interviews/start', {
            method: 'POST',
            body: JSON.stringify(payload),
            skipStatus: true,
        });
        resetInterviewState({ keepTab: true });
        state.interviewId = data.interviewId;
        state.currentMode = (data.mode || selectedMode).toLowerCase();
        setSelectedModeValue(state.currentMode);
        updateModeIndicator(state.currentMode);

        // Switch view/tab
        document.dispatchEvent(new CustomEvent('request-switch-view', { detail: { viewName: 'app' } }));
        document.dispatchEvent(new CustomEvent('request-switch-tab', { detail: { tabId: 'interview-chat-view' } }));

        appendAiMessage(
            data.questionText || '質問を取得できませんでした。',
            data.audioUrl || '',
            { autoPlay: Boolean(data.audioUrl) },
        );
        updateSendDisabled(false);
        showToast('面接を開始しました。', 'info');
        await refreshHistory();
        const userInputEl = document.getElementById('user-input');
        if (userInputEl) {
            userInputEl.focus();
        }
    } catch (error) {
        showToast(error.message || '面接の開始に失敗しました。', 'error');
    } finally {
        setTrainingStatusMessage('');
    }
}

export function showSummaryModal(summaryPayload) {
    const summaryData = normalizeSummary(summaryPayload);
    const summaryText = summaryData?.text ?? (typeof summaryPayload === 'string' ? summaryPayload : '');

    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 px-4';

    const dialog = document.createElement('div');
    dialog.className = 'bg-white border border-slate-200 rounded-2xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col shadow-2xl';

    const header = document.createElement('div');
    header.className = 'flex items-center justify-between px-5 py-4 border-b border-slate-200 bg-slate-50';
    const title = document.createElement('h3');
    title.className = 'text-lg font-semibold text-slate-900';
    title.textContent = '面接サマリー';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'text-slate-500 hover:text-slate-900 text-sm';
    closeBtn.textContent = '閉じる';
    header.append(title, closeBtn);

    const body = document.createElement('div');
    body.className = 'px-5 py-4 overflow-y-auto bg-white';
    const summaryParagraph = document.createElement('p');
    summaryParagraph.className = 'text-sm text-slate-700 whitespace-pre-wrap leading-relaxed';
    summaryParagraph.appendChild(createTextFragment(summaryText || 'サマリーがありません。'));
    body.appendChild(summaryParagraph);

    const summaryMetaParts = [];
    if (summaryData && Number.isFinite(Number(summaryData.score))) {
        summaryMetaParts.push(`スコア: ${formatScore(summaryData.score)}`);
    }
    if (summaryData && Number.isFinite(Number(summaryData.durationSeconds))) {
        const minutesRaw = Number(summaryData.durationSeconds) / 60;
        const minutes = minutesRaw > 0 ? Math.max(1, Math.round(minutesRaw)) : 0;
        summaryMetaParts.push(`所要時間: ${formatTotalTime(minutes)}`);
    }
    if (summaryMetaParts.length) {
        const statsLine = document.createElement('p');
        statsLine.className = 'text-xs text-slate-500 mt-3';
        statsLine.textContent = summaryMetaParts.join(' / ');
        body.appendChild(statsLine);
    }

    if (summaryData && summaryData.skills && Object.keys(summaryData.skills).some((key) => Number.isFinite(Number(summaryData.skills[key])))) {
        const skillsGrid = document.createElement('div');
        skillsGrid.className = 'grid grid-cols-2 sm:grid-cols-3 gap-2 mt-4';
        DASHBOARD_SKILLS.forEach((skillKey) => {
            const value = Number(summaryData.skills?.[skillKey]);
            if (!Number.isFinite(value)) {
                return;
            }
            const card = document.createElement('div');
            card.className = 'bg-slate-100 rounded-lg px-3 py-2 flex flex-col gap-1';
            const label = document.createElement('span');
            label.className = 'text-[11px] font-medium text-slate-500';
            label.textContent = SKILL_LABELS[skillKey] || skillKey;
            const score = document.createElement('span');
            score.className = 'text-base font-semibold text-slate-800';
            score.textContent = formatScore(value);
            card.append(label, score);
            skillsGrid.appendChild(card);
        });
        body.appendChild(skillsGrid);
    }

    dialog.append(header, body);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
            close();
        }
    });
}

export async function handleEndInterview() {
    if (!state.interviewId) {
        resetInterviewState();
        document.dispatchEvent(new CustomEvent('request-switch-view', { detail: { viewName: 'app' } }));
        document.dispatchEvent(new CustomEvent('request-switch-tab', { detail: { tabId: 'top-page-view' } }));
        return;
    }

    if (state.currentMode === 'interview') {
        try {
            setStatus('サマリーを生成しています…', true);
            const result = await apiRequest(`/interviews/${state.interviewId}/finish`, {
                method: 'POST',
                skipStatus: true,
            });
            const summaryText = result?.summary || 'サマリーを取得できませんでした。';
            resetInterviewState();
            document.dispatchEvent(new CustomEvent('request-switch-view', { detail: { viewName: 'app' } }));
            document.dispatchEvent(new CustomEvent('request-switch-tab', { detail: { tabId: 'top-page-view' } }));
            await refreshHistory();
            showSummaryModal(summaryText);
            showToast('面接モードを終了しました。', 'info');
        } catch (error) {
            showToast(error.message || 'サマリーの生成に失敗しました。', 'error');
        } finally {
            setStatus('', false);
        }
        return;
    }

    resetInterviewState();
    document.dispatchEvent(new CustomEvent('request-switch-view', { detail: { viewName: 'app' } }));
    document.dispatchEvent(new CustomEvent('request-switch-tab', { detail: { tabId: 'top-page-view' } }));
    await refreshHistory();
    showToast('面接を終了しました。', 'info');
}

export function showInterviewDetails(interview) {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 px-4';

    const dialog = document.createElement('div');
    dialog.className = 'bg-white border border-slate-200 rounded-2xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col shadow-2xl';

    const header = document.createElement('div');
    header.className = 'flex items-center justify-between px-5 py-4 border-b border-slate-200 bg-slate-50';
    const title = document.createElement('h3');
    title.className = 'text-lg font-semibold text-slate-900';
    title.textContent = '面接詳細';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'text-slate-500 hover:text-slate-900 text-sm';
    closeBtn.textContent = '閉じる';
    header.append(title, closeBtn);

    const body = document.createElement('div');
    body.className = 'px-5 py-4 overflow-y-auto space-y-4 bg-white';

    const summaryData = normalizeSummary(interview.summaryReport);
    const formattedDate = formatDateToJst(interview.createdAt || interview.created_at);
    const meta = document.createElement('div');
    meta.className = 'text-sm text-slate-700 space-y-1';
    const modeLabel = interview.mode === 'interview' ? '面接モード' : '訓練モード';
    const metaLines = [
        `実施日時: ${formattedDate}`,
        `面接タイプ: ${interview.setup?.interviewType || '面接'}`,
        `対象業界: ${interview.setup?.targetIndustry || '未設定'}`,
        `モード: ${modeLabel}`,
    ];
    metaLines.forEach((line) => {
        const p = document.createElement('p');
        p.textContent = line;
        meta.appendChild(p);
    });
    body.appendChild(meta);

    const transcriptSection = document.createElement('div');
    const transcriptTitle = document.createElement('h4');
    transcriptTitle.className = 'text-sm font-semibold text-slate-900';
    transcriptTitle.textContent = 'やり取り';
    transcriptSection.appendChild(transcriptTitle);

    const transcriptBody = document.createElement('div');
    transcriptBody.className = 'mt-2 space-y-2';
    const transcript = Array.isArray(interview.transcript) ? interview.transcript : [];
    if (transcript.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'text-sm text-slate-500';
        empty.textContent = '記録がありません。';
        transcriptBody.appendChild(empty);
    } else {
        transcript.forEach((entry) => {
            if (!entry || !entry.role) return;
            const row = document.createElement('div');
            row.className = `rounded-xl px-4 py-3 border shadow-sm ${entry.role === 'ai'
                ? 'border-blue-200 bg-blue-50'
                : 'border-slate-200 bg-slate-100'
                }`;
            const roleLabel = entry.role === 'ai' ? 'AI面接官' : 'あなた';
            const role = document.createElement('p');
            role.className = `text-xs font-semibold ${entry.role === 'ai' ? 'text-blue-600' : 'text-slate-600'
                }`;
            role.textContent = roleLabel;
            const content = document.createElement('p');
            content.className = 'text-sm text-slate-700 whitespace-pre-wrap leading-relaxed mt-2';
            content.appendChild(createTextFragment(entry.content ?? ''));
            row.append(role, content);



            if (entry.timestamp) {
                const time = document.createElement('p');
                time.className = 'text-[11px] text-slate-400 mt-2';
                time.textContent = `記録日時: ${formatDateToJst(entry.timestamp)}`;
                row.appendChild(time);
            }
            transcriptBody.appendChild(row);
        });
    }
    transcriptSection.appendChild(transcriptBody);
    body.appendChild(transcriptSection);

    if (summaryData) {
        const summarySection = document.createElement('div');
        summarySection.className = 'space-y-3';
        const summaryTitle = document.createElement('h4');
        summaryTitle.className = 'text-sm font-semibold text-slate-900';
        summaryTitle.textContent = 'サマリーレポート';
        const summaryContent = document.createElement('p');
        summaryContent.className = 'text-sm text-slate-700 whitespace-pre-wrap leading-relaxed bg-slate-50 border border-slate-200 rounded-xl px-4 py-3';
        summaryContent.appendChild(createTextFragment(summaryData.text || 'サマリーがありません。'));
        summarySection.append(summaryTitle, summaryContent);

        const summaryMetaParts = [];
        if (Number.isFinite(Number(summaryData.score))) {
            summaryMetaParts.push(`スコア: ${formatScore(summaryData.score)}`);
        }
        if (Number.isFinite(Number(summaryData.durationSeconds))) {
            const minutesRaw = Number(summaryData.durationSeconds) / 60;
            const minutes = minutesRaw > 0 ? Math.max(1, Math.round(minutesRaw)) : 0;
            summaryMetaParts.push(`所要時間: ${formatTotalTime(minutes)}`);
        }
        if (summaryMetaParts.length) {
            const statsLine = document.createElement('p');
            statsLine.className = 'text-xs text-slate-500';
            statsLine.textContent = summaryMetaParts.join(' / ');
            summarySection.appendChild(statsLine);
        }

        const skillEntries = summaryData.skills && typeof summaryData.skills === 'object'
            ? Object.entries(summaryData.skills)
            : [];
        const visibleSkills = skillEntries.filter(([, value]) => Number.isFinite(Number(value)) && Number(value) > 0);
        if (visibleSkills.length) {
            const skillsGrid = document.createElement('div');
            skillsGrid.className = 'grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs text-slate-600';
            DASHBOARD_SKILLS.forEach((skillKey) => {
                const scoreValue = Number(summaryData.skills?.[skillKey]);
                if (!Number.isFinite(scoreValue)) {
                    return;
                }
                const card = document.createElement('div');
                card.className = 'bg-slate-100 rounded-lg px-3 py-2 flex flex-col gap-1';
                const label = document.createElement('span');
                label.className = 'font-medium text-slate-600';
                label.textContent = SKILL_LABELS[skillKey] || skillKey;
                const score = document.createElement('span');
                score.className = 'text-base font-semibold text-slate-800';
                score.textContent = formatScore(scoreValue);
                card.append(label, score);
                skillsGrid.appendChild(card);
            });
            summarySection.appendChild(skillsGrid);
        }

        body.appendChild(summarySection);
    }

    dialog.append(header, body);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
            close();
        }
    });
}
