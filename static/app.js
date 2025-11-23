const API_BASE = window.API_BASE_URL || '';
const thinkingMessages = [
  '回答を分析しています…',
  '最適なフィードバックをまとめています…',
  '次の質問を準備しています…',
];
const DASHBOARD_SKILLS = ['logic', 'specificity', 'expression', 'proactive', 'selfaware'];
const SKILL_LABELS = {
  logic: '論理構成力',
  specificity: '内容具体性',
  expression: '表現力',
  proactive: '積極性・意欲',
  selfaware: '自己理解度',
};

const PROFILE_STORAGE_KEY_BASE = 'poken_profile_v1';
const DEFAULT_AVATAR_SRC = 'static/photo/default.png';
const PROFILE_STATUS_DESCRIPTIONS = {
  書類選考: '応募書類の選考が進行中です。提出した資料を見直し、次のステップに備えましょう。',
  一次面接: '一次面接の段階です。想定問答や企業研究を引き続き行いましょう。',
  二次面接: '一次面接を通過しました。より深い質問に備えて準備を整えてください。',
  最終面接: '最終面接を控えています。志望動機や自分の強みを改めて整理しましょう。',
  内定: '内定おめでとうございます！条件確認や入社準備を進めましょう。',
};

function getProfileStorageKey(userId = '') {
  const trimmed = typeof userId === 'string' ? userId.trim() : '';
  return trimmed ? `${PROFILE_STORAGE_KEY_BASE}:${trimmed}` : PROFILE_STORAGE_KEY_BASE;
}

function getDefaultProfile() {
  return {
    name: '',
    email: '',
    status: '書類選考',
    role: '',
    notes: '',
    avatarData: DEFAULT_AVATAR_SRC,
  };
}

function loadProfileFromStorage(userId = '') {
  try {
    const key = getProfileStorageKey(userId);
    const stored = window.localStorage.getItem(key);
    if (!stored) {
      if (!userId) {
        try {
          const legacy = window.localStorage.getItem(PROFILE_STORAGE_KEY_BASE);
          if (legacy) {
            return { ...getDefaultProfile(), ...JSON.parse(legacy) };
          }
        } catch (legacyError) {
          console.warn('Failed to parse legacy profile', legacyError);
        }
      }
      return getDefaultProfile();
    }
    const parsed = JSON.parse(stored);
    const profile = { ...getDefaultProfile(), ...parsed };
    profile.avatarData = profile.avatarData || DEFAULT_AVATAR_SRC;
    return profile;
  } catch (error) {
    console.warn('Failed to load profile from storage', error);
    return getDefaultProfile();
  }
}

function saveProfileToStorage(profile, userId = '') {
  try {
    const key = getProfileStorageKey(userId);
    window.localStorage.setItem(key, JSON.stringify(profile));
    if (userId) {
      window.localStorage.removeItem(PROFILE_STORAGE_KEY_BASE);
    }
  } catch (error) {
    console.warn('Failed to save profile to storage', error);
  }
}

function normalizeSummary(summary) {
  if (!summary) {
    return null;
  }
  if (typeof summary === 'string') {
    const trimmed = summary.trim();
    if (!trimmed) {
      return null;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        return normalizeSummary(parsed);
      }
    } catch (error) {
      return { text: trimmed, skills: {}, score: undefined };
    }
    return { text: trimmed, skills: {}, score: undefined };
  }
  if (typeof summary !== 'object') {
    return { text: String(summary), skills: {}, score: undefined };
  }
  const result = { ...summary };
  if (typeof result.text !== 'string') {
    if (typeof result.summary === 'string') {
      result.text = result.summary;
    } else {
      result.text = '';
    }
  }
  const numericScore = Number(result.score ?? result.overallScore);
  if (Number.isFinite(numericScore)) {
    result.score = numericScore;
  } else {
    delete result.score;
  }
  const duration = Number(result.durationSeconds ?? result.duration_seconds);
  if (Number.isFinite(duration) && duration >= 0) {
    result.durationSeconds = Math.round(duration);
  } else {
    delete result.durationSeconds;
  }
  const skillsSource = result.skills;
  const normalizedSkills = {};
  if (skillsSource && typeof skillsSource === 'object') {
    DASHBOARD_SKILLS.forEach((key) => {
      const value = Number(skillsSource[key]);
      if (Number.isFinite(value)) {
        normalizedSkills[key] = value;
      }
    });
  }
  result.skills = normalizedSkills;
  return result;
}

function formatScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return '0';
  }
  return Number.isInteger(numeric) ? String(Math.trunc(numeric)) : numeric.toFixed(1);
}

function formatTotalTime(totalMinutes) {
  const minutes = Number(totalMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return '0h';
  }
  const rounded = Math.max(1, Math.round(minutes));
  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  if (hours && remainder) {
    return `${hours}h ${remainder}m`;
  }
  if (hours) {
    return `${hours}h`;
  }
  return `${rounded}m`;
}

const state = {
  token: null,
  currentUserId: '',
  currentView: 'login',
  activeTab: 'top-page-view',
  interviewId: null,
  chatHistory: [],
  interviewHistory: [],
  currentMode: 'training',
  controlsDisabled: true,
  isRecording: false,
  dashboardStats: null,
  historyFilter: 'all',
};

state.profile = loadProfileFromStorage();

const views = {
  login: document.getElementById('login-view'),
  app: document.getElementById('app-shell'),
};

const appHeader = document.getElementById('app-header');
const appRoot = document.getElementById('app-root');

const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');
const modeIndicatorEl = document.getElementById('mode-indicator');
const loginErrorAlert = document.getElementById('login-error-alert');
const loginErrorText = document.getElementById('login-error-text');
const signupErrorAlert = document.getElementById('signup-error-alert');
const signupErrorText = document.getElementById('signup-error-text');

let userInputEl;
let sendButtonEl;
let recordButtonEl;
let listeningIndicatorEl;
let modeRadioEls;
let modeSummaryEl;
let scrollToTopBtn;
let trainingStatusMessageEl;
let trainingStatusTextEl;
let profileFormEl;
let profileAvatarInputEl;
let profileAvatarPreviewEl;
let profileNameInputEl;
let profileEmailInputEl;
let profileStatusSelectEl;
let profileRoleInputEl;
let profileNotesInputEl;
let profileNameDisplayEl;
let profileStatusBadgeEl;
let profileStatusDescriptionEl;
let profileRoleDisplayEl;
let profileNotesDisplayEl;
let headerProfileAvatarEl;
let sttSocket = null;
let liveTranscript = '';
let finalTranscript = '';
let pendingTranscript = '';
let recordingStream = null;
let audioContext = null;
let audioSourceNode = null;
let processorNode = null;
let gainNode = null;
let currentAiPlayer = null;
const PCM_TARGET_SAMPLE_RATE = 16000;
let dashboardRadarChart = null;

function setStatus(message = '', visible = false) {
  if (!visible) {
    statusIndicator.classList.add('hidden');
    return;
  }
  statusText.textContent = message;
  statusIndicator.classList.remove('hidden');
}

function setTrainingStatusMessage(message = '') {
  if (!trainingStatusMessageEl || !trainingStatusTextEl) {
    return;
  }
  trainingStatusTextEl.textContent = message;
  trainingStatusMessageEl.classList.toggle('hidden', !message);
}

