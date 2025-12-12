const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

// --- 音楽理論データ (サーバー側でも計算するため) ---
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
// ★修正: Droneを削除し、AutoPlayの音量はSynthと同じ扱いにする
let currentMixer = { synth: -4 };

let currentEQ = {
    low:  { freq: 100,  gain: 4 },
    mid:  { freq: 1000, gain: -2 },
    high: { freq: 5000, gain: -6 }
};

let currentScaleName = "MYSTERIOUS";

// ★新機能: オート演奏の状態
let autoPlayState = {
    active: false,
    speed: 50, // 0-100
};
let autoPlayInterval = null;

// オート演奏のループ処理
function startAutoLoop() {
    if (autoPlayInterval) clearInterval(autoPlayInterval);
    if (!autoPlayState.active) return;

    // スピード(0-100)を間隔(ms)に変換: 0=2000ms(遅い) ~ 100=100ms(速い)
    const intervalMs = 2000 - (autoPlayState.speed * 19); 
    
    autoPlayInterval = setInterval(() => {
        // 1. ランダムな位置を決める
        const normX = Math.random();
        const normY = Math.random();

        // 2. 音程を決定する (サーバー側で計算)
        const scaleNotes = SCALES[currentScaleName] || SCALES["MINOR_PENTATONIC"];
        const noteIndex = Math.floor((1 - normY) * scaleNotes.length);
        const note = scaleNotes[Math.min(noteIndex, scaleNotes.length - 1)];
        
        // 3. 全員に「弾け！」と命令する (IDは 'auto' とする)
        io.emit('trigger_note', { 
            note: note, 
            duration: 0.5 + normX * 4.0, 
            normX: normX, 
            normY: normY,
            id: 'auto' // 特別なID
        });

    }, Math.max(50, intervalMs));
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // 初期データの同期
    socket.emit('sync_waveform', currentWaveform);
    socket.emit('sync_adsr', currentADSR);
    socket.emit('sync_mixer', currentMixer);
    socket.emit('sync_eq', currentEQ); 
    socket.emit('sync_scale', currentScaleName);
    socket.emit('sync_auto', autoPlayState); // ★オート状態も同期

    // 手動演奏イベント
    socket.on('play_note', (data) => {
        io.emit('trigger_note', { ...data, id: socket.id });
    });

    // パラメータ更新系
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

    // ★オート演奏の制御を受け取る
    socket.on('update_auto', (data) => {
        autoPlayState = data;
        // 全員の状態を更新
        io.emit('sync_auto', autoPlayState);
        // ループを再設定
        startAutoLoop();
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
