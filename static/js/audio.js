import { API_BASE, PCM_TARGET_SAMPLE_RATE } from './config.js';
import { state } from './state.js';
import { showToast, setStatus, createLucideIcons, setPlayPauseButtonIcon, iconMarkup } from './ui/core.js';

let audioCallbacks = {
    onInterimTranscript: () => { },
    onFinalTranscript: () => { },
    onInputUpdate: () => { },
};

export function setupAudioCallbacks(callbacks) {
    audioCallbacks = { ...audioCallbacks, ...callbacks };
}

let sttSocket = null;
let recordingStream = null;
let audioContext = null;
let audioSourceNode = null;
let processorNode = null;
let gainNode = null;
let currentAiPlayer = null;
let liveTranscript = '';
let pendingTranscript = '';
let finalTranscript = ''; // Local variable to track transcript during recording

// Helper to reset local transcript state
export function resetTranscriptState(initialText = '') {
    liveTranscript = '';
    pendingTranscript = '';
    // Preserve any pre-existing text so new STT audio appends to it
    finalTranscript = initialText && initialText.trim() ? initialText : '';
}

export function stopRecordingStream() {
    if (!recordingStream) return;
    recordingStream.getTracks().forEach((track) => track.stop());
    recordingStream = null;
}

export function cleanupAudioGraph() {
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

export function setRecordingState(isRecording) {
    state.isRecording = isRecording;
    const recordButtonEl = document.getElementById('record-btn');
    const listeningIndicatorEl = document.getElementById('listening-indicator');

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
    // We need to call applyControlState, but it's in UI. 
    // Ideally we emit an event or call a shared state updater.
    // For now, we'll assume the UI updates itself or we import it.
    // import { applyControlState } from './ui/interview.js'; // Cycle risk.
    // Let's dispatch a custom event.
    document.dispatchEvent(new CustomEvent('recording-state-changed', { detail: { isRecording } }));
}

export async function startRecording() {
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
    const userInputEl = document.getElementById('user-input');
    const existingInput = userInputEl ? userInputEl.value : '';
    resetTranscriptState(existingInput);
    audioCallbacks.onInputUpdate(existingInput || '');
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
                    // Call UI to append final
                    finalTranscript = finalTranscript ? `${finalTranscript} ${pendingTranscript}` : pendingTranscript;
                    audioCallbacks.onFinalTranscript(finalTranscript);
                    pendingTranscript = '';
                }
                return;
            }
            console.log('[STT] received transcript', messageType, incomingText);
            if (messageType === 'final') {
                // Append to accumulated final transcript
                finalTranscript = finalTranscript ? `${finalTranscript} ${incomingText}` : incomingText;
                audioCallbacks.onFinalTranscript(finalTranscript);
                liveTranscript = '';
                pendingTranscript = '';
                return;
            }
            liveTranscript = incomingText;
            pendingTranscript = incomingText;
            // Show accumulated final text + current interim text
            const displayText = finalTranscript ? `${finalTranscript} ${incomingText}` : incomingText;
            audioCallbacks.onInterimTranscript(displayText);
        };

        sttSocket.onclose = () => {
            console.log('[STT] socket closed');
            sttSocket = null;
            // If there's pending transcript, add it to final
            if (pendingTranscript.trim()) {
                finalTranscript = finalTranscript ? `${finalTranscript} ${pendingTranscript}` : pendingTranscript;
                pendingTranscript = '';
            }
            // Update UI with final accumulated transcript
            if (finalTranscript.trim()) {
                audioCallbacks.onFinalTranscript(finalTranscript);
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

export function stopRecording() {
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

export function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return '0:00';
    }
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

export function stopCurrentAiAudio(options = {}) {
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

export function createMiniAudioPlayer(audioUrl, options = {}) {
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
