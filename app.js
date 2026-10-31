// BRAVEPRINT STYLE // POZİSYON JÜRİ TAKİP PLATFORMU

let ws;
let state = {
  students: [],
  activeStudentId: null,
  totalPositionCount: 0,
  juryRunning: false,
  juryStartTime: null,
  comboStreak: 0,
  recentClicks: []
};

let soundEnabled = localStorage.getItem('pozisyon_sound') !== 'false';
let myNickname = localStorage.getItem('pozisyon_nickname') || '';
let audioCtx = null;

// ==================== TEMA YÖNETİMİ ====================
function initTheme() {
  const saved = localStorage.getItem('pozisyon_dark_theme');
  // Varsayılan olarak KOYU TEMA (Dark Mode)
  const isDark = saved === null ? true : saved === 'true';
  if (isDark) {
    document.body.classList.add('dark-mode');
  } else {
    document.body.classList.remove('dark-mode');
  }
}

function toggleTheme() {
  const isDark = document.body.classList.toggle('dark-mode');
  localStorage.setItem('pozisyon_dark_theme', isDark);
}

// ==================== SES EFEKTLERİ (Web Audio) ====================
function getAudioContext() {
  if (!audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      audioCtx = new AudioContext();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

function playPozisyonSound(combo = 1) {
  if (!soundEnabled) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (combo >= 3) {
      // Çift tonlu uyarı
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(587.33, now); // D5
      osc.frequency.setValueAtTime(880.00, now + 0.08); // A5
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      osc.start(now);
      osc.stop(now + 0.22);
    } else {
      // Mekanik daktilo / klik tonu
      osc.type = 'sine';
      osc.frequency.setValueAtTime(620, now);
      osc.frequency.exponentialRampToValueAtTime(940, now + 0.07);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      osc.start(now);
      osc.stop(now + 0.12);
    }
  } catch (e) {}
}

function playUndoSound() {
  if (!soundEnabled) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(110, now + 0.1);
    gain.gain.setValueAtTime(0.1, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
    osc.start(now);
    osc.stop(now + 0.1);
  } catch (e) {}
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  localStorage.setItem('pozisyon_sound', soundEnabled);
  const statusEl = document.getElementById('sound-status-text');
  if (statusEl) {
    statusEl.textContent = soundEnabled ? 'AÇIK' : 'KAPALI';
  }
}

// ==================== WEBSOCKET BAĞLANTISI ====================
function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    updateClientCount('BAĞLI');
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    } catch (e) {
      console.error('Mesaj parse hatası:', e);
    }
  };

  ws.onclose = () => {
    updateClientCount('KOPUK');
    setTimeout(initWebSocket, 2000);
  };
}

