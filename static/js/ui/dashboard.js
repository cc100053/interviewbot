import { state } from '../state.js';
import { DASHBOARD_SKILLS, SKILL_LABELS } from '../config.js';
import { normalizeSummary, formatScore, formatTotalTime, formatDateToJst, estimateInterviewDurationSeconds } from '../utils.js';
import { showToast, iconMarkup, createLucideIcons, showConfirmDialog } from './core.js';
import { apiRequest } from '../api.js';

let showInterviewDetails = () => { };

export function setShowInterviewDetails(fn) {
    showInterviewDetails = fn;
}

let dashboardRadarChart = null;

export function calculateDashboardStats(history = []) {
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

export function renderDashboard(history = [], stats = null) {
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

    const skillBarElements = {
        logic: document.getElementById('stat-skill-logic-bar'),
        specificity: document.getElementById('stat-skill-specificity-bar'),
        expression: document.getElementById('stat-skill-expression-bar'),
        proactive: document.getElementById('stat-skill-proactive-bar'),
        selfaware: document.getElementById('stat-skill-selfaware-bar'),
    };

    const skillValues = {};
    DASHBOARD_SKILLS.forEach((key) => {
        const value = Number(mergedStats.skills[key]);
        skillValues[key] = Number.isFinite(value) ? value : 0;
        const element = skillElements[key];
        if (element) {
            element.textContent = formatScore(skillValues[key]);
        }
        const barElement = skillBarElements[key];
        if (barElement) {
            barElement.style.width = `${skillValues[key]}%`;
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

export function renderHistoryList(items = []) {
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
        li.className = 'bg-white p-4 sm:p-6 rounded-xl shadow-sm border border-gray-100 space-y-4 cursor-pointer hover:shadow-md transition-shadow';
        li.addEventListener('click', (e) => {
            if (e.target.closest('button') || e.target.closest('a')) return;
            showInterviewDetails(item);
        });

        const headerRow = document.createElement('div');
        headerRow.className = 'flex items-center justify-between';

        const dateEl = document.createElement('p');
        dateEl.className = 'flex items-center text-sm font-medium text-gray-700';
        dateEl.innerHTML = `${iconMarkup('calendar', 'w-4 h-4 mr-2 text-gray-500')}${formatDateToJst(item.createdAt || item.created_at)} `;

        const rightHeader = document.createElement('div');
        rightHeader.className = 'flex items-center gap-4';

        if (item.mode === 'interview' && summary && Number.isFinite(Number(summary.score))) {
            const score = Math.round(Number(summary.score));
            let scoreColor = 'text-green-600 bg-green-100';
            if (score < 80) scoreColor = 'text-yellow-600 bg-yellow-100';
            if (score < 60) scoreColor = 'text-red-600 bg-red-100';
            const scoreBadge = document.createElement('span');
            scoreBadge.className = `flex items-center text-sm font-semibold ${scoreColor} px-2.5 py-0.5 rounded-full`;
            scoreBadge.innerHTML = `${iconMarkup('award', 'w-4 h-4 mr-1.5')} スコア: ${score} 点`;
            scoreBadge.innerHTML = `${iconMarkup('award', 'w-4 h-4 mr-1.5')} スコア: ${score} 点`;
            rightHeader.appendChild(scoreBadge);
        }

        const chevron = document.createElement('span');
        chevron.className = 'text-gray-400 ml-2';
        chevron.innerHTML = iconMarkup('chevron-right', 'w-5 h-5');
        rightHeader.appendChild(chevron);

        // const detailsBtn = document.createElement('button');
        // detailsBtn.type = 'button';
        // detailsBtn.className = 'flex items-center text-sm font-medium text-blue-600 hover:text-blue-500';
        // detailsBtn.innerHTML = `詳細を見る ${iconMarkup('chevron-right', 'w-4 h-4 ml-1')} `;
        // detailsBtn.addEventListener('click', () => showInterviewDetails(item));
        // rightHeader.appendChild(detailsBtn);

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
            { icon: 'clock', label: '所要時間', value: `${durationMinutes} 分`, color: 'text-blue-500' },
            { icon: 'list', label: '質問数', value: `${questionCount} 問`, color: 'text-emerald-500' },
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

export function applyHistoryFilter(filter = 'all') {
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

export async function refreshHistory() {
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

export async function handleClearHistory() {
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
