const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cors = require('cors');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

app.use(cors());
app.use(express.json());

// Farklı klasör yapılarına karşı toleranslı statik sunucu
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));
app.use('/public', express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  const possiblePaths = [
    path.join(__dirname, 'public', 'index.html'),
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'pozsyon sayacı', 'public', 'index.html'),
    path.join(__dirname, 'pozsyon sayacı', 'index.html')
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return res.sendFile(p);
    }
  }
  res.status(404).send('index.html dosyası bulunamadı. Lütfen GitHub reposundaki dosya yollarını kontrol edin.');
});

// Yerel Ağ IP Tespiti
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        if (iface.address.startsWith('192.168.') || iface.address.startsWith('10.') || iface.address.startsWith('172.')) {
          return iface.address;
        }
      }
    }
  }
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// 35 Öğrenci Varsayılan Şablonu
function getDefaultStudents() {
  const sampleNames = [
    'Ahmet Yılmaz', 'Ayşe Demir', 'Mehmet Kaya', 'Zeynep Çelik', 'Can Şahin',
    'Elif Yıldız', 'Burak Öztürk', 'Büşra Aydın', 'Emre Arslan', 'Gamze Doğan',
    'Deniz Kılıç', 'Ece Güneş', 'Mert Koç', 'Selin Kurt', 'Umut Karaca',
    'Ceren Avcı', 'Onur Tekin', 'İrem Şen', 'Oğuzhan Polat', 'Melis Bulut',
    'Barış Erdoğan', 'Seda Yalçın', 'Batuhan Özdemir', 'Derya Korkmaz', 'Kaan Aksoy',
    'Ezgi Çetin', 'Tolga Taş', 'Damla Yavuz', 'Serkan Uçar', 'Hande Aktaş',
    'Berk Gök', 'Tuana Keskin', 'Görkem Güler', 'Nil Özkan', 'Kutay Yiğit'
  ];

  return sampleNames.map((name, index) => ({
    id: `student_${index + 1}`,
    name,
    count: 0,
    status: index === 0 ? 'active' : 'pending',
    durationSeconds: 0,
    history: [],
    predictions: []
  }));
}

function loadDatabase() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (fs.existsSync(DB_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (data && data.students && Array.isArray(data.students)) {
        if (data.consensusMode === undefined) data.consensusMode = true;
        if (!data.oracleLeaderboard) data.oracleLeaderboard = {};
        if (!data.globalPredictions) data.globalPredictions = [];
        return data;
      }
    } catch (e) {
      console.error('db.json okunurken hata:', e);
    }
  }

  const defaultStudents = getDefaultStudents();
  const initialData = {
    title: 'POZİSYON JÜRİ TAKİBİ',
    activeStudentId: defaultStudents[0].id,
    juryRunning: false,
    juryStartTime: null,
    totalPositionCount: 0,
    comboStreak: 0,
    lastClickTimestamp: 0,
    recentClicks: [],
    consensusMode: true,
    consensusPending: null,
    oracleLeaderboard: {},
    lastOracle: null,
    globalPredictions: [],
    students: defaultStudents
  };

  saveDatabase(initialData);
  return initialData;
}

let db = loadDatabase();
let consensusTimer = null;

function saveDatabase(dataToSave) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(dataToSave || db, null, 2), 'utf8');
  } catch (err) {
    console.error('Veri kayıt hatası:', err);
  }
}

function broadcast(message) {
  const payload = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// Kahin (Tahmin) Sonucunu Hesapla
function resolveOracle(student) {
  if (!student || !student.predictions || student.predictions.length === 0) return null;

  const actual = student.count;
  let bestDiff = Infinity;
  student.predictions.forEach(p => {
    const diff = Math.abs(p.guess - actual);
    if (diff < bestDiff) bestDiff = diff;
  });

  const winners = student.predictions.filter(p => Math.abs(p.guess - actual) === bestDiff);
  if (winners.length === 0) return null;

  if (!db.oracleLeaderboard) db.oracleLeaderboard = {};
  winners.forEach(w => {
    db.oracleLeaderboard[w.user] = (db.oracleLeaderboard[w.user] || 0) + 1;
  });

  const oracleResult = {
    studentName: student.name,
    actualCount: actual,
    bestDiff: bestDiff,
    winners: winners.map(w => ({
      user: w.user,
      guess: w.guess,
      exact: w.guess === actual
    }))
  };

  db.lastOracle = oracleResult;
  saveDatabase();

  broadcast({
    type: 'ORACLE_ANNOUNCED',
    result: oracleResult,
    oracleLeaderboard: db.oracleLeaderboard
  });

  return oracleResult;
}

// 1 Saniyelik Kronometre Tick
setInterval(() => {
  if (db.juryRunning && db.juryStartTime && db.activeStudentId) {
    const student = db.students.find(s => s.id === db.activeStudentId);
    if (student) {
      const now = Date.now();
      const elapsedSinceStart = Math.floor((now - db.juryStartTime) / 1000);
      broadcast({
        type: 'TIMER_TICK',
        activeStudentId: db.activeStudentId,
        elapsedSeconds: (student.durationSeconds || 0) + elapsedSinceStart
      });
    }
  }
}, 1000);

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    type: 'INIT_STATE',
    state: db,
    clientCount: wss.clients.size
  }));

  broadcast({
    type: 'CLIENT_COUNT',
    count: wss.clients.size
  });

  ws.on('message', (messageRaw) => {
    try {
      const action = JSON.parse(messageRaw);
      handleAction(action);
    } catch (e) {
      console.error('Mesaj parse hatası:', e);
    }
  });

  ws.on('close', () => {
    broadcast({
      type: 'CLIENT_COUNT',
      count: wss.clients.size
    });
  });
});

