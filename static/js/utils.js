import { DASHBOARD_SKILLS } from './config.js';

export function normalizeSummary(summary) {
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

export function formatScore(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return '0';
    }
    return Number.isInteger(numeric) ? String(Math.trunc(numeric)) : numeric.toFixed(1);
}

export function formatTotalTime(totalMinutes) {
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

export function formatDateToJst(isoString) {
    if (!isoString) return '';
    const raw = String(isoString).trim();
    if (!raw) return '';
    const hasExplicitTimezone = /([zZ]|[+-]\d{2}:\d{2})$/.test(raw);
    const parseTarget = hasExplicitTimezone ? raw : `${raw}Z`;
    const date = new Date(parseTarget);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).format(date);
}

export function estimateInterviewDurationSeconds(interview) {
    if (!interview || !Array.isArray(interview.chat_history)) {
        return 0;
    }
    // Simple estimation: 1 minute per message exchange
    return interview.chat_history.length * 60;
}
