const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { origin: "*" }
});
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

// --- サーバー側の状態管理 (初期値) ---
// ※ここが「正」となるデータです
let globalState = {
    waveform: new Array(128).fill(0).map((_, i) => Math.sin((i / 128) * Math.PI * 2)),
    eq: {
        low:  { freq: 100,  gain: 0 },
        mid:  { freq: 1000, gain: 0 },
        high: { freq: 5000, gain: 0 }
    },
    mixer: { synth: -4 },
    adsr: { attack: 0.05, decay: 0.2, sustain: 0.5, release: 1.0 },
    scale: "MINOR_PENTATONIC",
    auto: { active: false, speed: 30 },
    // パラメータ (0.0-1.0)
    params: {
        'FILTER': 0.5, 'PAN': 0.5, 'VOL': 0.8, 'REVERB': 0.0,
        'ATTACK': 0.05, 'DECAY': 0.2, 'SUSTAIN': 0.5, 'RELEASE': 0.3
    }
};

let connectedUsers = {};
let autoPlayTimeout = null;

// スケール定義
const NOTE_NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const SCALE_DEFINITIONS = {
    "MINOR_PENTATONIC": [0, 3, 5, 7, 10], "MAJOR": [0, 2, 4, 5, 7, 9, 11],
    "MINOR": [0, 2, 3, 5, 7, 8, 10], "DORIAN": [0, 2, 3, 5, 7, 9, 10],
    "LYDIAN": [0, 2, 4, 6, 7, 9, 11], "RYUKYU": [0, 4, 5, 7, 11],
    "MIYAKOBUSHI": [0, 1, 5, 7, 8], "WHOLE_TONE": [0, 2, 4, 6, 8, 10]
};
const SCALES = {};
for (const [name, intervals] of Object.entries(SCALE_DEFINITIONS)) {
    const notes = [];
    for (let oct = 2; oct <= 7; oct++) {
        for (let i = 0; i < 12; i++) {
            if (intervals.includes(i)) {
                if (oct === 7 && i > 0) break;
                notes.push(NOTE_NAMES[i] + oct);
            }
        }
    }
    SCALES[name] = notes;
}

// ユーザーカラー生成
function getRandomColor() {
    const letters = '0123456789ABCDEF';
    let color = '#';
    for (let i = 0; i < 6; i++) { color += letters[Math.floor(Math.random() * 16)]; }
    return color;
}

// オートプレイロジック
function scheduleNextAutoNote() {
    if (autoPlayTimeout) clearTimeout(autoPlayTimeout);
    if (!globalState.auto.active) return;

    const slowLimit = 5000; const fastLimit = 100;
    const baseInterval = slowLimit - ((globalState.auto.speed / 100) * (slowLimit - fastLimit));
    const randomFactor = 0.5 + Math.random(); 
    
    // 音を鳴らす
    const scaleNotes = SCALES[globalState.scale] || SCALES["MINOR_PENTATONIC"];
    const normX = Math.random(); const normY = Math.random();
    const noteIndex = Math.floor((1 - normY) * scaleNotes.length);
    const note = scaleNotes[Math.min(noteIndex, scaleNotes.length - 1)] || "C4";

    io.emit('trigger_note', { 
        note: note, duration: 0.5 + normX * 2.0, normX: normX, normY: normY, id: 'auto' 
    });

    autoPlayTimeout = setTimeout(scheduleNextAutoNote, Math.max(100, baseInterval * randomFactor));
}

io.on('connection', (socket) => {
    const userColor = getRandomColor();
    connectedUsers[socket.id] = { color: userColor };
    console.log(`User connected: ${socket.id}`);

    // ① 接続時に現状の全データを送る
    socket.emit('init_state', {
        id: socket.id,
        color: userColor,
        state: globalState,
        users: connectedUsers
    });

    // ② 全員にユーザー更新を通知
    io.emit('update_users', connectedUsers);

    // --- イベントハンドラ ---

    socket.on('play_note', (data) => {
        // そのまま全員に転送（サーバー負荷軽減のため計算しない）
        socket.broadcast.emit('trigger_note', { ...data, id: socket.id });
    });

    socket.on('update_waveform', (data) => {
        globalState.waveform = data;
        socket.broadcast.emit('sync_state_part', { key: 'waveform', value: data, userId: socket.id });
    });

    socket.on('update_eq', (data) => {
        globalState.eq = data;
        socket.broadcast.emit('sync_state_part', { key: 'eq', value: data, userId: socket.id });
    });

    socket.on('update_mixer', (data) => {
        globalState.mixer = data;
        socket.broadcast.emit('sync_state_part', { key: 'mixer', value: data, userId: socket.id });
    });

    socket.on('update_adsr', (data) => {
        globalState.adsr = data;
        socket.broadcast.emit('sync_state_part', { key: 'adsr', value: data, userId: socket.id });
    });

    socket.on('update_scale', (scaleName) => {
        globalState.scale = scaleName;
        io.emit('sync_state_part', { key: 'scale', value: scaleName, userId: socket.id });
    });

    socket.on('update_auto', (data) => {
        const wasActive = globalState.auto.active;
        globalState.auto = data;
        io.emit('sync_state_part', { key: 'auto', value: data, userId: socket.id });
        
        if (globalState.auto.active && !wasActive) scheduleNextAutoNote();
        else if (!globalState.auto.active && autoPlayTimeout) clearTimeout(autoPlayTimeout);
    });

    socket.on('update_param', (data) => {
        // target: 'FILTER', value: 0.5
        if (data && data.target) {
            globalState.params[data.target] = data.value;
            socket.broadcast.emit('sync_param', { target: data.target, value: data.value, userId: socket.id });
        }
    });

    socket.on('disconnect', () => {
        delete connectedUsers[socket.id];
        io.emit('update_users', connectedUsers);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
