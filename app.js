/* ============================================
   MatchBoard – Application Logic
   ============================================ */

import {
  auth,
  db,
  loginWithGoogle,
  loginWithGoogleRedirect,
  checkRedirectResult,
  logoutUser,
  DEFAULT_ADMIN_EMAIL,
  DB_PATHS
} from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.17.0/firebase-auth.js';
import { ref, onValue, set, get } from 'https://www.gstatic.com/firebasejs/12.17.0/firebase-database.js';

// ── Constants ──
const STORAGE_KEY = 'matchboard_data';
const STATUSES = ['未連絡', '連絡中', 'OK', 'NG'];
const STATUS_FLOW = { '未連絡': '連絡中', '連絡中': 'OK', 'OK': 'NG', 'NG': '未連絡' };

// ── State ──
let state = { matches: [], teams: [], locations: [], members: [], viewMode: 'list' };
let confirmCallback = null;

// ── Multi-user & Cloud Sync State ──
let currentUser = null;
let allowedEmails = [DEFAULT_ADMIN_EMAIL.toLowerCase()];
let isAuthorized = false;
let isSavingToCloud = false;
let isInitialCloudLoadDone = false;

  // ── Utilities ──
  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  }

  function todayString() {
    const d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function getHolidayName(y, m, d) {
    if (m === 1 && d === 1) return '元日';
    if (m === 2 && d === 11) return '建国記念の日';
    if (m === 2 && d === 23) return '天皇誕生日';
    if (m === 4 && d === 29) return '昭和の日';
    if (m === 5 && d === 3) return '憲法記念日';
    if (m === 5 && d === 4) return 'みどりの日';
    if (m === 5 && d === 5) return 'こどもの日';
    if (m === 8 && d === 11) return '山の日';
    if (m === 11 && d === 3) return '文化の日';
    if (m === 11 && d === 23) return '勤労感謝の日';

    const date = new Date(y, m - 1, d);
    const day = date.getDay();
    const nthWeek = Math.floor((d - 1) / 7) + 1;

    if (day === 1) {
      if (m === 1 && nthWeek === 2) return '成人の日';
      if (m === 7 && nthWeek === 3) return '海の日';
      if (m === 9 && nthWeek === 3) return '敬老の日';
      if (m === 10 && nthWeek === 2) return 'スポーツの日';
    }

    if (m === 3) {
      const equinoxDay = Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
      if (d === equinoxDay) return '春分の日';
    }
    if (m === 9) {
      const equinoxDay = Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
      if (d === equinoxDay) return '秋分の日';
    }

    if (day === 1) {
      const prev = new Date(y, m - 1, d - 1);
      const pY = prev.getFullYear();
      const pM = prev.getMonth() + 1;
      const pD = prev.getDate();
      if (getHolidayName(pY, pM, pD)) {
        return '振替休日';
      }
    }

    return null;
  }

  function formatDate(dateStr, asHtml = false) {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-');
    const date = new Date(y, parseInt(m) - 1, d);
    const day = date.getDay();
    const weeks = ['日', '月', '火', '水', '木', '金', '土'];
    const weekName = weeks[day];
    
    let style = '';
    const holidayName = getHolidayName(parseInt(y), parseInt(m), parseInt(d));
    if (holidayName) {
      style = 'color: #ef4444; font-weight: bold;';
    } else if (day === 6) {
      style = 'color: #3b82f6; font-weight: bold;';
    }

    if (asHtml) {
      const titleText = holidayName ? ` title="${holidayName}"` : '';
      const dayLabel = style ? `<span style="${style}"${titleText}>${weekName}</span>` : weekName;
      return `${parseInt(m)}月${parseInt(d)}日(${dayLabel})`;
    } else {
      return `${parseInt(m)}月${parseInt(d)}日(${weekName})`;
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function getCategoryBadge(cat) {
    if (cat === '一般') return `<span style="display:inline-block; padding: 2px 6px; background: rgba(59,130,246,0.15); color: #3b82f6; border-radius: 4px; font-size: 10px; border: 1px solid rgba(59,130,246,0.3); margin-right: 6px;">一般</span>`;
    if (cat === 'シニア') return `<span style="display:inline-block; padding: 2px 6px; background: rgba(139,92,246,0.15); color: #8b5cf6; border-radius: 4px; font-size: 10px; border: 1px solid rgba(139,92,246,0.3); margin-right: 6px;">シニア</span>`;
    if (cat === '両方') return `<span style="display:inline-block; padding: 2px 6px; background: rgba(16,185,129,0.15); color: #10b981; border-radius: 4px; font-size: 10px; border: 1px solid rgba(16,185,129,0.3); margin-right: 6px;">両方</span>`;
    return '';
  }

  // ── Storage ──
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        state = { ...state, ...parsed };
        if (!Array.isArray(state.matches)) state.matches = [];
        if (!Array.isArray(state.teams)) state.teams = [];
        if (!Array.isArray(state.locations)) state.locations = [];
        if (!Array.isArray(state.members)) state.members = [];
      }
      
      let changed = false;
      if (!state.members) {
        state.members = [];
        changed = true;
      }

      if (state.members) {
        state.members.forEach(m => {
          if (m.number !== undefined) {
            m.uniformYellow = m.number;
            delete m.number;
            changed = true;
          }
          if (!m.category) {
            m.category = 'シニア';
            changed = true;
          }
        });
      }

      state.matches.forEach(m => {
        if (m.participantIds) {
          m.participants = {};
          m.participantIds.forEach(id => {
            m.participants[id] = '参加';
          });
          delete m.participantIds;
          changed = true;
        }
        if (!m.participants) {
          m.participants = {};
          changed = true;
        }
      });
      if (changed) saveState();
    } catch (e) {
      console.warn('Failed to load state:', e);
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('Failed to save state:', e);
    }

    if (isAuthorized && currentUser) {
      saveToCloud();
    }
  }

  let saveToCloudTimeout = null;
  function saveToCloud() {
    updateSyncBadge('syncing');
    if (saveToCloudTimeout) clearTimeout(saveToCloudTimeout);
    saveToCloudTimeout = setTimeout(async () => {
      isSavingToCloud = true;
      try {
        const dataRef = ref(db, DB_PATHS.DATA);
        await set(dataRef, {
          matches: state.matches || [],
          teams: state.teams || [],
          locations: state.locations || [],
          members: state.members || [],
          lastUpdated: Date.now(),
          updatedBy: currentUser ? currentUser.email : 'unknown'
        });
        updateSyncBadge('synced');
      } catch (err) {
        console.error('Failed to sync to cloud:', err);
        updateSyncBadge('error');
      } finally {
        setTimeout(() => {
          isSavingToCloud = false;
        }, 300);
      }
    }, 400);
  }

  function updateSyncBadge(status) {
    const badge = $('sync-status-badge');
    if (!badge) return;
    badge.className = 'sync-badge';
    const textSpan = badge.querySelector('.sync-text');
    if (status === 'syncing') {
      badge.classList.add('syncing');
      if (textSpan) textSpan.textContent = '保存中...';
    } else if (status === 'error') {
      badge.classList.add('error');
      if (textSpan) textSpan.textContent = '同期エラー';
    } else {
      if (textSpan) textSpan.textContent = '同期完了';
    }
  }

  // ── Migrations ──
  function migrateLocationsV1() {
    if (localStorage.getItem('migrated_locations_v1')) return;
    localStorage.setItem('migrated_locations_v1', 'true');
  }

  function migrateTypesV1() {
    if (localStorage.getItem('migrated_types_v1')) return;
    localStorage.setItem('migrated_types_v1', 'true');

    state.matches.forEach(match => {
      const oldName = match.name || '';
      let newType = 'TM';
      
      if (oldName.includes('リーグ')) {
        newType = '中野区リーグ';
      } else if (match.type === '大会' || oldName.includes('大会')) {
        newType = 'ミニサッカー大会';
      }

      match.type = newType;
    });

    saveState();
  }

  function importSchedule() {
    if (localStorage.getItem('imported_schedule_v2')) return;
    localStorage.setItem('imported_schedule_v2', 'true');
  }

  // ── DOM References ──
  const $ = (id) => document.getElementById(id);

  const dom = {
    togglePastMatches: $('toggle-past-matches'),
    btnOpenLocationModal: $('btn-open-location-modal'),
    matchGrid: $('match-grid'),
    emptyState: $('empty-state'),
    // Match modal
    modalMatch: $('modal-match'),
    modalMatchTitle: $('modal-match-title'),
    formMatch: $('form-match'),
    matchId: $('match-id'),
    matchCategory: $('match-category'),
    matchDate: $('match-date'),
    matchTime: $('match-time'),
    matchTimeManual: $('match-time-manual'),
    matchLocation: $('match-location'),
    matchTeamCount: $('match-team-count'),
    matchAutoMatch: $('match-auto-match'),
    matchCancelled: $('match-cancelled'),
    groupMatchCancelled: $('group-match-cancelled'),
    typeSelector: $('type-selector'),
    btnSubmitMatch: $('btn-submit-match'),
    // Candidate modal
    modalCandidate: $('modal-candidate'),
    modalCandidateTitle: $('modal-candidate-title'),
    formCandidate: $('form-candidate'),
    // Analytics modal
    modalAnalytics: $('modal-analytics'),
    modalAnalyticsClose: $('modal-analytics-close'),
    analyticsPeriod: $('analytics-period'),
    analyticsContent: $('analytics-content'),
    candidateMatchId: $('candidate-match-id'),
    candidateId: $('candidate-id'),
    candidateTeamSelect: $('candidate-team-select'),
    groupCandidateParticipation: $('group-candidate-participation-category'),
    candidateParticipationRadios: document.getElementsByName('candidate-participation-category'),
    candidateNote: $('candidate-note'),
    btnSubmitCandidate: $('btn-submit-candidate'),
    // Team Schedule
    modalTeamSchedule: $('modal-team-schedule'),
    modalTeamScheduleTitle: $('modal-team-schedule-title'),
    modalTeamScheduleClose: $('modal-team-schedule-close'),
    btnCopyTeamSchedule: $('btn-copy-team-schedule'),
    teamScheduleContent: $('team-schedule-content'),
    // Member Schedule
    modalMemberSchedule: $('modal-member-schedule'),
    modalMemberScheduleTitle: $('modal-member-schedule-title'),
    btnCopyMemberSchedule: $('btn-copy-member-schedule'),
    memberScheduleContent: $('member-schedule-content'),
    // Member modal & Participants
    btnOpenMemberModal: $('btn-open-member-modal'),
    modalMember: $('modal-member'),
    formMember: $('form-member'),
    memberId: $('member-id'),
    memberCategory: $('member-category'),
    memberName: $('member-name'),
    memberUniformYellow: $('member-uniform-yellow'),
    memberUniformRed: $('member-uniform-red'),
    memberAffiliation: $('member-affiliation'),
    memberNote: $('member-note'),
    memberPriority: $('member-priority'),
    memberFilterText: $('member-filter-text'),
    memberFilterCategory: $('member-filter-category'),
    memberFilterPriority: $('member-filter-priority'),
    memberListContent: $('member-list-content'),
    modalParticipants: $('modal-participants'),
    participantsMatchId: $('participants-match-id'),
    participantsFilterText: $('participants-filter-text'),
    participantsFilterCategory: $('participants-filter-category'),
    participantsFilterPriority: $('participants-filter-priority'),
    participantsListContent: $('participants-list-content'),
    // Team modal
    modalTeam: $('modal-team'),
    formTeam: $('form-team'),
    teamId: $('team-id'),
    teamName: $('team-name'),
    teamAffiliation: $('team-affiliation'),
    teamCategory: $('team-category'),
    teamListContent: $('team-list-content'),
    // Location modal
    modalLocation: $('modal-location'),
    formLocation: $('form-location'),
    locationId: $('location-id'),
    locationName: $('location-name'),
    locationListContent: $('location-list-content'),
    // Confirm dialog
    confirmDialog: $('confirm-dialog'),
    confirmIcon: $('confirm-icon'),
    confirmTitle: $('confirm-title'),
    confirmMessage: $('confirm-message'),
    confirmOk: $('confirm-ok'),
    confirmCancel: $('confirm-cancel'),
    // Toast
    toastContainer: $('toast-container'),
  };

  // ── Past Matches Toggle ──
  function initPastMatchesToggle() {
    if (state.showPastMatches === undefined) state.showPastMatches = false;
    dom.togglePastMatches.checked = state.showPastMatches;
    dom.togglePastMatches.addEventListener('change', (e) => {
      state.showPastMatches = e.target.checked;
      saveState();
      render();
    });
  }

  // ── Match Type ──
  let selectedType = 'TM';

  function initTypeSelector() {
    const options = dom.typeSelector.querySelectorAll('.type-option');
    options.forEach(opt => {
      opt.addEventListener('click', () => {
        options.forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        selectedType = opt.dataset.type;

        if (selectedType === '中野区リーグ') {
          dom.matchAutoMatch.checked = true;
          $('match-format').value = '11人制';
          $('match-recruit-count').value = 13;
        }
        if (selectedType === 'ミニサッカー大会') {
          $('match-format').value = '8人制';
          $('match-recruit-count').value = 10;
        }
        if (selectedType === 'ミニサッカー大会' || selectedType === '中野区リーグ') {
          $('match-shinpad').checked = true;
        }
      });
    });
  }

  function setTypeSelector(type) {
    selectedType = type;
    const options = dom.typeSelector.querySelectorAll('.type-option');
    options.forEach(opt => {
      opt.classList.toggle('selected', opt.dataset.type === type);
    });
  }

  // ── Modal Helpers ──
  function openModal(overlay) {
    overlay.classList.add('show');
    document.body.style.overflow = 'hidden';
  }

  function closeModal(overlay) {
    overlay.classList.remove('show');
    document.body.style.overflow = '';
  }

  // ── Toast ──
  function showToast(message, icon = '✅') {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<span class="toast-icon">${icon}</span><span>${message}</span>`;
    dom.toastContainer.appendChild(toast);
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 3000);
  }

  // ── Confirm Dialog ──
  function showConfirm(title, message, callback, icon = '⚠️') {
    dom.confirmIcon.textContent = icon;
    dom.confirmTitle.textContent = title;
    dom.confirmMessage.textContent = message;
    confirmCallback = callback;
    dom.confirmDialog.classList.add('show');
  }

  // ── Analytics ──
  function openAnalyticsModal() {
    populateAnalyticsPeriods();
    renderAnalytics();
    openModal(dom.modalAnalytics);
  }

  function populateAnalyticsPeriods() {
    const periods = new Set();
    state.matches.forEach(m => {
      if (!m.date) return;
      const [y, mon, d] = m.date.split('-');
      periods.add(`${y}年`);
      periods.add(`${y}年${parseInt(mon)}月`);
    });
    
    let html = '<option value="all">全期間</option>';
    Array.from(periods).sort().reverse().forEach(p => {
      html += `<option value="${p}">${p}</option>`;
    });
    dom.analyticsPeriod.innerHTML = html;
  }

  function renderAnalytics() {
    const period = dom.analyticsPeriod.value;
    
    let targets = state.matches.filter(m => !m.isAutoMatch);
    if (period !== 'all') {
      targets = targets.filter(m => {
        if (!m.date) return false;
        const [y, mon, d] = m.date.split('-');
        const yStr = `${y}年`;
        const ymStr = `${y}年${parseInt(mon)}月`;
        return period === yStr || period === ymStr;
      });
    }

    if (targets.length === 0) {
      dom.analyticsContent.innerHTML = '<div style="color:var(--text-muted); text-align:center;">対象データがありません</div>';
      return;
    }

    const teamCounts = {};
    state.teams.forEach(t => {
      if (t.category === '両方') {
        teamCounts[t.id + '_一般'] = { ...t, category: '一般', count: 0 };
        teamCounts[t.id + '_シニア'] = { ...t, category: 'シニア', count: 0 };
      } else {
        teamCounts[t.id] = { ...t, count: 0 };
      }
    });

    targets.forEach(m => {
      m.candidates.forEach(c => {
        if (c.status === 'OK') {
          const originalTeam = state.teams.find(t => t.id === c.teamId);
          let key = c.teamId;
          if (originalTeam && originalTeam.category === '両方') {
            key = c.teamId + '_' + (c.category || '一般');
          }
          if (teamCounts[key]) {
            teamCounts[key].count += 1;
          }
        }
      });
    });

    const sortedTeams = Object.values(teamCounts).sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (a.name !== b.name) return a.name.localeCompare(b.name);
      return a.category.localeCompare(b.category);
    });

    let html = `
      <div style="background: var(--bg-secondary); border-radius: var(--radius-md); overflow: hidden; box-shadow: inset 0 0 0 1px var(--border-subtle);">
        <table style="width: 100%; border-collapse: collapse; text-align: left;">
          <thead>
            <tr style="border-bottom: 1px solid var(--border-subtle); background: rgba(0,0,0,0.02);">
              <th style="padding: 12px 16px; font-weight: 600; font-size: 12px; color: var(--text-muted); width: 60px;">順位</th>
              <th style="padding: 12px 16px; font-weight: 600; font-size: 12px; color: var(--text-muted);">チーム</th>
              <th style="padding: 12px 16px; font-weight: 600; font-size: 12px; color: var(--text-muted); text-align: right; width: 80px;">試合数</th>
            </tr>
          </thead>
          <tbody>
    `;

    let prevCount = -1;
    let displayRank = 1;
    
    sortedTeams.forEach((t, i) => {
      if (t.count !== prevCount) {
        displayRank = i + 1;
        prevCount = t.count;
      }
      
      let rankHtml = displayRank;
      if (displayRank === 1 && t.count > 0) rankHtml = '🥇';
      else if (displayRank === 2 && t.count > 0) rankHtml = '🥈';
      else if (displayRank === 3 && t.count > 0) rankHtml = '🥉';

      const catBadge = getCategoryBadge(t.category || '一般');

      html += `
        <tr style="border-bottom: 1px solid var(--border-subtle);">
          <td style="padding: 12px 16px; font-size: 14px; font-weight: ${displayRank <= 3 && t.count > 0 ? '700' : '500'}; color: ${displayRank <= 3 && t.count > 0 ? 'var(--text-primary)' : 'var(--text-secondary)'};">${rankHtml}</td>
          <td style="padding: 12px 16px;">
            <div style="font-weight: 500; color: var(--text-primary); font-size: 14px; display: flex; align-items: center; gap: 8px;">
              ${escapeHtml(t.name)}
            </div>
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px; display: flex; align-items: center;">
              ${catBadge}
              ${t.affiliation ? `<span>${escapeHtml(t.affiliation)}</span>` : ''}
            </div>
          </td>
          <td style="padding: 12px 16px; text-align: right; font-weight: 600; font-size: 15px;">${t.count}<span style="font-size:12px; font-weight:normal; color:var(--text-muted); margin-left:2px;">回</span></td>
        </tr>
      `;
    });

    html += `
          </tbody>
        </table>
      </div>
    `;

    dom.analyticsContent.innerHTML = html;
  }

  // ── Render Match Board ──
  function render() {
    let visibleMatches = state.matches;
    if (!state.showPastMatches) {
      const today = todayString();
      visibleMatches = state.matches.filter(m => !m.date || m.date >= today);
    }

    if (visibleMatches.length === 0) {
      dom.emptyState.style.display = '';
      dom.matchGrid.style.display = 'none';
    } else {
      dom.emptyState.style.display = 'none';
      dom.matchGrid.style.display = '';
    }

    const sorted = [...visibleMatches].sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date.localeCompare(b.date);
    });

    dom.matchGrid.innerHTML = sorted.map(match => renderMatchCard(match)).join('');
    attachCardEvents();
  }

  function renderMatchCard(match) {
    const okTeams = match.candidates.filter(c => c.status === 'OK');
    const okCount = okTeams.length;
    const needed = Math.max(0, match.teamCount - 1);
    const progressPct = needed > 0 ? Math.min(100, (okCount / needed) * 100) : 0;
    const isComplete = okCount >= needed && needed > 0;
    
    const pStatusCounts = { '参加': 0, '返答待ち': 0, '不参加': 0, '声掛検討': 0 };
    if (match.participants) {
      Object.values(match.participants).forEach(status => {
        let s = status;
        if (s === '検討中') s = '声掛検討';
        if (pStatusCounts[s] !== undefined) {
          pStatusCounts[s]++;
        }
      });
    }

    // Category Badge
    const cat = match.category || '一般';
    let catBadgeClass = 'badge-category-general';
    let catDisplayName = '🏃‍♂️ 一般';
    if (cat === 'シニア') {
      catBadgeClass = 'badge-category-senior';
      catDisplayName = '👴 シニア';
    } else if (cat === '制限なし' || cat === '年齢制限なし') {
      catBadgeClass = 'badge-category-none';
      catDisplayName = '♾️ 制限なし';
    }

    let typeBadgeHtml = '';
    if (match.type === 'TM') {
      typeBadgeHtml = '<span class="badge badge-tm">🤝 TM</span>';
    } else if (match.type === '中野区リーグ') {
      typeBadgeHtml = '<span class="badge badge-league">🏅 区リーグ</span>';
    } else if (match.type === 'ミニサッカー大会') {
      typeBadgeHtml = '<span class="badge badge-tournament">🏆 ミニサッカー</span>';
    } else {
      typeBadgeHtml = `<span class="badge badge-league">⚽ ${escapeHtml(match.type)}</span>`;
    }

    const autoMatchBadgeHtml = match.isAutoMatch ? `<span class="badge" style="background: var(--bg-tertiary); color: var(--text-muted); border-color: var(--border-subtle);">自動</span>` : '';

    let statusBadgeHtml = '';
    if (match.isCancelled) {
      statusBadgeHtml = `<span class="badge badge-match-status cancelled">中止 ❌</span>`;
    } else if (!match.isAutoMatch) {
      statusBadgeHtml = `<span class="badge badge-match-status ${isComplete ? 'complete' : ''}">${isComplete ? '成立！ ✅' : `調整中 ${okCount}/${needed}`}</span>`;
    }

    const candidateRows = match.candidates.map(c => renderCandidateItem(match.id, c)).join('');

    const loc = state.locations.find(l => l.id === match.locationId);
    const locHtml = loc ? `<div class="match-location">📍 ${escapeHtml(loc.name)}</div>` : '';

    return `
      <div class="match-card ${match._expanded ? 'expanded' : ''} ${match.isCancelled ? 'cancelled' : ''}" data-match-id="${match.id}">
        <div class="match-card-header" data-action="toggle" data-match-id="${match.id}">
          <div class="mheader-date">
            <span class="mdate-icon">📅</span>
            <div class="mdate-text">
              <span style="font-weight:600;">${match.date ? formatDate(match.date, true) : '日程未定'}</span>
              ${match.time ? `<span class="mtime-badge">${escapeHtml(match.time)}</span>` : ''}
            </div>
          </div>
          
          <div class="mheader-badges">
            <span class="badge ${catBadgeClass}">${catDisplayName}</span>
            ${typeBadgeHtml}
            <span class="badge badge-team-count">${match.teamCount}チーム</span>
            ${autoMatchBadgeHtml}
            ${statusBadgeHtml}
          </div>
          
          <div class="mheader-location" title="${loc ? escapeHtml(loc.name) : '未定'}">
            📍 ${loc ? escapeHtml(loc.name) : '未定'}
          </div>
          
          <div class="mheader-members">
            <button class="badge btn-manage-participants-badge" data-action="manage-participants" data-match-id="${match.id}" title="参加メンバーを選択">
              👥 参加: ${pStatusCounts['参加']}/${match.matchRecruitCount || '-'}名
            </button>
          </div>
          
          <div class="mheader-actions">
            <button class="btn-icon" data-action="edit-match" data-match-id="${match.id}" title="編集">✏️</button>
            <button class="btn-icon danger" data-action="delete-match" data-match-id="${match.id}" title="削除">🗑️</button>
          </div>
        </div>
        <div class="match-progress">
          <div class="progress-info">
            <span class="progress-label">確定チーム</span>
            <span class="progress-count"><span class="ok-count">${okCount}</span> / ${needed}</span>
          </div>
          <div class="progress-bar">
            <div class="progress-bar-fill ${isComplete ? 'complete' : ''}" style="width: ${progressPct}%"></div>
          </div>
          ${okTeams.length > 0 ? `
          <div style="margin-top: 12px; display: flex; flex-wrap: wrap; gap: 6px;">
            ${okTeams.map(t => `<span style="font-size: 11px; font-weight: 600; padding: 4px 8px; border-radius: 4px; background: rgba(16, 185, 129, 0.15); color: var(--status-ok); border: 1px solid rgba(16, 185, 129, 0.3);">✅${escapeHtml(t.teamName)}</span>`).join('')}
          </div>
          ` : ''}
        </div>
        <div class="candidate-section">
          <div class="candidate-list">
            <div class="candidate-list-header">
              <span class="candidate-list-title">対戦候補 (${match.candidates.length}件)</span>
              <button class="btn-add-candidate" data-action="add-candidate" data-match-id="${match.id}">＋ 候補を追加</button>
            </div>
            ${match.candidates.length > 0
              ? candidateRows
              : '<div class="candidate-empty">まだ候補がありません</div>'
            }
          </div>
        </div>
      </div>
    `;
  }

  function renderCandidateItem(matchId, candidate) {
    const statusClass = `status-${candidate.status}`;
    const noteHtml = candidate.note
      ? `<div class="candidate-note">📝 ${escapeHtml(candidate.note)}</div>`
      : '';
    const affiliationHtml = candidate.affiliation
      ? `<div class="candidate-affiliation">${escapeHtml(candidate.affiliation)}</div>`
      : '';
      
    const catBadge = getCategoryBadge(candidate.category || '一般');

    return `
      <div class="candidate-item" data-candidate-id="${candidate.id}" data-match-id="${matchId}">
        <div class="candidate-info">
          <div class="candidate-name" style="display:flex; align-items:center;">${catBadge}${escapeHtml(candidate.teamName)}</div>
          ${affiliationHtml}
          ${noteHtml}
        </div>
        <div class="candidate-actions">
          <div class="status-dropdown">
            <button class="status-badge ${statusClass}" data-action="toggle-status-menu" data-menu-id="status-menu-${candidate.id}" data-candidate-id="${candidate.id}" data-match-id="${matchId}">${candidate.status}</button>
            <div class="status-dropdown-menu" id="status-menu-${candidate.id}">
              ${STATUSES.map(s => `
                <button class="status-dropdown-item ${s === candidate.status ? 'active' : ''}" data-action="set-status" data-status="${s}" data-candidate-id="${candidate.id}" data-match-id="${matchId}">${s}</button>
              `).join('')}
            </div>
          </div>
          <button class="btn-icon primary" data-action="view-team-schedule" data-team-id="${candidate.teamId}" title="スケジュールを見る">📅</button>
          <button class="btn-icon" data-action="edit-candidate" data-candidate-id="${candidate.id}" data-match-id="${matchId}" title="編集">✏️</button>
          <button class="btn-icon danger" data-action="delete-candidate" data-candidate-id="${candidate.id}" data-match-id="${matchId}" title="削除">🗑️</button>
        </div>
      </div>
    `;
  }

  // ── Event Delegation ──
  function attachCardEvents() {
    dom.matchGrid.onclick = (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;

      const action = btn.dataset.action;
      const matchId = btn.dataset.matchId;
      const candidateId = btn.dataset.candidateId;

      if (action !== 'toggle') {
        e.stopPropagation();
      }

      switch (action) {
        case 'toggle': toggleCard(matchId); break;
        case 'edit-match': openEditMatchModal(matchId); break;
        case 'delete-match': confirmDeleteMatch(matchId); break;
        case 'add-candidate': openAddCandidateModal(matchId); break;
        case 'toggle-status-menu': toggleStatusMenu(btn.dataset.menuId); break;
        case 'set-status': setStatus(matchId, candidateId, btn.dataset.status); break;
        case 'edit-candidate': openEditCandidateModal(matchId, candidateId); break;
        case 'delete-candidate': confirmDeleteCandidate(matchId, candidateId); break;
        case 'view-team-schedule': window.openTeamScheduleModal(btn.dataset.teamId); break;
        case 'manage-participants': openParticipantsModal(matchId); break;
      }
    };
  }

  function toggleCard(matchId) {
    const match = state.matches.find(m => m.id === matchId);
    if (match) {
      match._expanded = !match._expanded;
      render();
    }
  }

  // ── Status Menu ──
  function toggleStatusMenu(menuId) {
    document.querySelectorAll('.status-dropdown-menu.show').forEach(menu => {
      if (menu.id !== menuId) {
        menu.classList.remove('show');
      }
    });
    const menu = document.getElementById(menuId);
    if (menu) menu.classList.toggle('show');
  }

  function setStatus(matchId, candidateId, newStatus) {
    const match = state.matches.find(m => m.id === matchId);
    if (!match) return;
    const candidate = match.candidates.find(c => c.id === candidateId);
    if (!candidate) return;

    candidate.status = newStatus;
    candidate.updatedAt = todayString();
    saveState();
    render();
    if (dom.modalTeamSchedule && dom.modalTeamSchedule.classList.contains('show')) {
      renderTeamSchedule();
    }

    const statusEmoji = { '未連絡': '📨', '連絡中': '💬', '返答待ち': '⏳', '検討': '🤔', 'OK': '✅', '不参加': '❌', 'NG': '❌' };
    showToast(`${candidate.teamName} → ${newStatus}`, statusEmoji[newStatus] || '🔥');
  }

  // ── Match CRUD ──
  function populateMatchLocationSelect(selectedLocationId = '') {
    dom.matchLocation.innerHTML = '<option value="">未定</option>';
    state.locations.forEach(loc => {
      const opt = document.createElement('option');
      opt.value = loc.id;
      opt.textContent = loc.name;
      if (loc.id === selectedLocationId) opt.selected = true;
      dom.matchLocation.appendChild(opt);
    });
  }

  function openCreateMatchModal() {
    dom.matchId.value = '';
    dom.formMatch.reset();
    dom.matchCategory.value = '一般';
    dom.matchDate.value = todayString();
    dom.matchTime.value = '';
    dom.matchTimeManual.value = '';
    dom.matchTimeManual.style.display = 'none';
    populateMatchLocationSelect('');
    dom.matchTeamCount.value = '2';
    dom.matchAutoMatch.checked = false;
    dom.matchCancelled.checked = false;
    dom.groupMatchCancelled.style.display = 'none';

    // Reset match details
    $('match-fee').value = '';
    $('match-fee-other').value = '';
    $('match-fee-other').style.display = 'none';
    $('match-format').value = '';
    $('match-uniform').value = '';
    $('match-uniform-other').value = '';
    $('match-uniform-other').style.display = 'none';
    $('match-spike-forbidden').checked = false;
    $('match-shinpad').checked = false;
    $('match-recruit-count').value = '';
    $('match-info-note').value = '';

    setTypeSelector('TM');
    dom.modalMatchTitle.textContent = '新規マッチ';
    dom.btnSubmitMatch.textContent = '作成';
    openModal(dom.modalMatch);
  }

  function openEditMatchModal(matchId) {
    const match = state.matches.find(m => m.id === matchId);
    if (!match) return;
    dom.matchId.value = match.id;
    dom.matchCategory.value = match.category || '一般';
    dom.matchDate.value = match.date || '';
    
    const predefinedTimes = ['', '09-11', '09-13', '11-13', '13-15', '13-17', '15-17'];
    if (predefinedTimes.includes(match.time || '')) {
      dom.matchTime.value = match.time || '';
      dom.matchTimeManual.value = '';
      dom.matchTimeManual.style.display = 'none';
    } else {
      dom.matchTime.value = 'manual';
      dom.matchTimeManual.value = match.time || '';
      dom.matchTimeManual.style.display = 'block';
    }

    populateMatchLocationSelect(match.locationId);
    dom.matchTeamCount.value = match.teamCount;
    dom.matchAutoMatch.checked = match.isAutoMatch || false;
    dom.matchCancelled.checked = match.isCancelled || false;
    dom.groupMatchCancelled.style.display = 'flex';

    // Load match details
    const fee = match.matchFee || '';
    const predefinedFees = ['', '200円', '300円', '500円', '600円', '1000円'];
    if (predefinedFees.includes(fee)) {
      $('match-fee').value = fee;
      $('match-fee-other').value = '';
      $('match-fee-other').style.display = 'none';
    } else {
      $('match-fee').value = 'other';
      $('match-fee-other').value = fee;
      $('match-fee-other').style.display = 'block';
    }
    
    $('match-format').value    = match.matchFormat    || '';
    
    const uni = match.matchUniform || '';
    if (uni === '' || uni === '黄色' || uni === '赤色') {
      $('match-uniform').value = uni;
      $('match-uniform-other').value = '';
      $('match-uniform-other').style.display = 'none';
    } else {
      $('match-uniform').value = 'other';
      $('match-uniform-other').value = uni;
      $('match-uniform-other').style.display = 'block';
    }

    $('match-spike-forbidden').checked = !!match.matchSpikeForbidden;
    $('match-shinpad').checked         = !!match.matchShinpad;
    $('match-recruit-count').value     = match.matchRecruitCount || '';
    $('match-info-note').value         = match.matchInfoNote  || '';

    setTypeSelector(match.type);
    dom.modalMatchTitle.textContent = 'マッチを編集';
    dom.btnSubmitMatch.textContent = '更新';
    openModal(dom.modalMatch);
  }

  function submitMatch(e) {
    e.preventDefault();
    const id = dom.matchId.value;
    const category = dom.matchCategory.value;
    const date = dom.matchDate.value;
    let time = dom.matchTime.value;
    if (time === 'manual') {
      time = dom.matchTimeManual.value.trim();
    }
    const locationId = dom.matchLocation.value;
    const teamCount = parseInt(dom.matchTeamCount.value) || 2;
    const isAutoMatch = dom.matchAutoMatch.checked;
    const isCancelled = dom.matchCancelled.checked;

    let matchFee = $('match-fee').value;
    if (matchFee === 'other') {
      matchFee = $('match-fee-other').value.trim();
    }
    
    const matchFormat    = $('match-format').value;
    
    let matchUniform = $('match-uniform').value;
    if (matchUniform === 'other') {
      matchUniform = $('match-uniform-other').value.trim();
    }
    
    const matchSpikeForbidden = $('match-spike-forbidden').checked;
    const matchShinpad        = $('match-shinpad').checked;
    const matchRecruitCount   = $('match-recruit-count').value ? parseInt($('match-recruit-count').value) : '';
    const matchInfoNote       = $('match-info-note').value.trim();

    if (id) {
      const match = state.matches.find(m => m.id === id);
      if (match) {
        match.category = category;
        match.date = date;
        match.time = time;
        match.locationId = locationId;
        match.teamCount = teamCount;
        match.isAutoMatch = isAutoMatch;
        match.isCancelled = isCancelled;
        match.type = selectedType;

        match.matchFee = matchFee;
        match.matchFormat = matchFormat;
        match.matchUniform = matchUniform;
        match.matchSpikeForbidden = matchSpikeForbidden;
        match.matchShinpad = matchShinpad;
        match.matchRecruitCount = matchRecruitCount;
        match.matchInfoNote = matchInfoNote;

        showToast(`「${selectedType}」を更新しました`, '💾');
      }
    } else {
      state.matches.push({
        id: generateId(),
        type: selectedType,
        category,
        date,
        time,
        locationId,
        teamCount,
        isAutoMatch,
        isCancelled: false,
        candidates: [],
        createdAt: todayString(),
        _expanded: state.viewMode !== 'list',

        matchFee,
        matchFormat,
        matchUniform,
        matchSpikeForbidden,
        matchShinpad,
        matchRecruitCount,
        matchInfoNote,
      });
      showToast(`「${selectedType}」を追加しました`, '🎉');
    }

    saveState();
    closeModal(dom.modalMatch);
    render();
  }

  function confirmDeleteMatch(matchId) {
    const match = state.matches.find(m => m.id === matchId);
    if (!match) return;
    showConfirm('マッチを削除', `「${match.type}」を削除しますか？\n候補リストも全て削除されます。`, () => {
      state.matches = state.matches.filter(m => m.id !== matchId);
      saveState();
      render();
      showToast(`「${match.type}」を削除しました`, '🗑️');
    });
  }

  // ── Team Management CRUD ──
  function openTeamModal() {
    dom.formTeam.reset();
    dom.teamId.value = '';
    dom.teamCategory.value = '一般';
    $('btn-submit-team').textContent = '追加';
    renderTeamList();
    openModal(dom.modalTeam);
    dom.teamName.focus();
  }

  function renderTeamList() {
    if (state.teams.length === 0) {
      dom.teamListContent.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 13px;">登録されているチームはありません</div>';
      return;
    }

    const rows = state.teams.map(team => {
      const cat = team.category || '一般';
      const catBadge = getCategoryBadge(cat);

      return `
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border-subtle);">
          <div>
            <div style="font-size: 14px; font-weight: 600; color: var(--text-primary); display:flex; align-items:center;">
              ${catBadge}${escapeHtml(team.name)}
            </div>
            ${team.affiliation ? `<div style="font-size: 12px; color: var(--text-muted); margin-top:2px;">${escapeHtml(team.affiliation)}</div>` : ''}
          </div>
          <div style="display: flex; gap: 8px;">
            <button type="button" class="btn-icon primary" onclick="window.openTeamScheduleModal('${team.id}')" title="スケジュールを見る">📅</button>
            <button type="button" class="btn-icon" onclick="window.editTeam('${team.id}')" title="編集">✏️</button>
            <button type="button" class="btn-icon danger" onclick="window.deleteTeam('${team.id}')" title="削除">🗑️</button>
          </div>
        </div>
      `;
    }).join('');
    dom.teamListContent.innerHTML = rows;
  }

  function submitTeam(e) {
    e.preventDefault();
    const id = dom.teamId.value;
    const name = dom.teamName.value.trim();
    const affiliation = dom.teamAffiliation.value.trim();
    const category = dom.teamCategory.value;

    if (!name) return;

    if (id) {
      const team = state.teams.find(t => t.id === id);
      if (team) {
        team.name = name;
        team.affiliation = affiliation;
        team.category = category;
        showToast(`「${name}」を更新しました`, '💾');
      }
    } else {
      state.teams.push({
        id: generateId(),
        name,
        affiliation,
        category,
        createdAt: todayString()
      });
      showToast(`「${name}」を追加しました`, '🎉');
    }

    saveState();
    dom.formTeam.reset();
    dom.teamId.value = '';
    dom.teamCategory.value = '一般';
    $('btn-submit-team').textContent = '追加';
    renderTeamList();
    dom.teamName.focus();
  }

  window.editTeam = function(id) {
    const team = state.teams.find(t => t.id === id);
    if (!team) return;
    dom.teamId.value = team.id;
    dom.teamName.value = team.name;
    dom.teamAffiliation.value = team.affiliation || '';
    dom.teamCategory.value = team.category || '一般';
    $('btn-submit-team').textContent = '更新';
    dom.teamName.focus();
  };

  window.deleteTeam = function(id) {
    const team = state.teams.find(t => t.id === id);
    if (!team) return;
    
    const isUsed = state.matches.some(m => m.candidates.some(c => c.teamId === id));
    const warning = isUsed ? '\n※過去に紐付けたマッチの表示には影響しません。' : '';

    showConfirm('チームを削除', `「${team.name}」をマスターから削除しますか？${warning}`, () => {
      state.teams = state.teams.filter(t => t.id !== id);
      saveState();
      renderTeamList();
      showToast('チームを削除しました', '🗑️');
    });
  };

  // ── Location Management CRUD ──
  function openLocationModal() {
    dom.formLocation.reset();
    dom.locationId.value = '';
    $('btn-submit-location').textContent = '追加';
    renderLocationList();
    openModal(dom.modalLocation);
    dom.locationName.focus();
  }

  function renderLocationList() {
    if (state.locations.length === 0) {
      dom.locationListContent.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 13px;">登録されている会場はありません</div>';
      return;
    }

    const rows = state.locations.map(loc => {
      return `
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border-subtle);">
          <div style="font-size: 14px; font-weight: 500; color: var(--text-primary);">
            📍 ${escapeHtml(loc.name)}
          </div>
          <div style="display: flex; gap: 8px;">
            <button type="button" class="btn-icon" onclick="window.editLocation('${loc.id}')" title="編集">✏️</button>
            <button type="button" class="btn-icon danger" onclick="window.deleteLocation('${loc.id}')" title="削除">🗑️</button>
          </div>
        </div>
      `;
    }).join('');
    dom.locationListContent.innerHTML = rows;
  }

  function submitLocation(e) {
    e.preventDefault();
    const id = dom.locationId.value;
    const name = dom.locationName.value.trim();

    if (!name) return;

    if (id) {
      const loc = state.locations.find(l => l.id === id);
      if (loc) {
        loc.name = name;
        showToast(`「${name}」を更新しました`, '💾');
      }
    } else {
      state.locations.push({
        id: generateId(),
        name,
        createdAt: todayString()
      });
      showToast(`「${name}」を追加しました`, '🎉');
    }

    saveState();
    dom.formLocation.reset();
    dom.locationId.value = '';
    $('btn-submit-location').textContent = '追加';
    renderLocationList();
    render();
    dom.locationName.focus();
  }

  window.editLocation = function(id) {
    const loc = state.locations.find(l => l.id === id);
    if (!loc) return;
    dom.locationId.value = loc.id;
    dom.locationName.value = loc.name;
    $('btn-submit-location').textContent = '更新';
    dom.locationName.focus();
  };

  window.deleteLocation = function(id) {
    const loc = state.locations.find(l => l.id === id);
    if (!loc) return;
    
    showConfirm('会場を削除', `「${loc.name}」をマスターから削除しますか？\n※既存のマッチからも場所が解除されます。`, () => {
      state.locations = state.locations.filter(l => l.id !== id);
      state.matches.forEach(m => {
        if (m.locationId === id) m.locationId = null;
      });
      saveState();
      renderLocationList();
      render();
      showToast('会場を削除しました', '🗑️');
    });
  };

  // ── Candidate CRUD ──
  function populateCandidateTeamSelect(matchCategory, selectedTeamId = '') {
    dom.candidateTeamSelect.innerHTML = '<option value="" disabled selected>チームを選択してください</option>';
    
    let availableTeams = state.teams;
    if (matchCategory === 'シニア') {
      availableTeams = state.teams.filter(t => t.category === 'シニア' || t.category === '両方');
    }

    if (availableTeams.length === 0) {
      if (state.teams.length === 0) {
        dom.candidateTeamSelect.innerHTML += '<option value="" disabled>※先にチーム管理から登録してください</option>';
      } else {
        dom.candidateTeamSelect.innerHTML += '<option value="" disabled>※このマッチに出場できるチームがいません</option>';
      }
      return;
    }

    const groups = { '一般': [], 'シニア': [], '両方': [] };
    availableTeams.forEach(team => {
      const cat = team.category || '一般';
      if (groups[cat]) groups[cat].push(team);
    });

    ['一般', 'シニア', '両方'].forEach(cat => {
      if (groups[cat].length === 0) return;
      
      const optgroup = document.createElement('optgroup');
      optgroup.label = `◆ ${cat}チーム`;
      
      groups[cat].forEach(team => {
        const opt = document.createElement('option');
        opt.value = team.id;
        opt.textContent = `${team.name} ${team.affiliation ? `(${team.affiliation})` : ''}`;
        if (team.id === selectedTeamId) {
          opt.selected = true;
        }
        optgroup.appendChild(opt);
      });
      
      dom.candidateTeamSelect.appendChild(optgroup);
    });
  }

  function openAddCandidateModal(matchId) {
    const match = state.matches.find(m => m.id === matchId);
    if (!match) return;

    dom.candidateMatchId.value = matchId;
    dom.candidateId.value = '';
    dom.formCandidate.reset();
    populateCandidateTeamSelect(match.category || '一般');
    
    dom.groupCandidateParticipation.style.display = 'none';
    if(dom.candidateParticipationRadios.length > 0) dom.candidateParticipationRadios[0].checked = true;
    
    dom.modalCandidateTitle.textContent = '対戦候補を追加';
    dom.btnSubmitCandidate.textContent = '追加';
    openModal(dom.modalCandidate);
  }

  function openEditCandidateModal(matchId, candidateId) {
    const match = state.matches.find(m => m.id === matchId);
    if (!match) return;
    const candidate = match.candidates.find(c => c.id === candidateId);
    if (!candidate) return;

    dom.candidateMatchId.value = matchId;
    dom.candidateId.value = candidateId;
    
    populateCandidateTeamSelect(match.category || '一般', candidate.teamId);
    dom.candidateNote.value = candidate.note || '';
    
    const team = state.teams.find(t => t.id === candidate.teamId);
    if (team && team.category === '両方') {
      dom.groupCandidateParticipation.style.display = 'block';
      const radios = Array.from(dom.candidateParticipationRadios);
      const targetRadio = radios.find(r => r.value === candidate.category);
      if (targetRadio) targetRadio.checked = true;
      else if(radios.length > 0) radios[0].checked = true;
    } else {
      dom.groupCandidateParticipation.style.display = 'none';
    }
    
    dom.modalCandidateTitle.textContent = '候補を編集';
    dom.btnSubmitCandidate.textContent = '更新';
    openModal(dom.modalCandidate);
  }

  function submitCandidate(e) {
    e.preventDefault();
    const matchId = dom.candidateMatchId.value;
    const candidateId = dom.candidateId.value;
    const teamId = dom.candidateTeamSelect.value;
    const note = dom.candidateNote.value.trim();

    if (!teamId) {
      alert('チームを選択してください。リストにない場合は「チーム管理」から追加してください。');
      return;
    }

    const match = state.matches.find(m => m.id === matchId);
    if (!match) return;

    const team = state.teams.find(t => t.id === teamId);
    if (!team) return;

    let finalCategory = team.category;
    if (team.category === '両方') {
      const selectedRadio = Array.from(dom.candidateParticipationRadios).find(r => r.checked);
      if (selectedRadio) finalCategory = selectedRadio.value;
    }

    if (candidateId) {
      const candidate = match.candidates.find(c => c.id === candidateId);
      if (candidate) {
        candidate.teamId = team.id;
        candidate.teamName = team.name;
        candidate.affiliation = team.affiliation;
        candidate.category = finalCategory;
        candidate.note = note;
        candidate.updatedAt = todayString();
        showToast(`「${team.name}」を更新しました`, '💾');
      }
    } else {
      match.candidates.push({
        id: generateId(),
        teamId: team.id,
        teamName: team.name,
        affiliation: team.affiliation,
        category: finalCategory,
        status: '未連絡',
        note,
        updatedAt: todayString(),
      });
      showToast(`「${team.name}」を追加しました`, '🎉');
    }

    saveState();
    closeModal(dom.modalCandidate);
    render();
  }

  function confirmDeleteCandidate(matchId, candidateId) {
    const match = state.matches.find(m => m.id === matchId);
    if (!match) return;
    const candidate = match.candidates.find(c => c.id === candidateId);
    if (!candidate) return;

    showConfirm('候補を削除', `「${candidate.teamName}」を削除しますか？`, () => {
      match.candidates = match.candidates.filter(c => c.id !== candidateId);
      saveState();
      render();
      showToast('候補を削除しました', '🗑️');
    });
  }

  // ── Main init ──
  function init() {
    loadState();
    importSchedule();
    migrateLocationsV1();
    migrateTypesV1();
    initTypeSelector();
    initPastMatchesToggle();
    initAuthAndAccess();

    dom.matchTime.addEventListener('change', (e) => {
      if (e.target.value === 'manual') {
        dom.matchTimeManual.style.display = 'block';
        dom.matchTimeManual.focus();
      } else {
        dom.matchTimeManual.style.display = 'none';
      }
    });

    $('match-uniform').addEventListener('change', (e) => {
      if (e.target.value === 'other') {
        $('match-uniform-other').style.display = 'block';
        $('match-uniform-other').focus();
      } else {
        $('match-uniform-other').style.display = 'none';
      }
    });

    $('match-fee').addEventListener('change', (e) => {
      if (e.target.value === 'other') {
        $('match-fee-other').style.display = 'block';
        $('match-fee-other').focus();
      } else {
        $('match-fee-other').style.display = 'none';
      }
    });

    $('match-format').addEventListener('change', (e) => {
      const val = e.target.value;
      let recruitVal = '';
      if (val === '8人制') recruitVal = 10;
      else if (val === '9人制') recruitVal = 11;
      else if (val === '11人制') recruitVal = 13;

      if (recruitVal) {
        $('match-recruit-count').value = recruitVal;
      }
    });

    // Modals open
    $('btn-open-match-modal')?.addEventListener('click', openCreateMatchModal);
    $('btn-open-match-modal-empty')?.addEventListener('click', openCreateMatchModal);
    $('btn-open-team-modal')?.addEventListener('click', openTeamModal);
    $('btn-open-location-modal')?.addEventListener('click', openLocationModal);
    $('btn-open-analytics-modal')?.addEventListener('click', openAnalyticsModal);

    // Mobile Bottom Nav
    $('btn-bottom-add-match')?.addEventListener('click', openCreateMatchModal);
    $('btn-bottom-member')?.addEventListener('click', openMemberModal);
    $('btn-bottom-team')?.addEventListener('click', openTeamModal);
    $('btn-bottom-location')?.addEventListener('click', openLocationModal);
    $('btn-bottom-analytics')?.addEventListener('click', openAnalyticsModal);

    // Filter events
    dom.analyticsPeriod.addEventListener('change', renderAnalytics);

    dom.candidateTeamSelect.addEventListener('change', () => {
      const teamId = dom.candidateTeamSelect.value;
      const team = state.teams.find(t => t.id === teamId);
      if (team && team.category === '両方') {
        dom.groupCandidateParticipation.style.display = 'block';
      } else {
        dom.groupCandidateParticipation.style.display = 'none';
      }
    });

    dom.btnCopyTeamSchedule?.addEventListener('click', copyTeamSchedule);
    dom.btnCopyMemberSchedule?.addEventListener('click', copyMemberSchedule);
    
    dom.btnOpenMemberModal?.addEventListener('click', openMemberModal);
    $('btn-cancel-participants')?.addEventListener('click', () => closeModal(dom.modalParticipants));
    $('btn-submit-participants')?.addEventListener('click', submitParticipants);
    dom.formMember?.addEventListener('submit', submitMember);

    dom.memberFilterText.addEventListener('input', renderMemberList);
    dom.memberFilterCategory.addEventListener('change', renderMemberList);
    dom.memberFilterPriority.addEventListener('change', renderMemberList);

    dom.participantsFilterText.addEventListener('input', updateParticipantsFilter);
    dom.participantsFilterCategory.addEventListener('change', updateParticipantsFilter);
    dom.participantsFilterPriority.addEventListener('change', updateParticipantsFilter);
    
    dom.teamScheduleContent?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      
      switch(action) {
        case 'toggle-status-menu': toggleStatusMenu(btn.dataset.menuId); break;
        case 'set-status': setStatus(btn.dataset.matchId, btn.dataset.candidateId, btn.dataset.status); break;
      }
    });

    // Document click to close modals
    document.addEventListener('click', (e) => {
      if (e.target.classList.contains('modal')) closeModal(e.target);
      if (!e.target.closest('.status-dropdown')) {
        document.querySelectorAll('.status-dropdown-menu.show').forEach(menu => {
          menu.classList.remove('show');
        });
      }
    });

    // Modals close
    const bindClose = (closeBtnId, overlayDom) => {
      $(closeBtnId)?.addEventListener('click', () => closeModal(overlayDom));
      overlayDom.addEventListener('click', (e) => {
        if (e.target === overlayDom) closeModal(overlayDom);
      });
    };
    bindClose('modal-match-close', dom.modalMatch);
    bindClose('modal-candidate-close', dom.modalCandidate);
    bindClose('modal-team-close', dom.modalTeam);
    bindClose('modal-location-close', dom.modalLocation);
    bindClose('modal-analytics-close', dom.modalAnalytics);
    bindClose('modal-team-schedule-close', dom.modalTeamSchedule);
    bindClose('modal-member-schedule-close', dom.modalMemberSchedule);
    bindClose('modal-member-close', dom.modalMember);
    bindClose('modal-participants-close', dom.modalParticipants);
    $('btn-cancel-match').addEventListener('click', () => closeModal(dom.modalMatch));
    $('btn-cancel-candidate').addEventListener('click', () => closeModal(dom.modalCandidate));

    // Form submits
    dom.formMatch.addEventListener('submit', submitMatch);
    dom.formCandidate.addEventListener('submit', submitCandidate);
    dom.formTeam.addEventListener('submit', submitTeam);
    dom.formLocation.addEventListener('submit', submitLocation);

    // Confirm dialog
    dom.confirmOk.addEventListener('click', () => {
      dom.confirmDialog.classList.remove('show');
      if (confirmCallback) {
        confirmCallback();
        confirmCallback = null;
      }
    });
    dom.confirmCancel.addEventListener('click', () => {
      dom.confirmDialog.classList.remove('show');
      confirmCallback = null;
    });
    dom.confirmDialog.addEventListener('click', (e) => {
      if (e.target === dom.confirmDialog) {
        dom.confirmDialog.classList.remove('show');
        confirmCallback = null;
      }
    });

    // Keyboard ESC
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (dom.confirmDialog.classList.contains('show')) {
          dom.confirmDialog.classList.remove('show');
          confirmCallback = null;
        } else if (dom.modalTeam.classList.contains('show')) {
          closeModal(dom.modalTeam);
        } else if (dom.modalLocation.classList.contains('show')) {
          closeModal(dom.modalLocation);
        } else if (dom.modalCandidate.classList.contains('show')) {
          closeModal(dom.modalCandidate);
        } else if (dom.modalMatch.classList.contains('show')) {
          closeModal(dom.modalMatch);
        } else if (dom.modalAnalytics.classList.contains('show')) {
          closeModal(dom.modalAnalytics);
        } else if (dom.modalTeamSchedule.classList.contains('show')) {
          closeModal(dom.modalTeamSchedule);
        } else if (dom.modalMember && dom.modalMember.classList.contains('show')) {
          closeModal(dom.modalMember);
        } else if (dom.modalParticipants && dom.modalParticipants.classList.contains('show')) {
          closeModal(dom.modalParticipants);
        }
        document.querySelectorAll('.status-dropdown-menu.show').forEach(menu => {
          menu.classList.remove('show');
        });
      }
    });

    render();
  }

  // ── Team Schedule (Share View) ──
  let currentScheduleTeamId = null;

  window.openTeamScheduleModal = function(teamId) {
    const team = state.teams.find(t => t.id === teamId);
    if (!team) return;
    currentScheduleTeamId = teamId;

    dom.modalTeamScheduleTitle.textContent = `${team.name} のスケジュール`;
    renderTeamSchedule();
    openModal(dom.modalTeamSchedule);
  };

  function renderTeamSchedule() {
    if (!currentScheduleTeamId) return;
    
    const matchesForTeam = state.matches.filter(m => 
      m.candidates.some(c => c.teamId === currentScheduleTeamId)
    ).sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date.localeCompare(b.date);
    });

    if (matchesForTeam.length === 0) {
      dom.teamScheduleContent.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding: 20px;">スケジュールはありません</div>';
      return;
    }

    let html = '';
    matchesForTeam.forEach(m => {
      const candidate = m.candidates.find(c => c.teamId === currentScheduleTeamId);
      const loc = state.locations.find(l => l.id === m.locationId);
      const locName = loc ? loc.name : '未定';
      const statusClass = `status-${candidate.status}`;
      
      html += `
        <div style="background: var(--bg-primary); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 12px; display: flex; justify-content: space-between; align-items: center; gap: 12px;">
          <div style="flex: 1;">
            <div style="font-weight: 600; font-size: 14px; margin-bottom: 4px; display: flex; align-items: center; gap: 8px;">
              📅 ${m.date ? formatDate(m.date) : '日程未定'} ${m.time ? `<span style="color:var(--text-muted); font-size:13px;">${escapeHtml(m.time)}</span>` : ''}
              ${m.isCancelled ? '<span class="badge" style="background: var(--danger-color); color: white; border: none; padding: 2px 6px;">中止</span>' : ''}
            </div>
            <div style="font-size: 13px; color: var(--text-secondary); display: flex; align-items: center; gap: 8px;">
              <span>📍 ${escapeHtml(locName)}</span>
              <span style="color: var(--border-light);">|</span>
              <span class="badge" style="background: var(--bg-tertiary); color: var(--text-muted);">${escapeHtml(m.type)}</span>
            </div>
          </div>
          <div style="flex-shrink: 0;">
            <div class="status-dropdown">
              <button class="status-badge ${statusClass}" data-action="toggle-status-menu" data-menu-id="status-menu-${candidate.id}-schedule" style="width: 100px; justify-content: space-between;">${candidate.status}</button>
              <div class="status-dropdown-menu" id="status-menu-${candidate.id}-schedule">
                ${STATUSES.map(s => `
                  <button class="status-dropdown-item ${s === candidate.status ? 'active' : ''}" data-action="set-status" data-status="${s}" data-candidate-id="${candidate.id}" data-match-id="${m.id}">${s}</button>
                `).join('')}
              </div>
            </div>
          </div>
        </div>
      `;
    });

    dom.teamScheduleContent.innerHTML = html;
  }

  function copyTeamSchedule() {
    if (!currentScheduleTeamId) return;
    const team = state.teams.find(t => t.id === currentScheduleTeamId);
    if (!team) return;

    const matchesForTeam = state.matches.filter(m => 
      m.candidates.some(c => c.teamId === currentScheduleTeamId)
    ).sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date.localeCompare(b.date);
    });

    let text = `【${team.name} のスケジュールのご案内】\n\n`;
    
    if (matchesForTeam.length === 0) {
      text += "現在予定されているスケジュールはありません\n";
    } else {
      matchesForTeam.forEach(m => {
        const candidate = m.candidates.find(c => c.teamId === currentScheduleTeamId);
        const loc = state.locations.find(l => l.id === m.locationId);
        const locName = loc ? loc.name : '未定';
        
        let dateStr = m.date ? formatDate(m.date) : '日程未定';
        if (m.time) dateStr += ` ${m.time}`;
        
        text += `◆ ${dateStr} @ ${locName}\n`;
        text += `種別: ${m.type}\n`;
        text += `ステータス: ${candidate.status}\n`;
        if (m.isCancelled) text += `※ このマッチは中止になりました\n`;
        text += `\n`;
      });
    }

    navigator.clipboard.writeText(text).then(() => {
      showToast('スケジュールをコピーしました', '📋');
    }).catch(err => {
      showToast('コピーに失敗しました', '⚠️');
    });
  }

  // ── Member Schedule (Share View) ──
  let currentScheduleMemberId = null;

  window.openMemberScheduleModal = function(memberId) {
    const member = state.members.find(m => m.id === memberId);
    if (!member) return;
    currentScheduleMemberId = memberId;

    dom.modalMemberScheduleTitle.textContent = `${member.name} さんのスケジュール`;
    renderMemberSchedule();
    openModal(dom.modalMemberSchedule);
  };

  function renderMemberSchedule() {
    if (!currentScheduleMemberId) return;
    
    const matchesForMember = state.matches.filter(m => 
      m.participants && m.participants[currentScheduleMemberId] && m.participants[currentScheduleMemberId] !== '未定'
    ).sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date.localeCompare(b.date);
    });

    let html = '';
    if (matchesForMember.length === 0) {
      html = '<div style="color:var(--text-muted); text-align:center; padding: 20px;">現在声掛けされている試合はありません。</div>';
    } else {
      html = matchesForMember.map(m => {
        const locName = m.locationId ? (state.locations.find(l => l.id === m.locationId)?.name || '不明') : (m.locationName || '未定');
        const status = m.participants[currentScheduleMemberId];
        let statusBadge = '';
        if (status === '参加') statusBadge = '<span class="badge" style="background: rgba(16, 185, 129, 0.15); color: var(--status-ok);">✅ 参加</span>';
        else if (status === '不参加') statusBadge = '<span class="badge" style="background: rgba(239, 68, 68, 0.15); color: var(--status-ng);">❌ 不参加</span>';
        else statusBadge = `<span class="badge" style="background: rgba(245, 158, 11, 0.15); color: var(--status-contacting);">${escapeHtml(status)}</span>`;

        const personalNote = m.participantNotes ? m.participantNotes[currentScheduleMemberId] : '';
        let detailsHtml = '';
        if (m.matchFee || m.matchFormat || m.matchUniform || m.matchInfoNote || personalNote || m.matchSpikeForbidden !== undefined || m.matchShinpad !== undefined) {
          detailsHtml = `
            <div style="margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--border-subtle); font-size: 12px; color: var(--text-secondary); display: flex; flex-direction: column; gap: 4px;">
              ${m.matchFee ? `<div>💵 参加費用: ${escapeHtml(m.matchFee)}</div>` : ''}
              ${m.matchFormat ? `<div>📋 形式: ${escapeHtml(m.matchFormat)}</div>` : ''}
              ${m.matchUniform ? `<div>👕 持参ユニフォーム: ${escapeHtml(m.matchUniform)}</div>` : ''}
              <div>👟 スパイク: ${m.matchSpikeForbidden ? '不可' : '可'} / 🛡️ すねあて: ${m.matchShinpad ? '必須' : '不要'}</div>
              ${m.matchInfoNote ? `<div style="color: var(--text-muted);">📝 備考: ${escapeHtml(m.matchInfoNote)}</div>` : ''}
              ${personalNote ? `<div style="color: var(--status-contacting); font-weight: 500;">📌 個人備考: ${escapeHtml(personalNote)}</div>` : ''}
            </div>
          `;
        }

        return `
          <div style="background: var(--bg-primary); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 12px;">
            <div style="font-weight: 600; font-size: 14px; margin-bottom: 8px;">
              ${m.date ? formatDate(m.date) : '日程未定'} ${m.time ? `<span style="color:var(--text-muted); font-size:13px;">${escapeHtml(m.time)}</span>` : ''}
              ${m.isCancelled ? '<span class="badge" style="background: var(--danger-color); color: white; border: none; padding: 2px 6px;">中止</span>' : ''}
            </div>
            <div style="font-size: 13px; color: var(--text-secondary); margin-bottom: 8px;">
              📍 ${escapeHtml(locName)} <span style="color: var(--border-light);">|</span> ${escapeHtml(m.type)}
            </div>
            <div style="display: flex; align-items: center; gap: 8px; font-size: 13px;">
              <span style="color: var(--text-muted);">ステータス:</span>
              ${statusBadge}
            </div>
            ${detailsHtml}
          </div>
        `;
      }).join('');
    }
    
    dom.memberScheduleContent.innerHTML = html;
  }

  function copyMemberSchedule() {
    if (!currentScheduleMemberId) return;
    const member = state.members.find(m => m.id === currentScheduleMemberId);
    if (!member) return;

    const matchesForMember = state.matches.filter(m => 
      m.participants && m.participants[currentScheduleMemberId] && m.participants[currentScheduleMemberId] !== '未定'
    ).sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date.localeCompare(b.date);
    });

    let text = `【${member.name} さんの試合予定】\n\n`;
    
    if (matchesForMember.length === 0) {
      text += "現在声掛けされている試合はありません。\n";
    } else {
      matchesForMember.forEach(m => {
        const dateStr = m.date ? formatDate(m.date) : '日程未定';
        const timeStr = m.time ? ` ${m.time}` : '';
        const locName = m.locationId ? (state.locations.find(l => l.id === m.locationId)?.name || '不明') : (m.locationName || '未定');
        
        text += `◆ ${dateStr}${timeStr} 📍${locName} (${m.type})\n`;
        if (m.category) {
          const catName = m.category === '年齢制限なし' ? '制限なし' : m.category;
          text += `・カテゴリー: ${catName}\n`;
        }
        if (m.matchFormat) text += `・形式: ${m.matchFormat}\n`;
        if (m.matchFee) text += `・参加費用: ${m.matchFee}\n`;
        if (m.matchSpikeForbidden) text += `・スパイク: 不可\n`;
        if (m.matchShinpad) text += `・すねあて: 必須\n`;
        if (m.matchUniform) text += `・持参ユニフォーム: ${m.matchUniform}\n`;
        if (m.matchInfoNote) text += `・備考: ${m.matchInfoNote}\n`;
        
        const okTeams = m.candidates ? m.candidates.filter(c => c.status === 'OK') : [];
        if (okTeams.length > 0) {
          text += `・対戦チーム: ${okTeams.map(t => t.teamName).join(', ')}\n`;
        }
        
        const personalNote = m.participantNotes ? m.participantNotes[currentScheduleMemberId] : '';
        if (personalNote) {
          text += `・個人備考: ${personalNote}\n`;
        }
        
        if (m.isCancelled) text += `※ この試合は中止になりました\n`;
        text += `\n`;
      });
    }

    navigator.clipboard.writeText(text).then(() => {
      showToast('スケジュールをコピーしました', '📋');
    }).catch(err => {
      console.error('Failed to copy: ', err);
      showToast('コピーに失敗しました', '⚠️');
    });
  }

  // ── Member Management CRUD ──
  function openMemberModal() {
    dom.formMember.reset();
    dom.memberId.value = '';
    dom.memberCategory.value = 'シニア';
    
    // Populate team options
    const teamOptions = '<option value="">（なし）</option>' + state.teams.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
    dom.memberAffiliation.innerHTML = teamOptions;

    $('btn-submit-member').textContent = '追加';
    renderMemberList();
    openModal(dom.modalMember);
    dom.memberName.focus();
  }

  function renderMemberList() {
    if (!state.members || state.members.length === 0) {
      dom.memberListContent.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 13px;">登録されているメンバーはいません</div>';
      return;
    }

    const filterText = dom.memberFilterText.value.trim().toLowerCase();
    const filterCat = dom.memberFilterCategory.value;
    const filterPrio = dom.memberFilterPriority.checked;

    let filtered = state.members.filter(m => {
      if (filterCat && m.category !== filterCat) return false;
      if (filterPrio && !m.priority) return false;
      if (filterText) {
        const t = filterText;
        if (!m.name.toLowerCase().includes(t) && !(m.affiliation || '').toLowerCase().includes(t)) {
          return false;
        }
      }
      return true;
    });
    
    const memberParticipations = {};
    state.matches.forEach(m => {
      if (m.isCancelled) return;
      if (m.participants) {
        Object.keys(m.participants).forEach(id => {
          if (m.participants[id] === '参加') {
            memberParticipations[id] = (memberParticipations[id] || 0) + 1;
          }
        });
      }
    });

    const sortedMembers = filtered.sort((a, b) => {
      if (b.priority !== a.priority) return (b.priority ? 1 : 0) - (a.priority ? 1 : 0);
      
      const countA = memberParticipations[a.id] || 0;
      const countB = memberParticipations[b.id] || 0;
      if (countA !== countB) return countB - countA;
      
      const numA = parseInt(a.uniformYellow) || 999;
      const numB = parseInt(b.uniformYellow) || 999;
      return numA - numB;
    });

    const rows = sortedMembers.map(member => {
      const badgeClass = member.category === '若手' ? 'badge-category-general' : 'badge-category-senior';
      const participationCount = memberParticipations[member.id] || 0;
      
      let affiliationDisplay = '';
      if (member.affiliationTeamId) {
        const team = state.teams.find(t => t.id === member.affiliationTeamId);
        if (team) affiliationDisplay = team.name;
      } else if (member.affiliation) {
        affiliationDisplay = member.affiliation;
      }

      return `
        <div style="padding: 12px; border-bottom: 1px solid var(--border-subtle); display: flex; justify-content: space-between; align-items: center; ${member.priority ? 'background: rgba(250, 204, 21, 0.05);' : ''}">
          <div style="display: flex; flex-direction: column; gap: 4px; flex: 1;">
            <div style="display: flex; align-items: center; gap: 8px;">
              ${member.priority ? `<span style="color: var(--status-contacting); font-size: 14px;" title="優先">⭐</span>` : ''}
              <span class="badge ${badgeClass}">${member.category || 'シニア'}</span>
              <span style="font-weight: 600; font-size: 15px;">${escapeHtml(member.name)}</span>
              ${affiliationDisplay ? `<span style="font-size: 11px; color: var(--text-muted); background: var(--bg-tertiary); padding: 2px 6px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle);">${escapeHtml(affiliationDisplay)}</span>` : ''}
            </div>
            <div style="font-size: 12px; color: var(--text-secondary); display: flex; gap: 12px;">
              <span>🟡 ${member.uniformYellow || '-'}</span>
              <span>🔴 ${member.uniformRed || '-'}</span>
              <span style="color: var(--primary-color); font-weight: 600;">参加: ${participationCount}回</span>
              ${member.note ? `<span>📝 ${escapeHtml(member.note)}</span>` : ''}
            </div>
          </div>
          <div style="display: flex; gap: 8px; flex-shrink: 0;">
            <button type="button" class="btn-icon primary" onclick="window.openMemberScheduleModal('${member.id}')" title="スケジュールを見る">📅</button>
            <button type="button" class="btn-icon" onclick="window.editMember('${member.id}')" title="編集">✏️</button>
            <button type="button" class="btn-icon danger" onclick="window.deleteMember('${member.id}')" title="削除">🗑️</button>
          </div>
        </div>
      `;
    }).join('');
    
    if (filtered.length === 0) {
      dom.memberListContent.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 13px;">条件に一致するメンバーはいません</div>';
    } else {
      dom.memberListContent.innerHTML = rows;
    }
  }

  function submitMember(e) {
    e.preventDefault();
    const id = dom.memberId.value;
    const category = dom.memberCategory.value;
    const name = dom.memberName.value.trim();
    const uniformYellow = dom.memberUniformYellow.value.trim();
    const uniformRed = dom.memberUniformRed.value.trim();
    const affiliationTeamId = dom.memberAffiliation.value;
    const note = dom.memberNote.value.trim();
    const priority = dom.memberPriority.checked;

    if (!name) return;

    if (!state.members) state.members = [];

    if (id) {
      const member = state.members.find(m => m.id === id);
      if (member) {
        member.category = category;
        member.name = name;
        member.uniformYellow = uniformYellow;
        member.uniformRed = uniformRed;
        member.affiliationTeamId = affiliationTeamId;
        member.note = note;
        member.priority = priority;
        showToast(`「${name}」を更新しました`, '💾');
      }
    } else {
      state.members.push({ id: generateId(), category, name, uniformYellow, uniformRed, affiliationTeamId, note, priority });
      showToast(`「${name}」を追加しました`, '🎉');
    }

    saveState();
    dom.formMember.reset();
    dom.memberId.value = '';
    $('btn-submit-member').textContent = '追加';
    renderMemberList();
    dom.memberName.focus();
  }

  window.editMember = function(id) {
    const member = state.members.find(m => m.id === id);
    if (!member) return;
    
    // Populate team options
    const teamOptions = '<option value="">（なし）</option>' + state.teams.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
    dom.memberAffiliation.innerHTML = teamOptions;

    dom.memberId.value = member.id;
    dom.memberCategory.value = member.category || 'シニア';
    dom.memberName.value = member.name;
    dom.memberUniformYellow.value = member.uniformYellow || '';
    dom.memberUniformRed.value = member.uniformRed || '';
    dom.memberAffiliation.value = member.affiliationTeamId || '';
    dom.memberNote.value = member.note || '';
    dom.memberPriority.checked = !!member.priority;
    $('btn-submit-member').textContent = '更新';
    dom.memberName.focus();
  };

  window.deleteMember = function(id) {
    const member = state.members.find(m => m.id === id);
    if (!member) return;

    showConfirm('メンバーを削除', `「${member.name}」を削除しますか？`, () => {
      state.members = state.members.filter(m => m.id !== id);
      state.matches.forEach(m => {
        if (m.participants && m.participants[id]) {
          delete m.participants[id];
        }
      });
      saveState();
      renderMemberList();
      render();
      showToast(`「${member.name}」を削除しました`, '🗑️');
    });
  };

  // ── Match Participants Management ──
  const PARTICIPANT_STATUSES = ['未定', '参加', '声掛検討', '返答待ち', '不参加'];

  function openParticipantsModal(matchId) {
    const match = state.matches.find(m => m.id === matchId);
    if (!match) return;

    dom.participantsMatchId.value = matchId;
    
    // Set match info
    const dateStr = match.date ? formatDate(match.date, true) : '日程未定';
    const timeStr = match.time ? ` <span class="mtime-badge">${escapeHtml(match.time)}</span>` : '';
    const cat = match.category || '一般';
    let catDisplayName = '🏃‍♂️ 一般';
    if (cat === 'シニア') catDisplayName = '👴 シニア';
    else if (cat === '制限なし' || cat === '年齢制限なし') catDisplayName = '♾️ 制限なし';
    
    let typeLabel = '';
    if (match.type === 'TM') typeLabel = '🤝 TM';
    else if (match.type === '中野区リーグ') typeLabel = '🏅 区リーグ';
    else if (match.type === 'ミニサッカー大会') typeLabel = '🏆 ミニサッカー';
    else typeLabel = `⚽ ${escapeHtml(match.type)}`;

    const loc = state.locations.find(l => l.id === match.locationId);
    const locName = loc ? escapeHtml(loc.name) : '未定';

    const infoDiv = document.getElementById('participants-match-info');
    if (infoDiv) {
      infoDiv.innerHTML = `<span style="font-weight:600;">${dateStr}</span>${timeStr} ｜ ${catDisplayName} ｜ ${typeLabel} ｜ 📍 ${locName}`;
    }

    if (!state.members || state.members.length === 0) {
      dom.participantsListContent.innerHTML = '<div style="text-align:center; color:var(--text-muted); padding:10px;">先にメンバーを登録してください</div>';
    } else {
      const memberParticipations = {};
      state.matches.forEach(m => {
        if (m.isCancelled) return;
        if (m.participants) {
          Object.keys(m.participants).forEach(id => {
            if (m.participants[id] === '参加') {
              memberParticipations[id] = (memberParticipations[id] || 0) + 1;
            }
          });
        }
      });

      // Sort priority: 参加 > 返答待ち > 声掛検討 > 不参加 > 未定, then priority flag, then participation count
      const statusOrder = { '参加': 0, '返答待ち': 1, '声掛検討': 2, '不参加': 3, '未定': 4 };
      
      const currentParticipants = {};
      if (match.participants) {
        Object.keys(match.participants).forEach(id => {
          let s = match.participants[id];
          if (s === '検討中') s = '声掛検討';
          currentParticipants[id] = s;
        });
      }
      const currentNotes = match.participantNotes || {};

      const sortedMembers = [...state.members].sort((a, b) => {
        const sA = statusOrder[currentParticipants[a.id] || '未定'] ?? 4;
        const sB = statusOrder[currentParticipants[b.id] || '未定'] ?? 4;
        if (sA !== sB) return sA - sB;
        if (b.priority !== a.priority) return (b.priority ? 1 : 0) - (a.priority ? 1 : 0);
        const countA = memberParticipations[a.id] || 0;
        const countB = memberParticipations[b.id] || 0;
        if (countA !== countB) return countB - countA;
        const numA = parseInt(a.uniformYellow) || 999;
        const numB = parseInt(b.uniformYellow) || 999;
        return numA - numB;
      });

      // Status style map
      const statusStyle = {
        '参加':    { bg: 'rgba(16,185,129,0.10)', border: 'rgba(16,185,129,0.3)', icon: '✅' },
        '返答待ち': { bg: 'rgba(245,158,11,0.10)', border: 'rgba(245,158,11,0.3)',  icon: '⏳' },
        '声掛検討': { bg: 'rgba(245,158,11,0.07)', border: 'rgba(245,158,11,0.2)',  icon: '🤔' },
        '不参加':  { bg: 'rgba(239,68,68,0.08)',  border: 'rgba(239,68,68,0.25)',  icon: '❌' },
        '未定':    { bg: 'transparent',            border: 'transparent',           icon: '　' },
      };

      // Summary bar
      const counts = { '参加': 0, '返答待ち': 0, '声掛検討': 0, '不参加': 0, '未定': 0 };
      state.members.forEach(m => {
        const s = currentParticipants[m.id] || '未定';
        if (counts[s] !== undefined) counts[s]++;
      });

      const summaryHtml = `
        <div style="display:flex; gap:4px; flex-wrap:nowrap; overflow-x:auto; white-space:nowrap; margin-bottom:10px; padding:8px; background:var(--bg-secondary); border-radius:var(--radius-md); justify-content:space-between;">
          <span style="padding:4px 8px; border-radius:20px; font-size:11px; font-weight:700; background:rgba(16,185,129,0.15); color:var(--status-ok); border:1px solid rgba(16,185,129,0.3);">✅ 参加 ${counts['参加']}</span>
          <span style="padding:4px 8px; border-radius:20px; font-size:11px; font-weight:700; background:rgba(245,158,11,0.12); color:var(--status-contacting); border:1px solid rgba(245,158,11,0.3);">⏳ 返答 ${counts['返答待ち']}</span>
          <span style="padding:4px 8px; border-radius:20px; font-size:11px; font-weight:700; background:rgba(245,158,11,0.08); color:var(--status-contacting); border:1px solid rgba(245,158,11,0.2);">🤔 検討 ${counts['声掛検討']}</span>
          <span style="padding:4px 8px; border-radius:20px; font-size:11px; font-weight:700; background:rgba(239,68,68,0.10); color:var(--status-ng); border:1px solid rgba(239,68,68,0.25);">❌ 不参 ${counts['不参加']}</span>
          <span style="padding:4px 8px; border-radius:20px; font-size:11px; font-weight:600; background:var(--bg-tertiary); color:var(--text-muted); border:1px solid var(--border-subtle);">　未定 ${counts['未定']}</span>
        </div>
      `;

      const html = sortedMembers.map(member => {
        const status = currentParticipants[member.id] || '未定';
        const style = statusStyle[status] || statusStyle['未定'];
        const note = currentNotes[member.id] || '';
        
        let affiliationDisplay = '';
        if (member.affiliationTeamId) {
          const team = state.teams.find(t => t.id === member.affiliationTeamId);
          if (team) affiliationDisplay = team.name;
        } else if (member.affiliation) {
          affiliationDisplay = member.affiliation;
        }
        
        return `
          <div class="participant-row" data-name="${escapeHtml(member.name)}" data-affiliation="${escapeHtml(affiliationDisplay)}" data-category="${escapeHtml(member.category || 'シニア')}" data-priority="${!!member.priority}"
            style="display:flex; align-items:center; justify-content:space-between; padding:8px 10px; border-bottom:1px solid var(--border-subtle); background:${style.bg}; border-left:3px solid ${style.border};">
            <div style="display:flex; align-items:center; gap:8px; flex:1; min-width:0;">
              <span class="prow-icon" style="font-size:15px; width:20px; text-align:center; flex-shrink:0;">${style.icon}</span>
              ${member.priority ? `<span style="color:var(--status-contacting); font-size:13px; flex-shrink:0;" title="優先">⭐</span>` : ''}
              <span class="badge ${member.category==='若手' ? 'badge-category-general' : 'badge-category-senior'}" style="padding:2px 4px; font-size:10px; flex-shrink:0;">${member.category || 'シニア'}</span>
              <div style="display:flex; flex-direction:column; min-width:0;">
                <div style="display:flex; align-items:center; gap:6px; min-width:0;">
                  <span class="prow-name" style="font-weight:${status === '参加' ? '700' : '500'}; color:${status === '参加' ? 'var(--status-ok)' : 'var(--text-primary)'}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(member.name)}</span>
                  <button type="button" class="btn-icon" onclick="window.openMemberScheduleModal('${member.id}')" title="予定を確認" style="width:20px; height:20px; font-size:11px; padding:0; display:inline-flex; align-items:center; justify-content:center; border:1px solid var(--border-subtle); border-radius:4px; background:var(--bg-tertiary); color:var(--text-primary); cursor:pointer; flex-shrink:0;">📅</button>
                </div>
                ${affiliationDisplay ? `<span style="font-size:10px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(affiliationDisplay)}</span>` : ''}
              </div>
            </div>
            <div style="display:flex; flex-direction:column; align-items:stretch; gap:4px; flex-shrink:0; margin-left:10px; width:130px;">
              <select class="form-select participant-status-select" data-member-id="${member.id}"
                style="width:100%; padding:5px 6px; font-size:13px; border-color:${style.border};"
                onchange="(function(sel){
                  var row=sel.closest('.participant-row');
                  row.style.background=window._pStatusBg(sel.value);
                  row.style.borderLeftColor=window._pStatusBorder(sel.value);
                  sel.style.borderColor=window._pStatusBorder(sel.value);
                  row.querySelector('.prow-icon').textContent=window._pStatusIcon(sel.value);
                  var n=row.querySelector('.prow-name');
                  n.style.fontWeight=sel.value==='参加'?'700':'500';
                  n.style.color=sel.value==='参加'?'var(--status-ok)':'var(--text-primary)';
                })(this)">
                ${PARTICIPANT_STATUSES.map(s => `<option value="${s}" ${status === s ? 'selected' : ''}>${s}</option>`).join('')}
              </select>
              <input type="text" class="form-input participant-note-input" data-member-id="${member.id}"
                placeholder="備考" value="${escapeHtml(note)}"
                style="width:100%; padding:4px 6px; font-size:12px; color:var(--text-secondary);">
            </div>
          </div>
        `;
      }).join('');

      dom.participantsListContent.innerHTML = summaryHtml + html;
      
      dom.participantsFilterText.value = '';
      dom.participantsFilterCategory.value = '';
      dom.participantsFilterPriority.checked = false;
    }
    
    openModal(dom.modalParticipants);
  }

  // Helper functions for live status color update
  window._pStatusBg = (s) => ({ '参加':'rgba(16,185,129,0.10)', '返答待ち':'rgba(245,158,11,0.10)', '声掛検討':'rgba(245,158,11,0.07)', '不参加':'rgba(239,68,68,0.08)', '未定':'transparent' }[s] || 'transparent');
  window._pStatusBorder = (s) => ({ '参加':'rgba(16,185,129,0.3)', '返答待ち':'rgba(245,158,11,0.3)', '声掛検討':'rgba(245,158,11,0.2)', '不参加':'rgba(239,68,68,0.25)', '未定':'transparent' }[s] || 'transparent');
  window._pStatusIcon = (s) => ({ '参加':'✅', '返答待ち':'⏳', '声掛検討':'🤔', '不参加':'❌', '未定':'　' }[s] || '　');

  function updateParticipantsFilter() {
    const filterText = dom.participantsFilterText.value.trim().toLowerCase();
    const filterCat = dom.participantsFilterCategory.value;
    const filterPrio = dom.participantsFilterPriority.checked;
    
    const rows = dom.participantsListContent.querySelectorAll('.participant-row');
    rows.forEach(row => {
      const name = row.dataset.name.toLowerCase();
      const affil = row.dataset.affiliation.toLowerCase();
      const cat = row.dataset.category;
      const prio = row.dataset.priority === 'true';

      let show = true;
      if (filterCat && cat !== filterCat) show = false;
      if (filterPrio && !prio) show = false;
      if (filterText && !name.includes(filterText) && !affil.includes(filterText)) show = false;

      row.style.display = show ? 'flex' : 'none';
    });
  }

  function submitParticipants() {
    const matchId = dom.participantsMatchId.value;
    const match = state.matches.find(m => m.id === matchId);
    if (!match) return;

    if (!match.participants) match.participants = {};
    if (!match.participantNotes) match.participantNotes = {};

    const selects = dom.participantsListContent.querySelectorAll('.participant-status-select');
    const noteInputs = dom.participantsListContent.querySelectorAll('.participant-note-input');
    
    let count = 0;
    selects.forEach(select => {
      const memberId = select.dataset.memberId;
      const status = select.value;
      if (status === '未定') {
        delete match.participants[memberId];
      } else {
        match.participants[memberId] = status;
        if (status === '参加') count++;
      }
    });

    noteInputs.forEach(input => {
      const memberId = input.dataset.memberId;
      const note = input.value.trim();
      if (note) {
        match.participantNotes[memberId] = note;
      } else {
        delete match.participantNotes[memberId];
      }
    });

    saveState();
    closeModal(dom.modalParticipants);
    render();
    showToast(`参加メンバー（${count}名）を保存しました`, '👥');
  }

  // ── Multi-user Auth & Cloud Sync Functions ──
  function startCloudSync() {
    const dataRef = ref(db, DB_PATHS.DATA);
    onValue(dataRef, (snapshot) => {
      const cloudData = snapshot.val();
      
      checkAndShowMigrationBanner(cloudData);

      if (!cloudData) {
        if (!isInitialCloudLoadDone) {
          isInitialCloudLoadDone = true;
          if ((state.matches && state.matches.length > 0) || (state.teams && state.teams.length > 0) || (state.locations && state.locations.length > 0) || (state.members && state.members.length > 0)) {
            console.log('Migrating local data to cloud...');
            saveToCloud();
            showToast('既存のローカルデータをクラウドに同期しました', '☁️');
          }
        }
        return;
      }

      if (isSavingToCloud) return;

      isInitialCloudLoadDone = true;
      let hasChange = false;
      if (cloudData.matches) { state.matches = cloudData.matches; hasChange = true; }
      if (cloudData.teams) { state.teams = cloudData.teams; hasChange = true; }
      if (cloudData.locations) { state.locations = cloudData.locations; hasChange = true; }
      if (cloudData.members) { state.members = cloudData.members; hasChange = true; }

      if (hasChange) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (e) {}
        render();
        updateSyncBadge('synced');
      }
    }, (err) => {
      console.error('Cloud sync listen error:', err);
      updateSyncBadge('error');
    });
  }

  function checkAndShowMigrationBanner(cloudData) {
    const banner = $('migration-banner');
    const bannerText = $('migration-banner-text');
    if (!banner) return;

    let localData = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) localData = JSON.parse(raw);
    } catch (e) {}

    const localMatchCount = localData && Array.isArray(localData.matches) ? localData.matches.length : 0;
    const cloudMatchCount = cloudData && Array.isArray(cloudData.matches) ? cloudData.matches.length : 0;

    if (localMatchCount > 0 && cloudMatchCount === 0) {
      if (bannerText) {
        bannerText.textContent = `この端末に保存されている既存データ（マッチ ${localMatchCount}件）があります。クラウドに送信してGitHub Pages等と共有しますか？`;
      }
      banner.style.display = 'block';
    } else {
      banner.style.display = 'none';
    }
  }

  async function forceUploadLocalToCloud() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.matches) && parsed.matches.length > 0) state.matches = parsed.matches;
        if (Array.isArray(parsed.teams) && parsed.teams.length > 0) state.teams = parsed.teams;
        if (Array.isArray(parsed.locations) && parsed.locations.length > 0) state.locations = parsed.locations;
        if (Array.isArray(parsed.members) && parsed.members.length > 0) state.members = parsed.members;
      }

      updateSyncBadge('syncing');
      const dataRef = ref(db, DB_PATHS.DATA);
      await set(dataRef, {
        matches: state.matches || [],
        teams: state.teams || [],
        locations: state.locations || [],
        members: state.members || [],
        lastUpdated: Date.now(),
        updatedBy: currentUser ? currentUser.email : 'manual_sync'
      });
      updateSyncBadge('synced');
      render();
      if ($('migration-banner')) $('migration-banner').style.display = 'none';
      closeModal($('modal-access'));
      showToast(`端末のデータ（マッチ${state.matches.length}件）をクラウドへ送信しました！`, '☁️');
    } catch (err) {
      console.error('Force upload error:', err);
      showToast('クラウドへの送信に失敗しました', '❌');
    }
  }

  function exportDataAsJson() {
    try {
      const exportObj = {
        matches: state.matches || [],
        teams: state.teams || [],
        locations: state.locations || [],
        members: state.members || [],
        exportedAt: new Date().toISOString()
      };
      const jsonStr = JSON.stringify(exportObj, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `matchboard_backup_${todayString()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('JSONファイルを書き出しました', '📥');
    } catch (err) {
      console.error('Export error:', err);
      showToast('書き出しに失敗しました', '❌');
    }
  }

  function importDataFromJson(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const parsed = JSON.parse(e.target.result);
        if (Array.isArray(parsed.matches)) state.matches = parsed.matches;
        if (Array.isArray(parsed.teams)) state.teams = parsed.teams;
        if (Array.isArray(parsed.locations)) state.locations = parsed.locations;
        if (Array.isArray(parsed.members)) state.members = parsed.members;

        saveState();
        render();
        closeModal($('modal-access'));
        showToast(`JSONデータを取り込みました（マッチ${state.matches.length}件）`, '✅');
      } catch (err) {
        console.error('Import parse error:', err);
        showToast('JSONファイルの形式が正しくありません', '❌');
      }
    };
    reader.readAsText(file);
  }

  function renderAllowedUsersList() {
    const container = $('allowed-users-list');
    if (!container) return;
    container.innerHTML = '';

    if (allowedEmails.length === 0) {
      container.innerHTML = '<div style="padding: 12px; font-size: 13px; color: var(--text-secondary); text-align: center;">登録されたメンバーはいません</div>';
      return;
    }

    allowedEmails.forEach(email => {
      const item = document.createElement('div');
      item.className = 'allowed-user-item';

      const isAdmin = email.toLowerCase() === DEFAULT_ADMIN_EMAIL.toLowerCase();

      item.innerHTML = `
        <div class="allowed-user-email">
          <span>📧</span>
          <span>${escapeHtml(email)}</span>
          ${isAdmin ? '<span class="allowed-user-tag admin">管理者</span>' : ''}
        </div>
        ${!isAdmin ? `<button class="btn-remove-user" data-email="${escapeHtml(email)}" title="アクセス権を削除">✕</button>` : '<span style="font-size: 11px; color: var(--text-secondary); padding: 0 6px;">常時許可</span>'}
      `;

      if (!isAdmin) {
        item.querySelector('.btn-remove-user').addEventListener('click', (e) => {
          const targetEmail = e.currentTarget.dataset.email;
          removeAllowedUser(targetEmail);
        });
      }

      container.appendChild(item);
    });
  }

  async function addAllowedUser(email) {
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail) return;

    if (allowedEmails.includes(cleanEmail)) {
      showToast('既に登録されているメールアドレスです', '⚠️');
      return;
    }

    allowedEmails.push(cleanEmail);
    try {
      const allowedRef = ref(db, DB_PATHS.ALLOWED_USERS);
      await set(allowedRef, allowedEmails);
      renderAllowedUsersList();
      showToast(`${cleanEmail} を共有メンバーに追加しました`, '✅');
      $('input-new-allowed-email').value = '';
    } catch (err) {
      console.error('Failed to add user:', err);
      showToast('追加に失敗しました', '❌');
    }
  }

  async function removeAllowedUser(email) {
    const cleanEmail = email.trim().toLowerCase();
    if (cleanEmail === DEFAULT_ADMIN_EMAIL.toLowerCase()) {
      showToast('管理者は削除できません', '⚠️');
      return;
    }

    allowedEmails = allowedEmails.filter(e => e !== cleanEmail);
    try {
      const allowedRef = ref(db, DB_PATHS.ALLOWED_USERS);
      await set(allowedRef, allowedEmails);
      renderAllowedUsersList();
      showToast(`${cleanEmail} を削除しました`, '🗑️');
    } catch (err) {
      console.error('Failed to remove user:', err);
      showToast('削除に失敗しました', '❌');
    }
  }

  function initAuthAndAccess() {
    const authOverlay = $('auth-overlay');
    const authViewLoading = $('auth-view-loading');
    const authViewLogin = $('auth-view-login');
    const authViewDenied = $('auth-view-denied');
    const deniedUserEmail = $('denied-user-email');
    const userProfileWidget = $('user-profile-widget');
    const headerAvatar = $('header-user-avatar');
    const errorBox = $('auth-error-box');

    function showAuthError(err) {
      console.error('Firebase Auth Error:', err);
      if (!errorBox) {
        alert('ログインエラー: ' + (err.message || err.code || '不明なエラー'));
        return;
      }

      errorBox.style.display = 'block';
      let title = '';
      let detail = '';

      const code = err.code || '';
      if (code === 'auth/operation-not-allowed') {
        title = '⚠️ <strong>Googleログインが有効化されていません</strong>';
        detail = 'Firebaseコンソール（<code>nakanofa-tournament-2026</code>）の [Authentication] &gt; [Sign-in method] で「Google」を有効にする必要があります。';
      } else if (code === 'auth/unauthorized-domain') {
        title = `⚠️ <strong>未承認のドメインです (${window.location.hostname})</strong>`;
        detail = `Firebaseコンソールの [Authentication] &gt; [設定] &gt; [承認済みドメイン] に <code>${window.location.hostname}</code> を追加してください。`;
      } else if (code === 'auth/popup-closed-by-user') {
        title = '⚠️ <strong>ログインウィンドウが閉じられました</strong>';
        detail = 'ポップアップが自動的または手動で閉じられました。ブラウザのポップアップブロックをご確認いただくか、下のボタンでページ移動してログインをお試しください。';
      } else if (code === 'auth/popup-blocked') {
        title = '⚠️ <strong>ポップアップがブロックされました</strong>';
        detail = 'ブラウザのアドレスバー右端などでポップアップを許可するか、下のボタンをお試しください。';
      } else {
        title = `⚠️ <strong>ログインエラー (${escapeHtml(code || 'Error')})</strong>`;
        detail = escapeHtml(err.message || 'ログイン処理に失敗しました。');
      }

      errorBox.innerHTML = `
        <div style="font-weight: 600; margin-bottom: 4px;">${title}</div>
        <div style="font-size: 12px; color: #fecaca; line-height: 1.4; margin-bottom: 10px;">${detail}</div>
        <button id="btn-fallback-redirect" type="button" style="width: 100%; padding: 8px 12px; font-size: 12px; background: rgba(255,255,255,0.2); border: 1px solid rgba(255,255,255,0.35); border-radius: 6px; color: #fff; cursor: pointer; font-weight: 500;">
          🔄 ページ移動してログイン（ポップアップを使わない方式）
        </button>
      `;

      $('btn-fallback-redirect')?.addEventListener('click', async () => {
        try {
          await loginWithGoogleRedirect();
        } catch (e) {
          console.error('Redirect error:', e);
        }
      });
    }

    // リダイレクトログイン結果のチェック
    checkRedirectResult().catch(err => {
      if (err) showAuthError(err);
    });

    // Google Login Buttons
    $('btn-google-login')?.addEventListener('click', async () => {
      if (errorBox) errorBox.style.display = 'none';
      try {
        await loginWithGoogle();
      } catch (err) {
        showAuthError(err);
      }
    });

    $('btn-relogin-google')?.addEventListener('click', async () => {
      try {
        await loginWithGoogle();
      } catch (err) {
        showAuthError(err);
      }
    });

    // Logout Buttons
    $('btn-header-logout')?.addEventListener('click', async () => {
      try {
        await logoutUser();
        showToast('ログアウトしました', '👋');
      } catch (err) {
        console.error('Logout error:', err);
      }
    });

    $('btn-denied-logout')?.addEventListener('click', async () => {
      try {
        await logoutUser();
      } catch (err) {
        console.error('Logout error:', err);
      }
    });

    // Access Modal
    $('btn-open-access-modal')?.addEventListener('click', () => {
      renderAllowedUsersList();
      openModal($('modal-access'));
    });

    $('modal-access-close')?.addEventListener('click', () => {
      closeModal($('modal-access'));
    });

    $('form-add-allowed-user')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const email = $('input-new-allowed-email').value;
      addAllowedUser(email);
    });

    // Data Migration & Sync Buttons
    $('btn-banner-sync-now')?.addEventListener('click', () => {
      forceUploadLocalToCloud();
    });

    $('btn-banner-dismiss')?.addEventListener('click', () => {
      if ($('migration-banner')) $('migration-banner').style.display = 'none';
    });

    $('btn-force-upload-cloud')?.addEventListener('click', () => {
      forceUploadLocalToCloud();
    });

    $('btn-export-json')?.addEventListener('click', () => {
      exportDataAsJson();
    });

    $('input-import-json')?.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) {
        importDataFromJson(file);
        e.target.value = '';
      }
    });

    // 認証リスナー
    onAuthStateChanged(auth, async (user) => {
      currentUser = user;

      if (!user) {
        // 未ログイン状態
        isAuthorized = false;
        authOverlay.style.display = 'flex';
        authViewLoading.style.display = 'none';
        authViewLogin.style.display = 'block';
        authViewDenied.style.display = 'none';
        if (userProfileWidget) userProfileWidget.style.display = 'none';
        return;
      }

      // ログイン済み -> 許可ユーザーリストを購読
      const allowedRef = ref(db, DB_PATHS.ALLOWED_USERS);
      onValue(allowedRef, async (snapshot) => {
        const val = snapshot.val();
        if (Array.isArray(val) && val.length > 0) {
          allowedEmails = val.map(e => String(e).toLowerCase());
        } else {
          // 初期状態ならデフォルト管理者をDBに登録
          allowedEmails = [DEFAULT_ADMIN_EMAIL.toLowerCase()];
          try {
            await set(allowedRef, allowedEmails);
          } catch (e) {}
        }

        // デフォルト管理者は必ず含める
        if (!allowedEmails.includes(DEFAULT_ADMIN_EMAIL.toLowerCase())) {
          allowedEmails.unshift(DEFAULT_ADMIN_EMAIL.toLowerCase());
        }

        const userEmail = (user.email || '').toLowerCase();
        isAuthorized = allowedEmails.includes(userEmail);

        if (isAuthorized) {
          // アクセス許可
          authOverlay.style.display = 'none';
          authViewLoading.style.display = 'none';
          authViewLogin.style.display = 'none';
          authViewDenied.style.display = 'none';

          if (userProfileWidget) {
            userProfileWidget.style.display = 'flex';
            if (user.photoURL && headerAvatar) {
              headerAvatar.src = user.photoURL;
              headerAvatar.style.display = 'block';
            }
          }

          startCloudSync();
        } else {
          // アクセス権限なし
          authOverlay.style.display = 'flex';
          authViewLoading.style.display = 'none';
          authViewLogin.style.display = 'none';
          authViewDenied.style.display = 'block';
          if (deniedUserEmail) deniedUserEmail.textContent = user.email || '不明なアカウント';
          if (userProfileWidget) userProfileWidget.style.display = 'none';
        }
      }, (err) => {
        console.error('Failed to listen to allowed users:', err);
        // DBエラー時、デフォルト管理者ならフォールバック許可
        const userEmail = (user.email || '').toLowerCase();
        if (userEmail === DEFAULT_ADMIN_EMAIL.toLowerCase()) {
          isAuthorized = true;
          authOverlay.style.display = 'none';
          if (userProfileWidget) userProfileWidget.style.display = 'flex';
          startCloudSync();
        } else {
          authOverlay.style.display = 'flex';
          authViewLoading.style.display = 'none';
          authViewLogin.style.display = 'none';
          authViewDenied.style.display = 'block';
          if (deniedUserEmail) deniedUserEmail.textContent = user.email;
        }
      });
    });
  }

  // ── Boot ──
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
