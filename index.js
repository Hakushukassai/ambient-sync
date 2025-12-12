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

// ★オート演奏の状態
let autoPlayState = {
    active: false,
    speed: 30, 
};
let autoPlayTimeout = null; // IntervalからTimeoutに変更

// ★ランダムループ処理
function scheduleNextAutoNote() {
    // 前の予約があれば消す
    if (autoPlayTimeout) clearTimeout(autoPlayTimeout);
    
    // オフなら終了
    if (!autoPlayState.active) return;

    // 1. 音を鳴らす
    playAutoNote();

    // 2. 次の時間を計算する（ランダム性を持たせる）
    
    // ベースの間隔: 8000ms(遅) 〜 150ms(速)
    const slowLimit = 8000;
    const fastLimit = 150;
    const baseInterval = slowLimit - ((autoPlayState.speed / 100) * (slowLimit - fastLimit));
    
    // ★ゆらぎ係数: 0.2倍(速い連打) 〜 1.8倍(溜め) の間でランダム
    const randomFactor = 0.2 + (Math.random() * 1.6); 
    
    const nextDelay = baseInterval * randomFactor;

    // 次の予約を入れる
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
    console.log('User connected:', socket.id);

    socket.emit('sync_waveform', currentWaveform);
    socket.emit('sync_adsr', currentADSR);
    socket.emit('sync_mixer', currentMixer);
    socket.emit('sync_eq', currentEQ); 
    socket.emit('sync_scale', currentScaleName);
    socket.emit('sync_auto', autoPlayState);

    socket.on('play_note', (data) => {
        io.emit('trigger_note', { ...data, id: socket.id });
    });

    socket.on('update_waveform', (data) => {
        if (Array.isArray(data)) {
            currentWaveform = data;
            socket.broadcast.emit('sync_waveform', currentWaveform);
        }
    });

    socket.on('update_adsr', (data) => {
        if (data) {
            currentADSR = data;
            socket.broadcast.emit('sync_adsr', currentADSR);
        }
    });

    socket.on('update_mixer', (data) => {
        if (data) {
            currentMixer = data;
            socket.broadcast.emit('sync_mixer', currentMixer);
        }
    });

    socket.on('update_eq', (data) => {
        if (data) {
            currentEQ = data;
            socket.broadcast.emit('sync_eq', currentEQ);
        }
    });

    socket.on('update_scale', (scaleName) => {
        currentScaleName = scaleName;
        io.emit('sync_scale', currentScaleName);
    });

    // オート演奏の制御
    socket.on('update_auto', (data) => {
        const wasActive = autoPlayState.active;
        autoPlayState = data;
        io.emit('sync_auto', autoPlayState);
        
        // OFF -> ON になった時、または ONのまま更新された時
        if (autoPlayState.active && !wasActive) {
            scheduleNextAutoNote();
        } else if (!autoPlayState.active) {
            if (autoPlayTimeout) clearTimeout(autoPlayTimeout);
        }
        // ON -> ON (スライダー操作中) は、今のタイマーを維持して次のループから新速度適用
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
