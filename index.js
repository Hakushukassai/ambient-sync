const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

// --- 音楽理論データ ---
const NOTE_NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const SCALE_DEFINITIONS = {
    "MINOR_PENTATONIC": [0, 3, 5, 7, 10], 
    "MAJOR":            [0, 2, 4, 5, 7, 9, 11],
    "MINOR":            [0, 2, 3, 5, 7, 8, 10],
    "DORIAN":           [0, 2, 3, 5, 7, 9, 10],
    "LYDIAN":           [0, 2, 4, 6, 7, 9, 11],
    "RYUKYU":           [0, 4, 5, 7, 11],
    "MIYAKOBUSHI":      [0, 1, 5, 7, 8],
    "WHOLE_TONE":       [0, 2, 4, 6, 8, 10]
};

function generateScale(intervals) {
    const notes = [];
    for (let oct = 2; oct <= 7; oct++) {
        for (let i = 0; i < 12; i++) {
            if (intervals.includes(i)) {
                if (oct === 7 && i > 0) break;
                notes.push(NOTE_NAMES[i] + oct);
            }
        }
    }
    return notes;
}

const SCALES = {};
for (const [name, intervals] of Object.entries(SCALE_DEFINITIONS)) {
    SCALES[name] = generateScale(intervals);
}

// --- サーバー側の状態管理 ---
const WAVE_SIZE = 128;
let currentWaveform = new Array(WAVE_SIZE).fill(0).map((_, i) => 
    Math.sin((i / WAVE_SIZE) * Math.PI * 2)
);

let currentADSR = { attack: 0.1, decay: 0.2, sustain: 0.5, release: 1.5 };
let currentMixer = { synth: -4 };
let currentEQ = {
    low:  { freq: 100,  gain: 4 },
    mid:  { freq: 1000, gain: -2 },
    high: { freq: 5000, gain: -6 }
};
let currentScaleName = "MYSTERIOUS";
let autoPlayState = { active: false, speed: 30 };
let autoPlayTimeout = null;

let globalParams = {
    'FILTER': 0.5,
    'PAN': 0.5,
    'VOL': 0.8,
    'REVERB': 0.0,
    'ATTACK': 0.05, // ADSR A
    'DECAY': 0.1,   // ADSR D
    'SUSTAIN': 0.5, // ADSR S
    'RELEASE': 0.3  // ADSR R
};

// ★ユーザー管理
let connectedUsers = {};

// ランダムカラー生成
function getRandomColor() {
    const letters = '0123456789ABCDEF';
    let color = '#';
    for (let i = 0; i < 6; i++) {
        color += letters[Math.floor(Math.random() * 16)];
    }
    return color;
}

function scheduleNextAutoNote() {
    if (autoPlayTimeout) clearTimeout(autoPlayTimeout);
    if (!autoPlayState.active) return;
    playAutoNote();
    const slowLimit = 8000;
    const fastLimit = 150;
    const baseInterval = slowLimit - ((autoPlayState.speed / 100) * (slowLimit - fastLimit));
    const randomFactor = 0.2 + (Math.random() * 1.6); 
    const nextDelay = baseInterval * randomFactor;
    autoPlayTimeout = setTimeout(scheduleNextAutoNote, nextDelay);
}

function playAutoNote() {
    const normX = Math.random();
    const normY = Math.random();
    const scaleNotes = SCALES[currentScaleName] || SCALES["MINOR_PENTATONIC"];
    const noteIndex = Math.floor((1 - normY) * scaleNotes.length);
    const note = scaleNotes[Math.min(noteIndex, scaleNotes.length - 1)];
    
    io.emit('trigger_note', { 
        note: note, 
        duration: 0.5 + normX * 4.0, 
        normX: normX, 
        normY: normY,
        id: 'auto'
    });
}

io.on('connection', (socket) => {
    // ★ユーザー登録と色割り当て
    const userColor = getRandomColor();
    connectedUsers[socket.id] = { color: userColor };
    
    console.log('User connected:', socket.id, userColor);

    // 全員に現在のユーザー数と情報を送る
    io.emit('update_users', { count: Object.keys(connectedUsers).length, users: connectedUsers });

    // 初期データ送信
    socket.emit('init_setup', {
        id: socket.id, // 自分のIDを教える
        color: userColor, // 自分の色を教える
        waveform: currentWaveform,
        adsr: currentADSR,
        mixer: currentMixer,
        eq: currentEQ,
        scale: currentScaleName,
        auto: autoPlayState,
        params: globalParams
    });

    socket.on('play_note', (data) => {
        io.emit('trigger_note', { ...data, id: socket.id });
    });

    socket.on('update_waveform', (data) => {
        if (Array.isArray(data)) {
            currentWaveform = data;
            socket.broadcast.emit('sync_waveform', { data: currentWaveform, userId: socket.id });
        }
    });

    socket.on('update_adsr', (data) => {
        if (data) {
            currentADSR = data;
            socket.broadcast.emit('sync_adsr', { data: currentADSR, userId: socket.id });
        }
    });

    socket.on('update_mixer', (data) => {
        if (data) {
            currentMixer = data;
            socket.broadcast.emit('sync_mixer', { data: currentMixer, userId: socket.id });
        }
    });

    socket.on('update_eq', (data) => {
        if (data) {
            currentEQ = data;
            socket.broadcast.emit('sync_eq', { data: currentEQ, userId: socket.id });
        }
    });

    socket.on('update_scale', (scaleName) => {
        currentScaleName = scaleName;
        io.emit('sync_scale', { scale: currentScaleName, userId: socket.id });
    });

    socket.on('update_auto', (data) => {
        const wasActive = autoPlayState.active;
        autoPlayState = data;
        io.emit('sync_auto', { data: autoPlayState, userId: socket.id });
        if (autoPlayState.active && !wasActive) {
            scheduleNextAutoNote();
        } else if (!autoPlayState.active) {
            if (autoPlayTimeout) clearTimeout(autoPlayTimeout);
        }
    });

    // ★パラメータ更新: 誰が更新したか(userId)を付与して送信
    socket.on('update_param', (data) => {
        if (data && data.target && typeof data.value === 'number') {
            globalParams[data.target] = data.value;
            socket.broadcast.emit('sync_param', { 
                target: data.target, 
                value: data.value, 
                userId: socket.id 
            });
        }
    });

    socket.on('disconnect', () => {
        delete connectedUsers[socket.id];
        io.emit('update_users', { count: Object.keys(connectedUsers).length, users: connectedUsers });
        console.log('User disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
