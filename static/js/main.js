import { state } from './state.js';
import { setupAudioCallbacks, startRecording, stopRecording } from './audio.js';
import { renderProfile, handleProfileSubmit, handleProfileAvatarChange } from './ui/profile.js';
import { renderDashboard, applyHistoryFilter, handleClearHistory, refreshHistory, setShowInterviewDetails } from './ui/dashboard.js';
import { handleAuth, logout, initialiseAuthTabs, setAuthDependencies } from './ui/auth.js';
import {
    handleSend,
    handleSetupSubmit,
    handleEndInterview,
    applyControlState,
    updateSendDisabled,
    setUserInputValue,
    appendFinalTranscript,
    updateInterimTranscript,
    resetInterviewState,
    setRefreshHistory,
    showInterviewDetails
} from './ui/interview.js';
import {
    showToast,
    createLucideIcons,
    scrollToTop,
    setStatus,
    getSelectedModeValue,
    setSelectedModeValue,
    autoResizeUserInput,
    updateModeSummaryLabel,
    updateModeIndicator
} from './ui/core.js';

// --- Navigation Logic ---

function switchView(viewName) {
    const loginViewEl = document.getElementById('login-view');
    const appShellEl = document.getElementById('app-shell');
    const appRoot = document.getElementById('app-root');
    const appHeader = document.getElementById('app-header');
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
            const userInputEl = document.getElementById('user-input');
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

function handleScroll() {
    const scrollToTopBtn = document.getElementById('scroll-to-top-btn');
    if (!scrollToTopBtn) return;
    const scrollTop = document.documentElement.scrollTop || document.body.scrollTop;
    const shouldShow = state.currentView === 'app' && scrollTop > 300;
    scrollToTopBtn.classList.toggle('hidden', !shouldShow);
}

function openProfileTab() {
    switchView('app');
    switchTab('profile-view');
    scrollToTop();
}

// --- Event Handlers ---

function initialiseEventHandlers() {
    document.getElementById('login-form').addEventListener('submit', handleAuth);
    document.getElementById('signup-form').addEventListener('submit', handleAuth);

    const startNewInterviewBtn = document.getElementById('start-new-interview-btn-top');
    const goToHistoryBtn = document.getElementById('go-to-history-tab-btn');
    const clearHistoryBtn = document.getElementById('clear-history-btn-hist');
    const cancelSetupBtn = document.getElementById('cancel-setup-btn');
    const setupForm = document.getElementById('setup-form');
    const endInterviewBtn = document.getElementById('end-interview-btn');

    const profileFormEl = document.getElementById('profile-form');
    const profileAvatarInputEl = document.getElementById('profile-avatar');
    const profileAvatarTriggerEl = document.getElementById('profile-avatar-trigger');

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

    const userInputEl = document.getElementById('user-input');
    const sendButtonEl = document.getElementById('send-button');
    const recordButtonEl = document.getElementById('record-voice-btn');
    const modeRadioEls = document.querySelectorAll('input[name="mode"]');
    const scrollToTopBtn = document.getElementById('scroll-to-top-btn');

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
    console.log('Bootstrap started');
    // Setup audio callbacks
    setupAudioCallbacks({
        onInterimTranscript: updateInterimTranscript,
        onFinalTranscript: appendFinalTranscript,
        onInputUpdate: setUserInputValue,
    });

    setRefreshHistory(refreshHistory);
    setShowInterviewDetails(showInterviewDetails);
    setAuthDependencies({ refreshHistory, resetInterviewState });

    // Listen for navigation events from other modules
    document.addEventListener('request-switch-view', (e) => {
        if (e.detail && e.detail.viewName) {
            switchView(e.detail.viewName);
        }
    });
    document.addEventListener('request-switch-tab', (e) => {
        if (e.detail && e.detail.tabId) {
            switchTab(e.detail.tabId);
        }
    });
    document.addEventListener('recording-state-changed', () => {
        applyControlState();
    });

    initialiseAuthTabs();
    initialiseEventHandlers();
    switchTab('top-page-view');
    switchView('login');
    updateSendDisabled(true);
    updateModeIndicator(state.currentMode);
    createLucideIcons();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
} else {
    bootstrap();
}