function autoResizeUserInput() {
  if (!userInputEl) {
    return;
  }
  userInputEl.style.height = 'auto';
  const minHeight = 110;
  const nextHeight = Math.max(userInputEl.scrollHeight, minHeight);
  userInputEl.style.height = `${nextHeight}px`;
}

function setUserInputValue(value) {
  if (!userInputEl) {
    return;
  }
  userInputEl.value = value;
  autoResizeUserInput();
}

function appendFinalTranscript(text) {
  const clean = text.trim();
  if (!clean) {
    return;
  }
  finalTranscript = finalTranscript ? `${finalTranscript}\n${clean}` : clean;
  pendingTranscript = '';
  setUserInputValue(finalTranscript);
}

function updateInterimTranscript(text) {
  const clean = text.trim();
  if (!clean) {
    return;
  }
  if (pendingTranscript && !clean.startsWith(pendingTranscript)) {
    appendFinalTranscript(pendingTranscript);
  }
  pendingTranscript = clean;
  const combined = [finalTranscript, pendingTranscript].filter(Boolean).join('\n');
  setUserInputValue(combined);
}

function createLucideIcons() {
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

function iconMarkup(name, className = 'w-5 h-5') {
  const classes = ['lucide-icon', className].filter(Boolean).join(' ');
  return `<i class="${classes}" data-lucide="${name}" aria-hidden="true"></i>`;
}

function setPlayPauseButtonIcon(button, isPlaying) {
  if (!button) return;
  button.innerHTML = iconMarkup(isPlaying ? 'pause' : 'play', 'w-5 h-5');
}

function applyControlState() {
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

function switchView(viewName) {
  const loginViewEl = views.login;
  const appShellEl = views.app;
  const openMenuBtnEl = document.getElementById('open-menu-btn');
  state.currentView = viewName;

  if (!loginViewEl || !appShellEl) {
    return;
  }

  if (viewName === 'login') {
    loginViewEl.classList.add('active');
    loginViewEl.classList.remove('hidden');
    appShellEl.classList.add('hidden');
    appRoot?.classList.add('hidden');
    appHeader?.classList.add('hidden');
    document.getElementById('scroll-to-top-btn')?.classList.add('hidden');
    switchTab('top-page-view');
    openMenuBtnEl?.classList.add('hidden');
  } else {
    loginViewEl.classList.remove('active');
    loginViewEl.classList.add('hidden');
    appShellEl.classList.remove('hidden');
    appRoot?.classList.remove('hidden');
    appHeader?.classList.remove('hidden');
    openMenuBtnEl?.classList.remove('hidden');
    handleScroll();
  }
}

function switchTab(targetViewId) {
  const viewId = targetViewId || 'top-page-view';
  const contentViews = document.querySelectorAll('.content-view');
  const tabButtons = document.querySelectorAll('.tab-nav-button');

  contentViews.forEach((view) => {
    if (view.id === viewId) {
      view.classList.add('active');
    } else {
      view.classList.remove('active');
    }
  });

  tabButtons.forEach((button) => {
    const isActive = button.dataset.targetView === viewId;
    button.classList.toggle('active', isActive);
  });

  state.activeTab = viewId;

  if (viewId === 'history-view') {
    applyHistoryFilter('all');
    if (state.token) {
      refreshHistory().catch((error) => {
        console.warn('Failed to refresh history on tab switch', error);
      });
    }
  }

  if (viewId === 'interview-chat-view') {
    setTimeout(() => {
      if (userInputEl) {
        userInputEl.focus();
      }
    }, 200);
  }

  if (viewId === 'profile-view') {
    renderProfile();
  }

  if (viewId === 'training-view') {
    updateModeSummaryLabel(getSelectedModeValue());
  }

  handleScroll();
}

function renderProfile() {
  if (!state.profile) {
    state.profile = getDefaultProfile();
  }
  const profile = state.profile;

  const avatarSrc = profile.avatarData || DEFAULT_AVATAR_SRC;

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
    const statusClass = profile.status === '内定'
      ? 'bg-emerald-100 text-emerald-700'
      : profile.status === '最終面接'
        ? 'bg-indigo-100 text-indigo-700'
        : profile.status === '二次面接'
          ? 'bg-purple-100 text-purple-700'
          : profile.status === '一次面接'
            ? 'bg-blue-100 text-blue-700'
            : 'bg-slate-200 text-slate-700';
    profileStatusBadgeEl.className = `${baseClass} ${statusClass}`;
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

function handleProfileSubmit(event) {
  event.preventDefault();
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

function handleProfileAvatarChange(event) {
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

function openProfileTab() {
  switchView('app');
  switchTab('profile-view');
  scrollToTop();
}

function showToast(message, type = 'info') {
  const colors = {
    info: 'bg-blue-600',
    error: 'bg-rose-500',
    warning: 'bg-amber-500',
  };
  const container = document.createElement('div');
  container.className = `${colors[type] ?? colors.info} fixed bottom-6 right-6 text-sm px-4 py-2 rounded-lg shadow-lg text-white`;
  container.textContent = message;
  document.body.appendChild(container);
  setTimeout(() => container.remove(), 2500);
}

function stopRecordingStream() {
  if (!recordingStream) return;
  recordingStream.getTracks().forEach((track) => track.stop());
  recordingStream = null;
}

function cleanupAudioGraph() {
  if (processorNode) {
    try {
      processorNode.disconnect();
    } catch (error) {
      console.warn('Failed to disconnect processor node', error);
    }
    processorNode.onaudioprocess = null;
    processorNode = null;
  }
  if (gainNode) {
    try {
      gainNode.disconnect();
    } catch (error) {
      console.warn('Failed to disconnect gain node', error);
    }
    gainNode = null;
  }
  if (audioSourceNode) {
    try {
      audioSourceNode.disconnect();
    } catch (error) {
      console.warn('Failed to disconnect source node', error);
    }
    audioSourceNode = null;
  }
  if (audioContext) {
    audioContext.close().catch((error) => {
      console.warn('Failed to close audio context', error);
    });
    audioContext = null;
  }
  stopRecordingStream();
}

function downsampleBuffer(buffer, inputSampleRate, targetSampleRate) {
  if (targetSampleRate >= inputSampleRate) {
    return buffer;
  }
  const sampleRateRatio = inputSampleRate / targetSampleRate;
  const newLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    let sum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i += 1) {
      sum += buffer[i];
      count += 1;
    }
    result[offsetResult] = count > 0 ? (sum / count) : 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function floatTo16BitPCM(floatBuffer) {
  const output = new Int16Array(floatBuffer.length);
  for (let i = 0; i < floatBuffer.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, floatBuffer[i]));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

function setRecordingState(isRecording) {
  state.isRecording = isRecording;
  if (recordButtonEl) {
    recordButtonEl.classList.toggle('recording', isRecording);
    recordButtonEl.innerHTML = isRecording
      ? '<span class="font-semibold text-sm text-rose-600" aria-hidden="true">停止</span><span class="sr-only">録音を停止</span>'
      : `<span class="sr-only">音声入力を開始</span>${iconMarkup('mic', 'w-5 h-5')}`;
    recordButtonEl.setAttribute('aria-pressed', String(isRecording));
    recordButtonEl.title = isRecording ? '録音を停止' : '音声で回答する';
    createLucideIcons();
  }
  if (listeningIndicatorEl) {
    listeningIndicatorEl.classList.toggle('hidden', !isRecording);
  }
  applyControlState();
}

async function startRecording() {
  if (state.isRecording) {
    return;
  }
  console.log('[STT] startRecording invoked');
  if (!state.interviewId) {
    showToast('面接を開始してください。', 'warning');
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('このブラウザは音声録音に対応していません。', 'error');
    return;
  }

  stopCurrentAiAudio();
  finalTranscript = '';
  pendingTranscript = '';
  setUserInputValue('');
  setStatus('音声認識を準備しています…', true);

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    console.log('[STT] obtained microphone stream');
    recordingStream = stream;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      showToast('音声認識に必要な機能がブラウザでサポートされていません。', 'error');
      cleanupAudioGraph();
      setRecordingState(false);
      setStatus('', false);
      return;
    }

    audioContext = new AudioCtx();
    await audioContext.resume().catch(() => { });
    const inputSampleRate = audioContext.sampleRate;
    console.log('[STT] audio context sample rate', inputSampleRate);

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = window.location.host;
    const basePath = (API_BASE || '').replace(/\/+$/, '');
    const wsPath = `${basePath}/ws/stt`;
    const wsUrl = `${wsProtocol}//${wsHost}${wsPath}`;
    console.log('[STT] connecting to websocket', wsUrl);

    sttSocket = new WebSocket(wsUrl);
    sttSocket.binaryType = 'arraybuffer';
    liveTranscript = '';

    sttSocket.onopen = () => {
      if (!sttSocket || sttSocket.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        sttSocket.send(JSON.stringify({ pcm: true, sampleRate: PCM_TARGET_SAMPLE_RATE }));
      } catch (error) {
        console.warn('Failed to send PCM hint', error);
      }

      audioSourceNode = audioContext.createMediaStreamSource(stream);
      processorNode = audioContext.createScriptProcessor(4096, 1, 1);
      gainNode = audioContext.createGain();
      gainNode.gain.value = 0;

      processorNode.onaudioprocess = (event) => {
        if (!sttSocket || sttSocket.readyState !== WebSocket.OPEN) {
          return;
        }
        const channelData = event.inputBuffer.getChannelData(0);
        const downsampled = downsampleBuffer(channelData, inputSampleRate, PCM_TARGET_SAMPLE_RATE);
        if (!downsampled || downsampled.length === 0) {
          return;
        }
        const pcmChunk = floatTo16BitPCM(downsampled);
        try {
          sttSocket.send(pcmChunk.buffer);
        } catch (sendError) {
          console.warn('Failed to send PCM chunk', sendError);
        }
      };

      audioSourceNode.connect(processorNode);
      processorNode.connect(gainNode);
      gainNode.connect(audioContext.destination);

      setRecordingState(true);
      setStatus('', false);
    };

    sttSocket.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        return;
      }
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch (parseError) {
        console.warn('Failed to parse STT payload', parseError);
        return;
      }
      if (!payload || typeof payload.text !== 'string') {
        return;
      }
      const messageType = payload.type || 'intermediate';
      const incomingText = payload.text.trim();
      if (!incomingText) {
        if (messageType === 'final' && pendingTranscript) {
          appendFinalTranscript(pendingTranscript);
        }
        return;
      }
      console.log('[STT] received transcript', messageType, incomingText);
      if (messageType === 'final') {
        appendFinalTranscript(incomingText);
        liveTranscript = '';
        return;
      }
      liveTranscript = incomingText;
      updateInterimTranscript(incomingText);
    };

    sttSocket.onclose = () => {
      console.log('[STT] socket closed');
      sttSocket = null;
      if (pendingTranscript.trim()) {
        appendFinalTranscript(pendingTranscript);
      }
      cleanupAudioGraph();
      setRecordingState(false);
      setStatus('', false);
    };

    sttSocket.onerror = (event) => {
      console.error('WebSocket Error:', event);
      showToast('音声認識との接続に失敗しました。', 'error');
      if (sttSocket) {
        try {
          sttSocket.close();
        } catch (error) {
          console.warn('Failed to close STT socket after error', error);
        }
      }
    };
  } catch (error) {
    console.error('Failed to start recording', error);
    showToast('マイクの使用が許可されませんでした。', 'error');
    if (sttSocket) {
      try {
        sttSocket.close();
      } catch (closeError) {
        console.warn('Failed to close STT socket after init failure', closeError);
      }
      sttSocket = null;
    }
    cleanupAudioGraph();
    setRecordingState(false);
    setStatus('', false);
  }
}

function stopRecording() {
  if (sttSocket && sttSocket.readyState === WebSocket.OPEN) {
    try {
      sttSocket.close();
    } catch (error) {
      console.warn('Failed to close STT socket', error);
    }
    return;
  }
  cleanupAudioGraph();
  setRecordingState(false);
  setStatus('', false);
}

function updateModeIndicator(mode) {
  if (!modeIndicatorEl) return;
  const label = mode === 'interview' ? '面接モード (最後にまとめてフィードバック)' : '訓練モード (毎回フィードバック)';
  modeIndicatorEl.textContent = state.interviewId ? `現在のモード：${label}` : '';
}

function updateModeSummaryLabel(modeValue) {
  if (!modeSummaryEl) return;
  const text =
    modeValue === 'interview'
      ? '現在の設定: 面接モード (最後にまとめてフィードバック)'
      : '現在の設定: 訓練モード (毎回フィードバック)';
  modeSummaryEl.textContent = text;
}

function getSelectedModeValue() {
  if (!modeRadioEls || !modeRadioEls.length) {
    return 'training';
  }
  const checked = Array.from(modeRadioEls).find((radio) => radio.checked);
  return checked ? checked.value : modeRadioEls[0].value;
}

function setSelectedModeValue(modeValue) {
  if (!modeRadioEls || !modeRadioEls.length) {
    updateModeSummaryLabel(modeValue);
    return;
  }
  let matched = false;
  modeRadioEls.forEach((radio, index) => {
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

function handleScroll() {
  if (!scrollToTopBtn) return;
  const scrollTop = document.documentElement.scrollTop || document.body.scrollTop;
  const shouldShow = state.currentView === 'app' && scrollTop > 300;
  scrollToTopBtn.classList.toggle('hidden', !shouldShow);
}

function scrollToTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showConfirmDialog(message) {
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

    actions.append(confirmBtn, cancelBtn); // 「クリアする」ボタンを左側に配置
    dialog.append(text, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
  });
}

function showInterviewDetails(interview) {
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

      if (entry.role === 'ai' && entry.audioUrl) {
        const player = createMiniAudioPlayer(entry.audioUrl, { autoPlay: false });
        const playerContainer = document.createElement('div');
        playerContainer.className = 'mt-2';
        playerContainer.appendChild(player.wrapper);
        row.appendChild(playerContainer);
      }

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

function showSummaryModal(summaryPayload) {
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

async function apiRequest(path, options = {}) {
  const { skipStatus = false, statusMessage, ...rest } = options;
  const headers = rest.headers ? { ...rest.headers } : {};
  if (!headers['Content-Type'] && !(rest.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  if (state.token) {
    headers['Authorization'] = `Bearer ${state.token}`;
  }
  const fetchOptions = { ...rest, headers };
  if (!skipStatus) {
    setStatus(statusMessage || '処理中です…', true);
  }
  try {
    const response = await fetch(`${API_BASE}${path}`, fetchOptions);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.detail || response.statusText);
    }
    if (response.status === 204) {
      return null;
    }
    return await response.json();
  } finally {
    if (!skipStatus) {
      setStatus('', false);
    }
  }
}

function randomThinkingMessage() {
  const index = Math.floor(Math.random() * thinkingMessages.length);
  return thinkingMessages[index];
}

function getChatHistoryElement() {
  return document.getElementById('chat-history');
}

function createTextFragment(text) {
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

function appendChatMessage({ role, content, audioUrl = '', autoPlay = true }) {
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

function appendUserMessage(content) {
  state.chatHistory.push({ role: 'user', content });
  appendChatMessage({ role: 'user', content, autoPlay: false });
}

function appendAiMessage(content, audioUrl = '', options = {}) {
  const { autoPlay = true } = options;
  state.chatHistory.push({ role: 'ai', content, audioUrl });
  appendChatMessage({ role: 'ai', content, audioUrl, autoPlay });
}

function stopCurrentAiAudio(options = {}) {
  const { resetPosition = true } = options;
  if (!currentAiPlayer || !currentAiPlayer.audio) {
    currentAiPlayer = null;
    return;
  }

  const { audio, playPauseBtn, progressBar, currentTimeEl } = currentAiPlayer;
  try {
    audio.pause();
    if (resetPosition) {
      audio.currentTime = 0;
      if (progressBar) {
        progressBar.value = 0;
      }
      if (currentTimeEl) {
        currentTimeEl.textContent = '0:00';
      }
    }
  } catch (error) {
    console.warn('Failed to stop AI audio playback', error);
  }
  if (playPauseBtn) {
    setPlayPauseButtonIcon(playPauseBtn, false);
    createLucideIcons();
  }
  currentAiPlayer = null;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0:00';
  }
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function createMiniAudioPlayer(audioUrl, options = {}) {
  const { autoPlay = false } = options;
  const playerWrapper = document.createElement('div');
  playerWrapper.className = 'mini-audio-player bg-slate-100 border border-slate-200 rounded-xl mt-3 p-3 shadow-sm';

  const controlRow = document.createElement('div');
  controlRow.className = 'flex items-center gap-3';

  const playPauseBtn = document.createElement('button');
  playPauseBtn.type = 'button';
  playPauseBtn.className = 'play-pause-btn text-blue-600 hover:text-blue-700 text-lg';
  setPlayPauseButtonIcon(playPauseBtn, false);

  const currentTimeEl = document.createElement('span');
  currentTimeEl.className = 'current-time text-xs w-12 text-right font-mono text-slate-600';
  currentTimeEl.textContent = '0:00';

  const progressBar = document.createElement('input');
  progressBar.type = 'range';
  progressBar.className = 'progress-bar flex-grow h-1.5 cursor-pointer accent-blue-600';
  progressBar.value = 0;
  progressBar.min = 0;
  progressBar.max = 0;
  progressBar.step = 0.1;

  const totalTimeEl = document.createElement('span');
  totalTimeEl.className = 'total-time text-xs w-12 font-mono text-slate-600';
  totalTimeEl.textContent = '0:00';

  controlRow.append(playPauseBtn, currentTimeEl, progressBar, totalTimeEl);
  playerWrapper.appendChild(controlRow);

  const audio = new Audio(audioUrl);
  audio.preload = 'metadata';

  let isSeeking = false;

  const syncFromAudio = () => {
    currentTimeEl.textContent = formatTime(audio.currentTime);
    if (!isSeeking) {
      progressBar.value = audio.currentTime;
    }
  };

  audio.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(audio.duration)) {
      totalTimeEl.textContent = formatTime(audio.duration);
      progressBar.max = audio.duration;
    }
  });

  audio.addEventListener('timeupdate', syncFromAudio);

  audio.addEventListener('play', () => {
    if (currentAiPlayer && currentAiPlayer.audio !== audio) {
      stopCurrentAiAudio({ resetPosition: false });
    }
    currentAiPlayer = {
      audio,
      playPauseBtn,
      progressBar,
      currentTimeEl,
    };
    setPlayPauseButtonIcon(playPauseBtn, true);
    createLucideIcons();
  });

  audio.addEventListener('pause', () => {
    if (currentAiPlayer && currentAiPlayer.audio === audio) {
      setPlayPauseButtonIcon(playPauseBtn, false);
      createLucideIcons();
    }
  });

  audio.addEventListener('ended', () => {
    setPlayPauseButtonIcon(playPauseBtn, false);
    createLucideIcons();
    progressBar.value = 0;
    currentTimeEl.textContent = '0:00';
    if (currentAiPlayer && currentAiPlayer.audio === audio) {
      currentAiPlayer = null;
    }
  });

  const seek = (event) => {
    const newPosition = parseFloat(event.target.value);
    if (!Number.isFinite(newPosition)) {
      return;
    }
    try {
      audio.currentTime = newPosition;
    } catch (error) {
      console.warn('Failed to seek AI audio', error);
    }
    currentTimeEl.textContent = formatTime(newPosition);
  };

  const handleSeekStart = () => {
    isSeeking = true;
  };

  const handleSeekEnd = () => {
    isSeeking = false;
  };

  progressBar.addEventListener('mousedown', handleSeekStart);
  progressBar.addEventListener('touchstart', handleSeekStart);
  progressBar.addEventListener('pointerdown', handleSeekStart);
  progressBar.addEventListener('mouseup', handleSeekEnd);
  progressBar.addEventListener('touchend', handleSeekEnd);
  progressBar.addEventListener('pointerup', handleSeekEnd);
  progressBar.addEventListener('mouseleave', handleSeekEnd);
  progressBar.addEventListener('blur', handleSeekEnd);

  progressBar.addEventListener('input', seek);
  progressBar.addEventListener('change', (event) => {
    seek(event);
    handleSeekEnd();
  });

  playPauseBtn.addEventListener('click', (event) => {
    event.preventDefault();
    if (audio.paused) {
      audio.play().catch((error) => {
        console.warn('Failed to play AI audio', error);
      });
    } else {
      audio.pause();
    }
  });

  if (autoPlay) {
    stopCurrentAiAudio({ resetPosition: false });
    audio.play().catch((error) => {
      console.warn('Failed to auto-play AI audio', error);
    });
  }

  return {
    wrapper: playerWrapper,
    audio,
    playPauseBtn,
    progressBar,
    currentTimeEl,
  };
}

function handleAiResponse(data) {
  if (!data) {
    appendAiMessage('回答を生成できませんでした。', '', { autoPlay: false });
    return;
  }
  const aiText = data.aiMessageText ?? data.aiMessage ?? '回答を生成できませんでした。';
  const audioUrl = data.aiAudioUrl || data.nextQuestionAudioUrl || '';
  appendAiMessage(aiText, audioUrl, { autoPlay: Boolean(audioUrl) });
}

function resetInterviewState(options = {}) {
  const { keepTab = false } = options;
  if (sttSocket && sttSocket.readyState === WebSocket.OPEN) {
    try {
      sttSocket.close();
    } catch (error) {
      console.warn('Failed to close STT socket during reset', error);
    }
  }
  sttSocket = null;
  cleanupAudioGraph();
  liveTranscript = '';
  finalTranscript = '';
  pendingTranscript = '';
  setRecordingState(false);
  stopCurrentAiAudio();

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
  if (!keepTab && state.currentView === 'app') {
    switchTab('top-page-view');
  }
}

async function handleAuth(event) {
  event.preventDefault();
  if (loginErrorAlert) {
    loginErrorAlert.classList.add('hidden');
  }
  if (signupErrorAlert) {
    signupErrorAlert.classList.add('hidden');
  }
  const form = event.target;
  const formData = new FormData(form);
  const payload = {
    userId: formData.get('userId'),
    password: formData.get('password'),
  };
  const target = form.id === 'signup-form' ? '/auth/signup' : '/auth/login';
  const statusMessage = form.id === 'signup-form' ? 'アカウントを作成しています…' : 'ログインしています…';
  try {
    const data = await apiRequest(target, {
      method: 'POST',
      body: JSON.stringify(payload),
      statusMessage,
    });
    state.token = data.access_token;
    const normalizedUserId = String(formData.get('userId') || '').trim();
    state.currentUserId = normalizedUserId;
    state.profile = loadProfileFromStorage(state.currentUserId);
    if (state.currentUserId) {
      try {
        window.localStorage.removeItem(PROFILE_STORAGE_KEY_BASE);
      } catch (removeError) {
        console.warn('Failed to clear legacy profile cache', removeError);
      }
    }
    renderProfile();
    showToast('ログインしました。', 'info');
    switchView('app');
    switchTab('top-page-view');
    if (window?.history?.replaceState) {
      window.history.replaceState(null, '', window.location.pathname);
    }
    try {
      await refreshHistory();
    } catch (historyError) {
      console.warn('Failed to load interview history', historyError);
    }
  } catch (error) {
    if (form.id === 'login-form' && loginErrorAlert && loginErrorText) {
      const fallbackMessage = 'ユーザーIDまたはパスワードが正しくありません。';
      const normalizedMessage = error?.message?.includes('Invalid user ID or password')
        ? fallbackMessage
        : (error?.message || fallbackMessage);
      loginErrorText.textContent = normalizedMessage;
      loginErrorAlert.classList.remove('hidden');
    } else if (form.id === 'signup-form' && signupErrorAlert && signupErrorText) {
      const fallbackMessage = 'このユーザーIDは既に使用されています。';
      const normalizedMessage = /already/i.test(error?.message || '')
        ? fallbackMessage
        : (error?.message || fallbackMessage);
      signupErrorText.textContent = normalizedMessage;
      signupErrorAlert.classList.remove('hidden');
    } else {
      showToast(error.message || '登録に失敗しました。', 'error');
    }
  }
}

async function refreshHistory() {
  if (!state.token) return;
  try {
    const interviews = await apiRequest('/interviews/', { method: 'GET', skipStatus: true });
    state.interviewHistory = interviews;
    let dashboardStats = null;
    try {
      dashboardStats = await apiRequest('/interviews/stats', { method: 'GET', skipStatus: true });
    } catch (statsError) {
      console.warn('Failed to load dashboard stats', statsError);
    }
    state.dashboardStats = dashboardStats && typeof dashboardStats === 'object' ? dashboardStats : null;
    renderDashboard(interviews, state.dashboardStats);
    applyHistoryFilter(state.historyFilter || 'all');
  } catch (error) {
    showToast('面接履歴の取得に失敗しました。', 'error');
  }
}

function formatDateToJst(isoString) {
  if (!isoString) return '-';
  const parsed = new Date(isoString);
  if (Number.isNaN(parsed.getTime())) {
    return isoString;
  }
  return parsed.toLocaleString('ja-JP', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Tokyo',
    hour12: false,
  });
}

function estimateInterviewDurationSeconds(interview) {
  if (!interview) return 0;
  const timestamps = [];
  const createdAt = interview.createdAt || interview.created_at;
  if (createdAt) {
    const created = new Date(createdAt);
    if (!Number.isNaN(created.getTime())) {
      timestamps.push(created.getTime());
    }
  }
  const transcript = Array.isArray(interview.transcript) ? interview.transcript : [];
  transcript.forEach((entry) => {
    if (!entry || !entry.timestamp) return;
    const parsed = new Date(entry.timestamp);
    if (!Number.isNaN(parsed.getTime())) {
      timestamps.push(parsed.getTime());
    }
  });
  if (timestamps.length < 2) {
    return 0;
  }
  const maxTime = Math.max(...timestamps);
  const minTime = Math.min(...timestamps);
  const diffMs = maxTime - minTime;
  if (!Number.isFinite(diffMs) || diffMs <= 0) {
    return 0;
  }
  return Math.max(0, Math.round(diffMs / 1000));
}

function calculateDashboardStats(history = []) {
  const stats = {
    totalSessions: Array.isArray(history) ? history.length : 0,
    avgScore: 0,
    totalTimeMinutes: 0,
    skills: Object.fromEntries(DASHBOARD_SKILLS.map((key) => [key, 0])),
  };

  if (!Array.isArray(history) || !history.length) {
    return stats;
  }

  let scoreSum = 0;
  let scoreCount = 0;
  let durationSeconds = 0;
  const skillSums = {};
  const skillCounts = {};
  DASHBOARD_SKILLS.forEach((key) => {
    skillSums[key] = 0;
    skillCounts[key] = 0;
  });

  history.forEach((item) => {
    const summary = normalizeSummary(item?.summaryReport);
    if (!summary) {
      durationSeconds += estimateInterviewDurationSeconds(item);
      return;
    }

    const scoreValue = Number(summary.score);
    if (Number.isFinite(scoreValue)) {
      scoreSum += scoreValue;
      scoreCount += 1;
    }

    const durationValue = Number(summary.durationSeconds);
    if (Number.isFinite(durationValue) && durationValue > 0) {
      durationSeconds += durationValue;
    } else {
      durationSeconds += estimateInterviewDurationSeconds(item);
    }

    const skills = summary.skills || {};
    DASHBOARD_SKILLS.forEach((key) => {
      const value = Number(skills[key]);
      if (Number.isFinite(value)) {
        skillSums[key] += value;
        skillCounts[key] += 1;
      }
    });
  });

  if (scoreCount) {
    stats.avgScore = Math.round((scoreSum / scoreCount) * 10) / 10;
  }
  stats.totalTimeMinutes = durationSeconds > 0 ? Math.max(0, Math.round(durationSeconds / 60)) : 0;
  DASHBOARD_SKILLS.forEach((key) => {
    stats.skills[key] = skillCounts[key]
      ? Math.round((skillSums[key] / skillCounts[key]) * 10) / 10
      : 0;
  });

  return stats;
}

function renderDashboard(history = [], stats = null) {
  const sessionsEl = document.getElementById('stat-sessions');
  const avgScoreEl = document.getElementById('stat-avg-score');
  const totalTimeEl = document.getElementById('stat-total-time');
  const recentList = document.getElementById('recent-history-list');

  const fallbackStats = calculateDashboardStats(history);
  const incomingStats = stats && typeof stats === 'object' ? stats : null;

  const avgScoreValue = Number(incomingStats?.avgScore);
  const totalTimeValue = Number(incomingStats?.totalTimeMinutes);
  const mergedSkills = {
    ...fallbackStats.skills,
    ...(incomingStats?.skills || {}),
  };

  const mergedStats = {
    totalSessions: incomingStats?.totalSessions ?? fallbackStats.totalSessions,
    avgScore: Number.isFinite(avgScoreValue) ? avgScoreValue : fallbackStats.avgScore,
    totalTimeMinutes: Number.isFinite(totalTimeValue) ? totalTimeValue : fallbackStats.totalTimeMinutes,
    skills: mergedSkills,
  };

  state.dashboardStats = mergedStats;

  if (sessionsEl) {
    sessionsEl.textContent = mergedStats.totalSessions ?? 0;
  }
  if (avgScoreEl) {
    avgScoreEl.textContent = formatScore(mergedStats.avgScore);
  }
  if (totalTimeEl) {
    totalTimeEl.textContent = formatTotalTime(mergedStats.totalTimeMinutes);
  }

  const skillElements = {
    logic: document.getElementById('stat-skill-logic'),
    specificity: document.getElementById('stat-skill-specificity'),
    expression: document.getElementById('stat-skill-expression'),
    proactive: document.getElementById('stat-skill-proactive'),
    selfaware: document.getElementById('stat-skill-selfaware'),
  };

  const skillValues = {};
  DASHBOARD_SKILLS.forEach((key) => {
    const value = Number(mergedStats.skills[key]);
    skillValues[key] = Number.isFinite(value) ? value : 0;
    const element = skillElements[key];
    if (element) {
      element.textContent = formatScore(skillValues[key]);
    }
  });

  const chartCanvas = document.getElementById('dashboard-radar-chart');
  if (chartCanvas && typeof Chart !== 'undefined') {
    const ctx = chartCanvas.getContext('2d');
    if (dashboardRadarChart) {
      dashboardRadarChart.destroy();
    }
    dashboardRadarChart = new Chart(ctx, {
      type: 'radar',
      data: {
        labels: ['論理構成力', '内容具体性', '自己理解度', '積極性・意欲', '表現力'],
        datasets: [
          {
            label: 'あなたのスキル評価',
            data: [
              skillValues.logic,
              skillValues.specificity,
              skillValues.selfaware,
              skillValues.proactive,
              skillValues.expression,
            ],
            fill: true,
            backgroundColor: 'rgba(139, 92, 246, 0.2)',
            borderColor: 'rgba(139, 92, 246, 1)',
            pointBackgroundColor: 'rgba(139, 92, 246, 1)',
            pointBorderColor: '#fff',
            pointHoverBackgroundColor: '#fff',
            pointHoverBorderColor: 'rgba(139, 92, 246, 1)',
          },
        ],
      },
      options: {
        maintainAspectRatio: false,
        responsive: true,
        scales: {
          r: {
            angleLines: { color: 'rgba(148, 163, 184, 0.2)' },
            grid: { color: 'rgba(148, 163, 184, 0.2)' },
            pointLabels: { font: { size: 12 }, color: '#475569' },
            ticks: {
              backdropColor: 'transparent',
              color: '#64748b',
              stepSize: 20,
            },
            suggestedMin: 0,
            suggestedMax: 100,
          },
        },
        plugins: {
          legend: {
            display: false,
          },
          tooltip: {
            backgroundColor: 'rgba(15, 23, 42, 0.9)',
            titleColor: '#f8fafc',
            bodyColor: '#f8fafc',
            borderColor: 'rgba(255, 255, 255, 0.1)',
            borderWidth: 1,
            callbacks: {
              label(context) {
                return `${context.formattedValue} pt`;
              },
            },
          },
        },
      },
    });
  }

  if (recentList) {
    recentList.innerHTML = '';
    const recentHistory = Array.isArray(history) ? history.slice(0, 3) : [];

    if (!recentHistory.length) {
      recentList.innerHTML = '<li class="text-sm text-gray-500">まだ面接履歴がありません。</li>';
    } else {
      recentHistory.forEach((item) => {
        const summary = normalizeSummary(item.summaryReport);
        const scoreText =
          summary && Number.isFinite(Number(summary.score))
            ? ` (スコア: ${formatScore(summary.score)})`
            : '';
        const createdAt = item.createdAt || item.created_at;
        const li = document.createElement('li');
        li.className =
          'flex items-center justify-between p-3 hover:bg-gray-50 rounded-lg cursor-pointer border border-gray-100';
        li.innerHTML = `
            <div>
              <p class="text-sm font-medium text-gray-800">${formatDateToJst(createdAt)}</p>
              <p class="text-xs text-gray-500 mt-1">
                タイプ: ${item.setup?.interviewType || 'N/A'} / モード: ${item.mode === 'interview' ? '面接' : '訓練'}${scoreText}
              </p>
            </div>
            <span class="text-gray-400">
              <i class="lucide-icon w-5 h-5" data-lucide="chevron-right" aria-hidden="true"></i>
            </span>
          `;
        li.addEventListener('click', () => showInterviewDetails(item));
        recentList.appendChild(li);
      });
    }
  }
  createLucideIcons();
}

function renderHistoryList(items = []) {
  const listEl = document.getElementById('history-list-hist');
  if (!listEl) return;

  listEl.innerHTML = '';

  if (!Array.isArray(items) || !items.length) {
    listEl.innerHTML = '<li class="text-sm text-gray-500">履歴がありません。</li>';
    return;
  }

  items.forEach((item) => {
    const summary = normalizeSummary(item.summaryReport);
    const li = document.createElement('li');
    li.className = 'bg-white p-4 sm:p-6 rounded-xl shadow-sm border border-gray-100 space-y-4';

    const headerRow = document.createElement('div');
    headerRow.className = 'flex items-center justify-between';

    const dateEl = document.createElement('p');
    dateEl.className = 'flex items-center text-sm font-medium text-gray-700';
    dateEl.innerHTML = `${iconMarkup('calendar', 'w-4 h-4 mr-2 text-gray-500')}${formatDateToJst(item.createdAt || item.created_at)}`;

    const rightHeader = document.createElement('div');
    rightHeader.className = 'flex items-center gap-4';

    if (item.mode === 'interview' && summary && Number.isFinite(Number(summary.score))) {
      const score = Math.round(Number(summary.score));
      let scoreColor = 'text-green-600 bg-green-100';
      if (score < 80) scoreColor = 'text-yellow-600 bg-yellow-100';
      if (score < 60) scoreColor = 'text-red-600 bg-red-100';
      const scoreBadge = document.createElement('span');
      scoreBadge.className = `flex items-center text-sm font-semibold ${scoreColor} px-2.5 py-0.5 rounded-full`;
      scoreBadge.innerHTML = `${iconMarkup('award', 'w-4 h-4 mr-1.5')} スコア: ${score}点`;
      rightHeader.appendChild(scoreBadge);
    }

    const detailsBtn = document.createElement('button');
    detailsBtn.type = 'button';
    detailsBtn.className = 'flex items-center text-sm font-medium text-blue-600 hover:text-blue-500';
    detailsBtn.innerHTML = `詳細を見る ${iconMarkup('chevron-right', 'w-4 h-4 ml-1')}`;
    detailsBtn.addEventListener('click', () => showInterviewDetails(item));
    rightHeader.appendChild(detailsBtn);

    headerRow.append(dateEl, rightHeader);
    li.appendChild(headerRow);

    const detailsGrid = document.createElement('div');
    detailsGrid.className = 'grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-5 pt-4 border-t border-gray-100';

    const durationMinutes =
      summary && Number.isFinite(Number(summary.durationSeconds))
        ? Math.max(1, Math.round(Number(summary.durationSeconds) / 60))
        : 0;
    const questionCount = Array.isArray(item.transcript)
      ? item.transcript.filter((entry) => entry && entry.role === 'ai').length
      : 0;

    const details = [
      { icon: 'message-square', label: 'タイプ', value: item.setup?.interviewType || 'N/A', color: 'text-indigo-500' },
      { icon: 'briefcase', label: '志望業界 & 職種', value: item.setup?.targetIndustry || 'N/A', color: 'text-amber-500' },
      { icon: 'clock', label: '所要時間', value: `${durationMinutes}分`, color: 'text-blue-500' },
      { icon: 'list', label: '質問数', value: `${questionCount}問`, color: 'text-emerald-500' },
    ];

    details.forEach((detail) => {
      const detailEl = document.createElement('div');
      detailEl.className = 'text-sm';
      detailEl.innerHTML = `
          <p class="flex items-center text-gray-500 font-medium">
            ${iconMarkup(detail.icon, `w-4 h-4 mr-2 ${detail.color || 'text-gray-500'}`)}
            <span>${detail.label}</span>
          </p>
          <p class="font-semibold text-gray-800 mt-1 pl-6">${detail.value}</p>
        `;
      detailsGrid.appendChild(detailEl);
    });

    li.appendChild(detailsGrid);

    const footerEl = document.createElement('div');
    footerEl.className = 'pt-3 border-t border-gray-100 flex items-center justify-between';
    const isInterviewMode = item.mode === 'interview';
    const badgeClass = isInterviewMode
      ? 'text-blue-50 bg-gradient-to-r from-indigo-500 to-blue-500 border border-indigo-200'
      : 'text-emerald-900 bg-gradient-to-r from-emerald-200 to-emerald-100 border border-emerald-200';
    const modeText = isInterviewMode ? '面接モード' : '訓練モード';
    footerEl.innerHTML = `
        <span class="text-xs font-semibold px-3 py-1 rounded-full inline-flex items-center gap-2 ${badgeClass}">
          ${iconMarkup(isInterviewMode ? 'users' : 'graduation-cap', 'w-4 h-4')}
          ${modeText}
        </span>
      `;
    li.appendChild(footerEl);

    listEl.appendChild(li);
  });

  createLucideIcons();
}
function applyHistoryFilter(filter = 'all') {
  state.historyFilter = filter;
  document.querySelectorAll('.history-filter-btn').forEach((btn) => {
    const isActive = (btn.dataset.filter || 'all') === filter;
    btn.classList.toggle('active', isActive);
  });
  const history = Array.isArray(state.interviewHistory) ? [...state.interviewHistory] : [];
  if (!history.length) {
    renderHistoryList([]);
    return;
  }

  const parseCreatedAt = (item) => {
    const value = item.createdAt || item.created_at;
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  let filteredHistory = history;
  if (filter === '7days') {
    const threshold = new Date();
    threshold.setDate(threshold.getDate() - 7);
    filteredHistory = history.filter((item) => {
      const created = parseCreatedAt(item);
      return created && created >= threshold;
    });
  } else if (filter === '30days') {
    const threshold = new Date();
    threshold.setDate(threshold.getDate() - 30);
    filteredHistory = history.filter((item) => {
      const created = parseCreatedAt(item);
      return created && created >= threshold;
    });
  } else if (filter === 'highscore') {
    filteredHistory = history
      .filter((item) => {
        if (item.mode !== 'interview') {
          return false;
        }
        const summary = normalizeSummary(item.summaryReport);
        return summary && Number.isFinite(Number(summary.score));
      })
      .sort((a, b) => {
        const scoreA = Number(normalizeSummary(a.summaryReport)?.score) || 0;
        const scoreB = Number(normalizeSummary(b.summaryReport)?.score) || 0;
        return scoreB - scoreA;
      });
  }

  renderHistoryList(filteredHistory);
}

async function handleClearHistory() {
  const confirmed = await showConfirmDialog('本当に履歴をクリアしますか？');
  if (!confirmed) {
    return;
  }
  try {
    await apiRequest('/interviews/clear', { method: 'DELETE', statusMessage: '履歴をクリアしています…' });
    await refreshHistory();
    showToast('履歴をクリアしました。', 'info');
  } catch (error) {
    showToast(error.message || '履歴のクリアに失敗しました。', 'error');
  }
}

async function handleSetupSubmit(event) {
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
    switchView('app');
    switchTab('interview-chat-view');
    appendAiMessage(
      data.questionText || '質問を取得できませんでした。',
      data.audioUrl || '',
      { autoPlay: Boolean(data.audioUrl) },
    );
    updateSendDisabled(false);
    showToast('面接を開始しました。', 'info');
    await refreshHistory();
    if (userInputEl) {
      userInputEl.focus();
    }
  } catch (error) {
    showToast(error.message || '面接の開始に失敗しました。', 'error');
  } finally {
    setTrainingStatusMessage('');
  }
}

async function handleEndInterview() {
  if (!state.interviewId) {
    resetInterviewState();
    switchView('app');
    switchTab('top-page-view');
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
      switchView('app');
      switchTab('top-page-view');
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
  switchView('app');
  switchTab('top-page-view');
  await refreshHistory();
  showToast('面接を終了しました。', 'info');
}

function updateSendDisabled(disabled) {
  state.controlsDisabled = disabled;
  applyControlState();
}

async function handleSend(event) {
  if (event) {
    event.preventDefault();
  }
  if (!state.interviewId) {
    showToast('面接を開始してください。', 'warning');
    return;
  }
  if (!userInputEl) return;
  const message = userInputEl.value.trim();
  if (!message) return;

  stopCurrentAiAudio();
  appendUserMessage(message);
  finalTranscript = '';
  pendingTranscript = '';
  liveTranscript = '';
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

function logout() {
  state.token = null;
  state.currentUserId = '';
  state.profile = getDefaultProfile();
  renderProfile();
  state.interviewHistory = [];
  state.dashboardStats = null;
  state.historyFilter = 'all';
  const menuOverlay = document.getElementById('menu-overlay');
  const menuPanel = document.getElementById('menu-panel');
  if (menuOverlay) menuOverlay.classList.add('hidden');
  if (menuPanel) menuPanel.classList.add('translate-x-full');
  resetInterviewState();
  switchView('login');
  showToast('ログアウトしました。', 'info');
}

function initialiseAuthTabs() {
  const loginBtn = document.getElementById('switch-to-login');
  const signupBtn = document.getElementById('switch-to-signup');
  const loginForm = document.getElementById('login-form');
  const signupForm = document.getElementById('signup-form');

  loginBtn.addEventListener('click', () => {
    loginBtn.classList.add('active-tab');
    signupBtn.classList.remove('active-tab');
    loginForm.classList.remove('hidden');
    signupForm.classList.add('hidden');
  });

  signupBtn.addEventListener('click', () => {
    signupBtn.classList.add('active-tab');
    loginBtn.classList.remove('active-tab');
    signupForm.classList.remove('hidden');
    loginForm.classList.add('hidden');
  });
}

function initialiseEventHandlers() {
  document.getElementById('login-form').addEventListener('submit', handleAuth);
  document.getElementById('signup-form').addEventListener('submit', handleAuth);

  const startNewInterviewBtn = document.getElementById('start-new-interview-btn-top');
  const goToHistoryBtn = document.getElementById('go-to-history-tab-btn');
  const clearHistoryBtn = document.getElementById('clear-history-btn-hist');
  const cancelSetupBtn = document.getElementById('cancel-setup-btn');
  const setupForm = document.getElementById('setup-form');
  const endInterviewBtn = document.getElementById('end-interview-btn');
  profileFormEl = document.getElementById('profile-form');
  profileAvatarInputEl = document.getElementById('profile-avatar');
  profileAvatarPreviewEl = document.getElementById('profile-avatar-preview');
  const profileAvatarTriggerEl = document.getElementById('profile-avatar-trigger');
  profileNameInputEl = document.getElementById('profile-name');
  profileEmailInputEl = document.getElementById('profile-email');
  profileStatusSelectEl = document.getElementById('profile-status');
  profileRoleInputEl = document.getElementById('profile-role');
  profileNotesInputEl = document.getElementById('profile-notes');
  profileNameDisplayEl = document.getElementById('profile-name-display');
  profileStatusBadgeEl = document.getElementById('profile-status-display');
  profileStatusDescriptionEl = document.getElementById('profile-status-description');
  profileRoleDisplayEl = document.getElementById('profile-role-display');
  profileNotesDisplayEl = document.getElementById('profile-notes-display');
  headerProfileAvatarEl = document.getElementById('header-profile-avatar');

  if (startNewInterviewBtn) {
    startNewInterviewBtn.addEventListener('click', () => {
      switchTab('training-view');
      setTimeout(() => {
        document.getElementById('interview-type')?.focus();
      }, 200);
    });
  }

  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', handleClearHistory);
  }

  const historyFilterButtons = document.querySelectorAll('.history-filter-btn');
  if (historyFilterButtons.length) {
    historyFilterButtons.forEach((button) => {
      button.addEventListener('click', () => {
        applyHistoryFilter(button.dataset.filter || 'all');
      });
    });
  }

  if (goToHistoryBtn) {
    goToHistoryBtn.addEventListener('click', () => {
      document.querySelector('.tab-nav-button[data-target-view="history-view"]')?.click();
    });
  }

  if (cancelSetupBtn) {
    cancelSetupBtn.addEventListener('click', () => {
      switchTab('top-page-view');
      if (setupForm) {
        setupForm.reset();
      }
      setSelectedModeValue('training');
    });
  }

  if (setupForm) {
    setupForm.addEventListener('submit', handleSetupSubmit);
  }

  if (endInterviewBtn) {
    endInterviewBtn.addEventListener('click', () => {
      handleEndInterview();
    });
  }

  userInputEl = document.getElementById('user-input');
  sendButtonEl = document.getElementById('send-button');
  recordButtonEl = document.getElementById('record-voice-btn');
  listeningIndicatorEl = document.getElementById('listening-indicator');
  modeSummaryEl = document.getElementById('current-setting-summary');
  modeRadioEls = document.querySelectorAll('input[name="mode"]');
  scrollToTopBtn = document.getElementById('scroll-to-top-btn');
  trainingStatusMessageEl = document.getElementById('training-status-message');
  trainingStatusTextEl = document.getElementById('training-status-text');
  if (userInputEl) {
    userInputEl.addEventListener('input', autoResizeUserInput);
    autoResizeUserInput();
  }

  const logoLink = document.getElementById('logo-link');
  const goToSignupBtn = document.getElementById('go-to-signup');
  const goToLoginBtn = document.getElementById('go-to-login');
  const tabButtons = document.querySelectorAll('.tab-nav-button');

  if (logoLink) {
    logoLink.addEventListener('click', (event) => {
      event.preventDefault();
      const menuOverlayEl = document.getElementById('menu-overlay');
      const menuPanelEl = document.getElementById('menu-panel');
      if (menuOverlayEl) menuOverlayEl.classList.add('hidden');
      if (menuPanelEl) menuPanelEl.classList.add('translate-x-full');
      if (state.token) {
        switchView('app');
        switchTab('top-page-view');
        scrollToTop();
      } else {
        switchView('login');
      }
    });
  }

  if (goToSignupBtn) {
    goToSignupBtn.addEventListener('click', () => {
      const signupTab = document.getElementById('switch-to-signup');
      if (signupTab) {
        signupTab.click();
      }
    });
  }

  if (goToLoginBtn) {
    goToLoginBtn.addEventListener('click', () => {
      const loginTab = document.getElementById('switch-to-login');
      if (loginTab) {
        loginTab.click();
      }
    });
  }

  tabButtons.forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.targetView) {
        switchTab(button.dataset.targetView);
      }
    });
  });

  if (sendButtonEl) {
    sendButtonEl.addEventListener('click', handleSend);
  }

  if (recordButtonEl) {
    recordButtonEl.addEventListener('click', () => {
      if (state.isRecording) {
        stopRecording();
      } else {
        startRecording();
      }
    });
  }

  if (userInputEl) {
    userInputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
      }
      if (event.key === 'Enter' && sendButtonEl && !sendButtonEl.disabled) {
        handleSend();
      }
    });
  }

  if (modeRadioEls && modeRadioEls.length) {
    modeRadioEls.forEach((radio) => {
      radio.addEventListener('change', (event) => {
        const value = event.target.value === 'interview' ? 'interview' : 'training';
        updateModeSummaryLabel(value);
      });
    });
  }
  updateModeSummaryLabel(getSelectedModeValue());

  const menuOverlay = document.getElementById('menu-overlay');
  const menuPanel = document.getElementById('menu-panel');
  const openMenuBtn = document.getElementById('open-menu-btn');
  const closeMenuBtn = document.getElementById('close-menu-btn');
  const logoutBtnMenu = document.getElementById('logout-btn-menu');
  const settingsBtn = document.getElementById('settings-btn');
  const profileMenuBtn = document.getElementById('user-profile-info-btn');

  const closeMenu = () => {
    if (menuOverlay) {
      menuOverlay.classList.add('hidden');
    }
    if (menuPanel) {
      menuPanel.classList.add('translate-x-full');
    }
  };

  const openMenu = () => {
    if (!state.token) {
      showToast('メニューはログイン後に利用できます。', 'warning');
      return;
    }
    if (menuOverlay) {
      menuOverlay.classList.remove('hidden');
    }
    if (menuPanel) {
      menuPanel.classList.remove('translate-x-full');
    }
  };

  if (openMenuBtn) openMenuBtn.addEventListener('click', openMenu);
  if (closeMenuBtn) closeMenuBtn.addEventListener('click', closeMenu);
  if (menuOverlay) menuOverlay.addEventListener('click', closeMenu);
  if (profileMenuBtn) {
    profileMenuBtn.addEventListener('click', () => {
      closeMenu();
      openProfileTab();
    });
  }
  if (logoutBtnMenu) {
    logoutBtnMenu.addEventListener('click', () => {
      closeMenu();
      logout();
    });
  }
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      closeMenu();
      showToast('設定メニューは準備中です。', 'info');
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeMenu();
    }
  });

  if (scrollToTopBtn) {
    scrollToTopBtn.addEventListener('click', scrollToTop);
  }
  window.addEventListener('scroll', handleScroll);
  handleScroll();

  if (profileFormEl) {
    profileFormEl.addEventListener('submit', handleProfileSubmit);
  }
  if (profileAvatarInputEl) {
    profileAvatarInputEl.addEventListener('change', handleProfileAvatarChange);
  }
  if (profileAvatarTriggerEl && profileAvatarInputEl) {
    profileAvatarTriggerEl.addEventListener('click', () => {
      profileAvatarInputEl.click();
    });
  }
  applyControlState();
  renderProfile();
}

function bootstrap() {
  initialiseAuthTabs();
  initialiseEventHandlers();
  switchTab('top-page-view');
  switchView('login');
  updateSendDisabled(true);
  updateModeIndicator(state.currentMode);
  createLucideIcons();
}

document.addEventListener('DOMContentLoaded', bootstrap);