function sendAction(action) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    action.userName = myNickname;
    ws.send(JSON.stringify(action));
  }
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'INIT_STATE':
      state = msg.state;
      if (msg.clientCount) updateClientCount(msg.clientCount);
      renderAll();
      break;

    case 'STATE_UPDATED':
      state = msg.state;
      renderAll();
      break;

    case 'POZISYON_TRIGGERED': {
      state.totalPositionCount = msg.totalPositionCount;
      state.comboStreak = msg.combo;
      const student = state.students.find(s => s.id === msg.studentId);
      if (student) {
        student.count = msg.newStudentCount;
      }
      if (msg.logItem) {
        if (!state.recentClicks) state.recentClicks = [];
        state.recentClicks.unshift(msg.logItem);
        if (state.recentClicks.length > 25) state.recentClicks.pop();
      }

      playPozisyonSound(msg.combo);
      showFloatingIndicator(`+${msg.amount}`);
      renderActiveStudent();
      renderStats();
      renderPodium();
      renderStudentsList();
      renderActivityStream();
      break;
    }

    case 'UNDO_TRIGGERED': {
      state.totalPositionCount = msg.totalPositionCount;
      const student = state.students.find(s => s.id === msg.studentId);
      if (student) {
        student.count = msg.newStudentCount;
      }
      if (msg.logItem) {
        if (!state.recentClicks) state.recentClicks = [];
        state.recentClicks.unshift(msg.logItem);
      }
      playUndoSound();
      showFloatingIndicator('-1');
      renderActiveStudent();
      renderStats();
      renderPodium();
      renderStudentsList();
      renderActivityStream();
      break;
    }

    case 'TIMER_STATE_CHANGED':
      state.juryRunning = msg.juryRunning;
      state = msg.state || state;
      updateTimerDisplay();
      renderActiveStudent();
      break;

    case 'TIMER_TICK':
      if (msg.activeStudentId === state.activeStudentId) {
        updateTimerDisplay(msg.elapsedSeconds);
      }
      break;

    case 'CONSENSUS_WAITING': {
      const banner = document.getElementById('consensus-banner');
      const text = document.getElementById('consensus-text');
      const sublbl = document.getElementById('btn-pozisyon-sublbl');
      
      if (banner && text) {
        banner.style.display = 'block';
        if (msg.initiatedBy.toLowerCase() === myNickname.toLowerCase()) {
          text.innerHTML = `[ 1/2 ONAY ] Sen bastın! Arkadaşının doğrulaması bekleniyor... (3 sn)`;
          banner.style.borderColor = '#D97706';
          banner.style.color = '#D97706';
          if (sublbl) sublbl.textContent = '[ DİĞER BİRİ BASMALI ]';
        } else {
          text.innerHTML = `[ 1/2 ONAY ] <strong>${escapeHtml(msg.initiatedBy)}</strong> bastı! Onaylamak için hemen tıkla! (3 sn)`;
          banner.style.borderColor = '#10B981';
          banner.style.color = '#10B981';
          if (sublbl) sublbl.textContent = '[ 2. ONAY İÇİN HEMEN TIKLA! ]';
        }
      }
      playPozisyonSound(1);
      break;
    }

    case 'CONSENSUS_CONFIRMED': {
      state.totalPositionCount = msg.totalPositionCount;
      state.comboStreak = msg.combo;
      const student = state.students.find(s => s.id === msg.studentId);
      if (student) student.count = msg.newStudentCount;

      if (msg.logItem) {
        if (!state.recentClicks) state.recentClicks = [];
        state.recentClicks.unshift(msg.logItem);
      }

      const banner = document.getElementById('consensus-banner');
      const text = document.getElementById('consensus-text');
      const sublbl = document.getElementById('btn-pozisyon-sublbl');
      if (banner && text) {
        banner.style.display = 'block';
        banner.style.borderColor = '#10B981';
        banner.style.color = '#10B981';
        text.innerHTML = `[ 2/2 ONAYLANDI ] ${escapeHtml(msg.firstUser)} & ${escapeHtml(msg.secondUser)} (+1 POZİSYON!)`;
        setTimeout(() => {
          banner.style.display = 'none';
          if (sublbl) sublbl.textContent = '[ +1 SAYAC // SPACE ]';
        }, 2200);
      }

      playPozisyonSound(msg.combo || 2);
      showFloatingIndicator('+1 ONAYLANDI!');
      renderActiveStudent();
      renderStats();
      renderPodium();
      renderStudentsList();
      renderActivityStream();
      break;
    }

    case 'CONSENSUS_EXPIRED': {
      const banner = document.getElementById('consensus-banner');
      const text = document.getElementById('consensus-text');
      const sublbl = document.getElementById('btn-pozisyon-sublbl');
      if (banner && text) {
        text.textContent = `[ ZAMAN AŞIMI ] ${escapeHtml(msg.initiatedBy)}'in pozisyonu doğrulanmadı.`;
        banner.style.borderColor = '#6B7280';
        banner.style.color = '#9CA3AF';
        setTimeout(() => {
          banner.style.display = 'none';
          if (sublbl) sublbl.textContent = '[ +1 SAYAC // SPACE ]';
        }, 1800);
      }
      break;
    }

    case 'ORACLE_ANNOUNCED': {
      state.lastOracle = msg.result;
      state.oracleLeaderboard = msg.oracleLeaderboard;
      renderOracleBanner();
      renderOracleLeaderboard();
      break;
    }

    case 'CLIENT_COUNT':
      updateClientCount(msg.count);
      break;
  }
}

function updateClientCount(count) {
  const el = document.getElementById('client-count');
  if (el) el.textContent = count;
}

// ==================== RENDERING ====================
function renderAll() {
  renderActiveStudent();
  renderStats();
  renderPodium();
  renderStudentsList();
  renderQuickSelect();
  renderActivityStream();
  renderConsensusStatus();
  renderGlobalPredictions();
  updateTimerDisplay();
}