function handleAction(action) {
  const now = Date.now();
  const userName = (action.userName || 'Anonim').trim().substring(0, 25);

  switch (action.type) {
    case 'TOGGLE_CONSENSUS_MODE': {
      db.consensusMode = !db.consensusMode;
      db.consensusPending = null;
      if (consensusTimer) {
        clearTimeout(consensusTimer);
        consensusTimer = null;
      }
      saveDatabase();
      broadcast({
        type: 'STATE_UPDATED',
        state: db
      });
      break;
    }

    case 'POZISYON_CLICK': {
      const amount = Number(action.amount) || 1;
      const student = db.students.find(s => s.id === db.activeStudentId);
      if (!student) return;

      // ================= KONSENSÜS (2 KİŞİ ONAYI) MODU =================
      if (db.consensusMode && amount === 1) {
        if (!db.consensusPending) {
          // 1. KİŞİ BASTI -> Onay Bekleniyor
          db.consensusPending = {
            initiatedBy: userName,
            studentId: student.id,
            amount: 1,
            timestamp: now,
            expiresAt: now + 3500
          };

          if (consensusTimer) clearTimeout(consensusTimer);
          consensusTimer = setTimeout(() => {
            if (db.consensusPending) {
              const expiredUser = db.consensusPending.initiatedBy;
              db.consensusPending = null;
              broadcast({
                type: 'CONSENSUS_EXPIRED',
                initiatedBy: expiredUser
              });
            }
          }, 3500);

          broadcast({
            type: 'CONSENSUS_WAITING',
            initiatedBy: userName,
            studentName: student.name,
            expiresInMs: 3500
          });
          return;
        } else {
          // 1. Onay Zaten Var -> 2. Kişi Kontrolü
          // Aynı kişi ikinci kez basamaz (troll koruması)
          if (db.consensusPending.initiatedBy.toLowerCase() === userName.toLowerCase()) {
            return;
          }

          // 2. FARKLI KİŞİ ONAYLADI -> SAYI EKLENİR!
          if (consensusTimer) {
            clearTimeout(consensusTimer);
            consensusTimer = null;
          }

          const firstUser = db.consensusPending.initiatedBy;
          db.consensusPending = null;

          if (now - db.lastClickTimestamp < 3500) {
            db.comboStreak += 1;
          } else {
            db.comboStreak = 1;
          }
          db.lastClickTimestamp = now;

          student.count = Math.max(0, student.count + 1);
          db.totalPositionCount = Math.max(0, db.totalPositionCount + 1);

          const logItem = {
            id: 'log_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
            timestamp: now,
            by: `${firstUser} & ${userName}`,
            studentName: student.name,
            amount: 1,
            combo: db.comboStreak,
            totalNow: student.count,
            consensus: true
          };

          if (!student.history) student.history = [];
          student.history.unshift(logItem);
          if (student.history.length > 50) student.history.pop();

          if (!db.recentClicks) db.recentClicks = [];
          db.recentClicks.unshift(logItem);
          if (db.recentClicks.length > 25) db.recentClicks.pop();

          saveDatabase();

          broadcast({
            type: 'CONSENSUS_CONFIRMED',
            firstUser: firstUser,
            secondUser: userName,
            by: `${firstUser} & ${userName}`,
            amount: 1,
            combo: db.comboStreak,
            studentId: student.id,
            newStudentCount: student.count,
            totalPositionCount: db.totalPositionCount,
            logItem: logItem
          });
          return;
        }
      }

      // ================= KLASİK MOD VEYA +5 SERİ =================
      if (now - db.lastClickTimestamp < 3500) {
        db.comboStreak += 1;
      } else {
        db.comboStreak = 1;
      }
      db.lastClickTimestamp = now;

      student.count = Math.max(0, student.count + amount);
      db.totalPositionCount = Math.max(0, db.totalPositionCount + amount);

      const logItem = {
        id: 'log_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        timestamp: now,
        by: userName,
        studentName: student.name,
        amount: amount,
        combo: db.comboStreak,
        totalNow: student.count
      };

      if (!student.history) student.history = [];
      student.history.unshift(logItem);
      if (student.history.length > 50) student.history.pop();

      if (!db.recentClicks) db.recentClicks = [];
      db.recentClicks.unshift(logItem);
      if (db.recentClicks.length > 25) db.recentClicks.pop();

      saveDatabase();

      broadcast({
        type: 'POZISYON_TRIGGERED',
        by: userName,
        amount: amount,
        combo: db.comboStreak,
        studentId: student.id,
        newStudentCount: student.count,
        totalPositionCount: db.totalPositionCount,
        logItem: logItem
      });
      break;
    }

    case 'UNDO_CLICK': {
      const student = db.students.find(s => s.id === db.activeStudentId);
      if (!student || student.count <= 0) return;

      student.count -= 1;
      db.totalPositionCount = Math.max(0, db.totalPositionCount - 1);
      db.comboStreak = 0;
      db.consensusPending = null;

      const logItem = {
        id: 'log_' + Date.now(),
        timestamp: now,
        by: userName,
        studentName: student.name,
        amount: -1,
        combo: 0,
        totalNow: student.count,
        isUndo: true
      };

      if (!student.history) student.history = [];
      student.history.unshift(logItem);

      if (!db.recentClicks) db.recentClicks = [];
      db.recentClicks.unshift(logItem);

      saveDatabase();

      broadcast({
        type: 'UNDO_TRIGGERED',
        by: userName,
        studentId: student.id,
        newStudentCount: student.count,
        totalPositionCount: db.totalPositionCount,
        logItem: logItem
      });
      break;
    }

    case 'SET_ACTIVE_STUDENT': {
      const targetId = action.studentId;
      const targetStudent = db.students.find(s => s.id === targetId);
      if (!targetStudent) return;

      // Önceki öğrenci için tahminleri sonuçlandır
      if (db.activeStudentId && db.activeStudentId !== targetId) {
        const prevStudent = db.students.find(s => s.id === db.activeStudentId);
        if (prevStudent) {
          if (db.juryRunning && db.juryStartTime) {
            const sessionSec = Math.floor((now - db.juryStartTime) / 1000);
            prevStudent.durationSeconds = (prevStudent.durationSeconds || 0) + sessionSec;
          }
          if (prevStudent.count > 0 || (prevStudent.predictions && prevStudent.predictions.length > 0)) {
            resolveOracle(prevStudent);
          }
        }
      }

      db.students.forEach(s => {
        if (s.id === targetId) {
          s.status = 'active';
        } else if (s.status === 'active') {
          s.status = s.count > 0 ? 'completed' : 'pending';
        }
      });

      db.activeStudentId = targetId;
      if (db.juryRunning) {
        db.juryStartTime = now;
      }
      db.comboStreak = 0;
      db.consensusPending = null;

      saveDatabase();

      broadcast({
        type: 'STATE_UPDATED',
        state: db
      });
      break;
    }

    case 'TOGGLE_JURY_TIMER': {
      const student = db.students.find(s => s.id === db.activeStudentId);

      if (db.juryRunning) {
        if (student && db.juryStartTime) {
          const sessionSec = Math.floor((now - db.juryStartTime) / 1000);
          student.durationSeconds = (student.durationSeconds || 0) + sessionSec;
          student.status = 'completed';
        }
        db.juryRunning = false;
        db.juryStartTime = null;

        // Jüri bitti: Günün Kahini Sonucunu İlan Et!
        if (student) {
          resolveOracle(student);
        }
      } else {
        db.juryRunning = true;
        db.juryStartTime = now;
        if (student) {
          student.status = 'active';
        }
      }
      saveDatabase();

      broadcast({
        type: 'TIMER_STATE_CHANGED',
        juryRunning: db.juryRunning,
        activeStudentId: db.activeStudentId,
        state: db
      });
      break;
    }

    case 'ADD_GLOBAL_PREDICTION': {
      const guess = Number(action.guess);
      if (isNaN(guess) || guess <= 0) return;

      if (!db.globalPredictions) db.globalPredictions = [];
      const existing = db.globalPredictions.find(p => p.user.toLowerCase() === userName.toLowerCase());
      if (existing) {
        existing.guess = guess;
        existing.timestamp = now;
      } else {
        db.globalPredictions.push({
          user: userName,
          guess: guess,
          timestamp: now
        });
      }

      saveDatabase();
      broadcast({ type: 'STATE_UPDATED', state: db });
      break;
    }

    case 'ADD_PREDICTION': {
      const { studentId, guess } = action;
      const student = db.students.find(s => s.id === studentId);
      if (!student) return;

      if (!student.predictions) student.predictions = [];
      const existing = student.predictions.find(p => p.user.toLowerCase() === userName.toLowerCase());
      if (existing) {
        existing.guess = Number(guess);
      } else {
        student.predictions.push({
          user: userName,
          guess: Number(guess),
          timestamp: now
        });
      }

      saveDatabase();
      broadcast({ type: 'STATE_UPDATED', state: db });
      break;
    }

    case 'UPDATE_STUDENTS_LIST': {
      if (Array.isArray(action.students)) {
        db.students = action.students;
        if (!db.students.find(s => s.id === db.activeStudentId) && db.students.length > 0) {
          db.activeStudentId = db.students[0].id;
        }
        db.totalPositionCount = db.students.reduce((acc, s) => acc + (s.count || 0), 0);
        saveDatabase();
        broadcast({ type: 'STATE_UPDATED', state: db });
      }
      break;
    }

    case 'RESTORE_BACKUP': {
      if (Array.isArray(action.students) && action.students.length > 0) {
        db.students = action.students;
        if (action.totalPositionCount !== undefined) {
          db.totalPositionCount = Number(action.totalPositionCount) || 0;
        } else {
          db.totalPositionCount = db.students.reduce((acc, s) => acc + (s.count || 0), 0);
        }
        if (Array.isArray(action.globalPredictions)) {
          db.globalPredictions = action.globalPredictions;
        }
        if (!db.students.find(s => s.id === db.activeStudentId) && db.students.length > 0) {
          db.activeStudentId = db.students[0].id;
        }
        saveDatabase();
        broadcast({ type: 'STATE_UPDATED', state: db });
      }
      break;
    }

    case 'RESET_ALL': {
      if (action.pin !== '1816') return;
      db.students.forEach(s => {
        s.count = 0;
        s.durationSeconds = 0;
        s.status = 'pending';
        s.predictions = [];
        s.history = [];
      });
      if (db.students.length > 0) {
        db.students[0].status = 'active';
        db.activeStudentId = db.students[0].id;
      }
      db.totalPositionCount = 0;
      db.comboStreak = 0;
      db.juryRunning = false;
      db.juryStartTime = null;
      db.recentClicks = [];
      db.consensusPending = null;
      db.lastOracle = null;
      db.oracleLeaderboard = {};
      db.globalPredictions = [];

      saveDatabase();
      broadcast({ type: 'STATE_UPDATED', state: db });
      break;
    }
  }
}