function toggleConsensusMode() {
  sendAction({ type: 'TOGGLE_CONSENSUS_MODE' });
}

function renderConsensusStatus() {
  const text = document.getElementById('consensus-status-text');
  if (text) {
    if (state.consensusMode) {
      text.textContent = '2 KİŞİ ONAYI';
      text.style.color = 'var(--blue)';
    } else {
      text.textContent = 'TEK TIK (KLASİK)';
      text.style.color = 'var(--green)';
    }
  }
}

function renderGlobalPredictions() {
  const container = document.getElementById('global-predictions-list');
  const leaderList = document.getElementById('oracle-top-list');
  if (!container) return;

  const predictions = state.globalPredictions || [];
  if (predictions.length === 0) {
    container.innerHTML = '<span style="opacity:0.5;font-style:italic;font-size:10px;">Henüz tahmin girilmedi</span>';
    if (leaderList) leaderList.innerHTML = '<span style="opacity:0.6;font-style:italic;">Tahmin bekleniyor</span>';
    return;
  }

  const currentTotal = state.totalPositionCount || 0;

  // Mevcut toplama en yakın tahminden uzağa doğru sırala
  const sorted = [...predictions].sort((a, b) => {
    const diffA = Math.abs(a.guess - currentTotal);
    const diffB = Math.abs(b.guess - currentTotal);
    return diffA - diffB;
  });

  const best = sorted[0];

  // Lider Kahin rozeti
  if (leaderList && best) {
    const bestDiff = Math.abs(best.guess - currentTotal);
    leaderList.innerHTML = `
      <span style="border:1px solid #8B5CF6;background:rgba(139,92,246,0.12);color:#8B5CF6;padding:2px 8px;font-weight:bold;white-space:nowrap;">
        👑 ${escapeHtml(best.user)} (${best.guess} PZ | Fark: ${bestDiff})
      </span>
    `;
  }

  // Liste gösterimi
  container.innerHTML = sorted.map((p, idx) => {
    const diff = Math.abs(p.guess - currentTotal);
    const isLeader = idx === 0;
    const isMyGuess = p.user.toLowerCase() === (myNickname || '').toLowerCase();

    let diffText = '';
    if (p.guess === currentTotal) {
      diffText = '<span style="color:var(--green);font-weight:bold;">TAM İSABET!</span>';
    } else if (p.guess > currentTotal) {
      diffText = `<span style="opacity:0.75;">+${p.guess - currentTotal} kaldı</span>`;
    } else {
      diffText = `<span style="opacity:0.75;">-${currentTotal - p.guess} aşıldı</span>`;
    }

    return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 6px;border:1px solid ${isLeader ? '#8B5CF6' : 'var(--line)'};background:${isLeader ? 'rgba(139,92,246,0.08)' : 'var(--soft)'};">
        <div style="display:flex;align-items:center;gap:6px;min-width:0;">
          ${isLeader ? '<span style="color:#8B5CF6;">👑</span>' : `<span style="font-size:9px;opacity:0.5;">#${idx + 1}</span>`}
          <span style="font-weight:bold;${isMyGuess ? 'color:var(--blue);' : ''}">${escapeHtml(p.user)}</span>
          ${isMyGuess ? '<span style="font-size:8px;padding:1px 4px;border:1px solid var(--blue);color:var(--blue);">SEN</span>' : ''}
        </div>
        <div style="display:flex;align-items:center;gap:8px;font-family:var(--font);font-size:10px;">
          <strong>${p.guess} PZ</strong>
          ${diffText}
        </div>
      </div>
    `;
  }).join('');
}

function submitGlobalPrediction() {
  const input = document.getElementById('global-prediction-input');
  if (!input) return;
  const val = parseInt(input.value);
  if (isNaN(val) || val <= 0) {
    alert('Lütfen geçerli bir toplam pozisyon sayısı girin (Örn: 240).');
    return;
  }

  sendAction({
    type: 'ADD_GLOBAL_PREDICTION',
    guess: val
  });

  input.value = '';
}

function getActiveStudent() {
  return state.students.find(s => s.id === state.activeStudentId) || state.students[0];
}

function renderActiveStudent() {
  const student = getActiveStudent();
  if (!student) return;

  const nameEl = document.getElementById('active-student-name');
  const countEl = document.getElementById('active-student-count');
  const orderEl = document.getElementById('active-student-order');
  const badgeEl = document.getElementById('jury-status-badge');
  const timerBtn = document.getElementById('timer-toggle-btn');

  if (nameEl) nameEl.textContent = student.name;
  if (countEl) countEl.textContent = student.count;

  const idx = state.students.findIndex(s => s.id === student.id);
  if (orderEl) orderEl.textContent = `SIRA ${String(idx + 1).padStart(2, '0')} / ${state.students.length}`;

  if (badgeEl) {
    if (state.juryRunning) {
      badgeEl.className = 'status-live';
      badgeEl.textContent = 'ŞU AN JÜRİDE';
    } else {
      badgeEl.className = 'status-idle';
      badgeEl.textContent = 'BEKLİYOR';
    }
  }

  if (timerBtn) {
    if (state.juryRunning) {
      timerBtn.className = 'btn-action active-timer';
      timerBtn.textContent = '[ JÜRİYİ BİTİR ]';
    } else {
      timerBtn.className = 'btn-action';
      timerBtn.textContent = '[ SÜREYİ BAŞLAT ]';
    }
  }

  // Kombo Göstergesi
  const comboPill = document.getElementById('combo-pill');
  if (comboPill) {
    if (state.comboStreak >= 3) {
      comboPill.style.display = 'block';
      comboPill.textContent = `[ KOMBO ${state.comboStreak}x // ARDIŞIK SERİ ]`;
    } else {
      comboPill.style.display = 'none';
    }
  }

  // PPM
  const ppmEl = document.getElementById('active-ppm-val');
  const sec = (student.durationSeconds || 0);
  if (ppmEl) {
    if (sec > 10 && student.count > 0) {
      ppmEl.textContent = (student.count / (sec / 60)).toFixed(1);
    } else {
      ppmEl.textContent = '0.0';
    }
  }

  renderPredictions();
}

function updateTimerDisplay(exactSeconds) {
  const student = getActiveStudent();
  const timerEl = document.getElementById('jury-timer-val');
  if (!timerEl || !student) return;

  let totalSec = (student.durationSeconds || 0);
  if (exactSeconds !== undefined) {
    totalSec = exactSeconds;
  } else if (state.juryRunning && state.juryStartTime) {
    totalSec += Math.floor((Date.now() - state.juryStartTime) / 1000);
  }

  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  timerEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function renderStats() {
  const totalEl = document.getElementById('stat-total-val');
  const avgEl = document.getElementById('stat-avg-val');
  const countEl = document.getElementById('stat-students-count');
  const headerCountEl = document.getElementById('students-header-count');

  const total = state.totalPositionCount || 0;
  if (totalEl) totalEl.textContent = total;

  if (avgEl && state.students.length > 0) {
    avgEl.textContent = (total / state.students.length).toFixed(1);
  }

  if (countEl) countEl.textContent = state.students.length;
  if (headerCountEl) headerCountEl.textContent = state.students.length;
}

function renderPodium() {
  const sorted = [...state.students].sort((a, b) => b.count - a.count);

  const p1 = sorted[0] || { name: '-', count: 0 };
  const p2 = sorted[1] || { name: '-', count: 0 };
  const p3 = sorted[2] || { name: '-', count: 0 };

  const elP1Name = document.getElementById('podium-1-name');
  const elP1Val = document.getElementById('podium-1-val');
  const elP2Name = document.getElementById('podium-2-name');
  const elP2Val = document.getElementById('podium-2-val');
  const elP3Name = document.getElementById('podium-3-name');
  const elP3Val = document.getElementById('podium-3-val');

  if (elP1Name) elP1Name.textContent = p1.name;
  if (elP1Val) elP1Val.textContent = `${p1.count} PZ`;
  if (elP2Name) elP2Name.textContent = p2.name;
  if (elP2Val) elP2Val.textContent = `${p2.count} PZ`;
  if (elP3Name) elP3Name.textContent = p3.name;
  if (elP3Val) elP3Val.textContent = `${p3.count} PZ`;
}

function renderStudentsList() {
  const container = document.getElementById('students-list-container');
  const searchInput = document.getElementById('search-input');
  const sortSelect = document.getElementById('sort-select');

  if (!container) return;

  const query = (searchInput ? searchInput.value : '').toLowerCase().trim();
  const sortBy = sortSelect ? sortSelect.value : 'order';

  let list = [...state.students];

  if (query) {
    list = list.filter(s => s.name.toLowerCase().includes(query));
  }

  if (sortBy === 'count-desc') {
    list.sort((a, b) => b.count - a.count);
  } else if (sortBy === 'count-asc') {
    list.sort((a, b) => a.count - b.count);
  } else if (sortBy === 'ppm-desc') {
    list.sort((a, b) => {
      const ppmA = (a.durationSeconds || 0) > 0 ? a.count / (a.durationSeconds / 60) : 0;
      const ppmB = (b.durationSeconds || 0) > 0 ? b.count / (b.durationSeconds / 60) : 0;
      return ppmB - ppmA;
    });
  }

  if (list.length === 0) {
    container.innerHTML = '<div style="padding:14px;text-align:center;font-size:11px;opacity:0.6;">Öğrenci bulunamadı.</div>';
    return;
  }

  container.innerHTML = list.map((s, idx) => {
    const isActive = s.id === state.activeStudentId;
    const durationMin = Math.floor((s.durationSeconds || 0) / 60);

    return `
      <div class="student-item ${isActive ? 'active' : ''}" onclick="selectStudent('${s.id}')">
        <div class="student-info">
          <span class="student-idx">${String(idx + 1).padStart(2, '0')}.</span>
          <div>
            <div class="student-name">${escapeHtml(s.name)}</div>
            <div style="font-size:9px;opacity:0.6;margin-top:1px;">
              ⏱ ${durationMin} dk ${s.predictions && s.predictions.length ? `| 🔮 ${s.predictions.length} Tahmin` : ''}
            </div>
          </div>
        </div>

        <div style="display:flex;align-items:center;gap:10px;">
          <div class="student-count">
            ${s.count} <small>PZ</small>
          </div>
          <button onclick="event.stopPropagation(); quickAdd('${s.id}')" class="btn-action" style="padding:2px 8px;font-size:10px;">
            +1
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function renderQuickSelect() {
  const select = document.getElementById('student-quick-select');
  if (!select) return;

  select.innerHTML = state.students.map((s, idx) => `
    <option value="${s.id}" ${s.id === state.activeStudentId ? 'selected' : ''}>
      ${String(idx + 1).padStart(2, '0')}. ${s.name} (${s.count})
    </option>
  `).join('');
}

function renderActivityStream() {
  const container = document.getElementById('live-activity-stream');
  if (!container) return;

  if (!state.recentClicks || state.recentClicks.length === 0) {
    container.innerHTML = '<div style="padding:12px;text-align:center;opacity:0.5;">Henüz kayıt yok.</div>';
    return;
  }

  container.innerHTML = state.recentClicks.slice(0, 15).map(item => {
    const timeFormatted = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const isUndo = item.isUndo || item.amount < 0;

    return `
      <div class="stream-row">
        <div style="display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;text-overflow:ellipsis;">
          <strong style="color:var(--blue);">${escapeHtml(item.by)}</strong>
          <span style="opacity:0.8;font-size:10px;">${isUndo ? 'geri aldı' : `"${escapeHtml(item.studentName)}" için`}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;font-family:var(--font);flex-shrink:0;">
          <strong style="${isUndo ? 'color:var(--red);' : 'color:var(--text);'}">${isUndo ? '-1' : `+${item.amount}`}</strong>
          <span style="opacity:0.5;font-size:9px;">${timeFormatted}</span>
        </div>
      </div>
    `;
  }).join('');
}

function renderPredictions() {
  const container = document.getElementById('predictions-stream');
  const student = getActiveStudent();
  if (!container || !student) return;

  if (!student.predictions || student.predictions.length === 0) {
    container.innerHTML = '<span style="opacity:0.5;font-style:italic;">Tahmin girilmedi</span>';
    return;
  }

  container.innerHTML = student.predictions.map(p => `
    <span style="border:1px solid var(--line);padding:2px 6px;background:var(--soft);white-space:nowrap;">
      <strong>${escapeHtml(p.user)}:</strong> ${p.guess}
    </span>
  `).join('');
}

// ==================== KULLANICI EYLEMLERİ ====================
function triggerPozisyon(amount = 1) {
  if ('vibrate' in navigator) {
    navigator.vibrate(amount > 1 ? [40, 30, 40] : [30]);
  }

  sendAction({
    type: 'POZISYON_CLICK',
    amount: amount
  });
}

function undoPozisyon() {
  if ('vibrate' in navigator) navigator.vibrate([25]);
  sendAction({
    type: 'UNDO_CLICK'
  });
}

function quickAdd(studentId) {
  if (studentId === state.activeStudentId) {
    triggerPozisyon(1);
  } else {
    selectStudent(studentId);
    setTimeout(() => triggerPozisyon(1), 120);
  }
}

function selectStudent(studentId) {
  sendAction({
    type: 'SET_ACTIVE_STUDENT',
    studentId: studentId
  });
}

function nextStudent() {
  const currentIndex = state.students.findIndex(s => s.id === state.activeStudentId);
  if (currentIndex < state.students.length - 1) {
    selectStudent(state.students[currentIndex + 1].id);
  } else {
    alert('Listenin sonundasınız.');
  }
}

function toggleJuryTimer() {
  sendAction({
    type: 'TOGGLE_JURY_TIMER'
  });
}

function submitPrediction() {
  const input = document.getElementById('prediction-input');
  if (!input) return;
  const val = parseInt(input.value);
  if (isNaN(val) || val < 0) {
    alert('Geçerli bir pozisyon sayısı girin.');
    return;
  }

  sendAction({
    type: 'ADD_PREDICTION',
    studentId: state.activeStudentId,
    guess: val
  });

  input.value = '';
}

function resetAllPrompt() {
  const pin = prompt('⚠️ GÜVENLİK KONTROLÜ:\nTüm sayaçları sıfırlamak için şifreyi girin:');
  if (pin === null) return;
  if (pin.trim() === '1816') {
    const confirmed = confirm('DİKKAT: Tüm sayaçlar ve jüri süreleri sıfırlanacak. Onaylıyor musunuz?');
    if (confirmed) {
      sendAction({ type: 'RESET_ALL', pin: '1816' });
    }
  } else {
    alert('Hatalı şifre! Sıfırlama işlemi engellendi.');
  }
}

function checkNicknameOnLoad() {
  const saved = localStorage.getItem('pozisyon_nickname');
  if (!saved || !saved.trim()) {
    openNicknameModal();
  } else {
    myNickname = saved.trim();
    updateNicknameDisplay();
  }
}

function openNicknameModal() {
  const modal = document.getElementById('nickname-modal');
  const input = document.getElementById('nickname-modal-input');
  if (modal) modal.classList.add('open');
  if (input) {
    input.value = myNickname || '';
    setTimeout(() => input.focus(), 150);
  }
}

function closeNicknameModal(useDefaultIfEmpty = false) {
  const modal = document.getElementById('nickname-modal');
  if (modal) modal.classList.remove('open');
  if (useDefaultIfEmpty && (!myNickname || !myNickname.trim())) {
    myNickname = 'Öğrenci ' + Math.floor(10 + Math.random() * 90);
    localStorage.setItem('pozisyon_nickname', myNickname);
    updateNicknameDisplay();
  }
}

function saveNicknameFromModal(e) {
  if (e) e.preventDefault();
  const input = document.getElementById('nickname-modal-input');
  if (input && input.value.trim()) {
    myNickname = input.value.trim().substring(0, 20);
    localStorage.setItem('pozisyon_nickname', myNickname);
    updateNicknameDisplay();
    closeNicknameModal(false);
  }
}

function updateNicknameDisplay() {
  const display = document.getElementById('user-nickname-display');
  if (display) display.textContent = myNickname || 'Sen';
}

function changeNicknamePrompt() {
  openNicknameModal();
}

function toggleBossMode() {
  const screen = document.getElementById('boss-screen');
  if (screen) screen.classList.toggle('active');
}

function showFloatingIndicator(text) {
  const arena = document.getElementById('action-arena');
  if (!arena) return;

  const el = document.createElement('div');
  el.className = 'floating-count';
  el.textContent = text;
  el.style.left = '50%';
  el.style.top = '35%';
  arena.appendChild(el);

  setTimeout(() => el.remove(), 800);
}

// ==================== QR & MOBİL MODAL ====================
async function openQrModal() {
  const modal = document.getElementById('qr-modal');
  if (!modal) return;
  modal.classList.add('open');

  try {
    const res = await fetch('/api/network-info');
    const data = await res.json();
    const img = document.getElementById('qr-img');
    const input = document.getElementById('qr-url-input');
    if (img && data.qrDataUrl) img.src = data.qrDataUrl;
    if (input && data.url) input.value = data.url;
  } catch (e) {}
}

function closeQrModal() {
  const modal = document.getElementById('qr-modal');
  if (modal) modal.classList.remove('open');
}

function copyQrUrl() {
  const input = document.getElementById('qr-url-input');
  if (input && input.value) {
    navigator.clipboard.writeText(input.value).then(() => {
      alert('Bağlantı kopyalandı: ' + input.value);
    });
  }
}

// ==================== TOPLU ÖĞRENCİ YÜKLEME ====================
function openImportModal() {
  const modal = document.getElementById('import-modal');
  const textarea = document.getElementById('import-textarea');
  if (!modal) return;
  modal.classList.add('open');

  if (textarea) {
    textarea.value = state.students.map(s => s.name).join('\n');
  }
}

function closeImportModal() {
  const modal = document.getElementById('import-modal');
  if (modal) modal.classList.remove('open');
}

function fillSampleStudents() {
  const textarea = document.getElementById('import-textarea');
  if (!textarea) return;
  const sample = [
    'Ahmet Yılmaz', 'Ayşe Demir', 'Mehmet Kaya', 'Zeynep Çelik', 'Can Şahin',
    'Elif Yıldız', 'Burak Öztürk', 'Büşra Aydın', 'Emre Arslan', 'Gamze Doğan',
    'Deniz Kılıç', 'Ece Güneş', 'Mert Koç', 'Selin Kurt', 'Umut Karaca',
    'Ceren Avcı', 'Onur Tekin', 'İrem Şen', 'Oğuzhan Polat', 'Melis Bulut',
    'Barış Erdoğan', 'Seda Yalçın', 'Batuhan Özdemir', 'Derya Korkmaz', 'Kaan Aksoy',
    'Ezgi Çetin', 'Tolga Taş', 'Damla Yavuz', 'Serkan Uçar', 'Hande Aktaş',
    'Berk Gök', 'Tuana Keskin', 'Görkem Güler', 'Nil Özkan', 'Kutay Yiğit'
  ];
  textarea.value = sample.join('\n');
}

function saveImportedStudents() {
  const textarea = document.getElementById('import-textarea');
  if (!textarea) return;

  const names = textarea.value.split('\n')
    .map(l => l.replace(/^\d+[\.\-\)]\s*/, '').trim())
    .filter(n => n.length > 0);

  if (names.length === 0) {
    alert('En az bir isim girilmelidir.');
    return;
  }

  const updated = names.map((name, i) => {
    const existing = state.students.find(s => s.name.toLowerCase() === name.toLowerCase());
    return {
      id: existing ? existing.id : `student_${i + 1}_${Date.now()}`,
      name: name,
      count: existing ? existing.count : 0,
      status: i === 0 ? 'active' : (existing ? existing.status : 'pending'),
      durationSeconds: existing ? existing.durationSeconds : 0,
      predictions: existing ? existing.predictions : [],
      history: existing ? existing.history : []
    };
  });

  sendAction({
    type: 'UPDATE_STUDENTS_LIST',
    students: updated
  });

  closeImportModal();
}

// ==================== KLAVYE KISAYOLLARI ====================
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    toggleBossMode();
    return;
  }

  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
    return;
  }

  if (e.code === 'Space') {
    e.preventDefault();
    triggerPozisyon(1);
  }

  if (e.key.toLowerCase() === 'b') {
    toggleBossMode();
  }
});

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

window.addEventListener('DOMContentLoaded', () => {
  initTheme();
  checkNicknameOnLoad();

  const soundStatus = document.getElementById('sound-status-text');
  if (soundStatus) soundStatus.textContent = soundEnabled ? 'AÇIK' : 'KAPALI';

  setInterval(() => {
    if (state.juryRunning) updateTimerDisplay();
  }, 1000);

  initWebSocket();
});