// REST Endpoints
app.get('/api/state', (req, res) => {
  res.json(db);
});

app.get('/api/network-info', async (req, res) => {
  const ip = getLocalIp();
  const url = `http://${ip}:${PORT}`;
  try {
    const qrDataUrl = await QRCode.toDataURL(url, {
      margin: 1,
      width: 260,
      color: {
        dark: '#111111',
        light: '#F4F4F4'
      }
    });
    res.json({
      localIp: ip,
      port: PORT,
      url: url,
      qrDataUrl: qrDataUrl
    });
  } catch (err) {
    res.status(500).json({ error: 'QR kod hatasi' });
  }
});

// CSV / Rapor İndir
app.get('/api/export/csv', (req, res) => {
  let csv = 'Sira,Ogrenci Adi,Pozisyon Sayisi,Juri Suresi,PPM (Dakika Basi),Durum\n';
  db.students.forEach((s, idx) => {
    const totalSec = s.durationSeconds || 0;
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    const timeFormatted = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
    const ppm = totalSec > 0 ? (s.count / (totalSec / 60)).toFixed(2) : '0.00';
    const statusText = s.status === 'completed' ? 'Tamamlandi' : s.status === 'active' ? 'Juride' : 'Bekliyor';
    csv += `${idx + 1},"${s.name.replace(/"/g, '""')}",${s.count},${timeFormatted},${ppm},${statusText}\n`;
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="pozisyon_rapor.csv"');
  res.send('\uFEFF' + csv);
});

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIp();
  console.log(`\n======================================================`);
  console.log(`[BRAVEPRINT STYLE] POZISYON SAYACI VE JURI ARENASI`);
  console.log(`Bilgisayar: http://localhost:${PORT}`);
  console.log(`Mobil / Ag: http://${ip}:${PORT}`);
  console.log(`======================================================\n`);
});
