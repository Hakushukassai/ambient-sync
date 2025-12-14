const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

// --- 音楽理論データ ---
const NOTE_NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const SCALE_DEFINITIONS = {
    "MYSTERIOUS":       [0, 2, 3, 6, 7, 8, 11],
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

let autoNoteState = { active: false, speed: 30 };
let autoDriftState = { active: false }; 

let autoNoteTimeout = null;
let autoDriftInterval = null;

let globalParams = {
    'FILTER': 0.5,
    'PAN': 0.5,
    'VOL': 0.8,
    'REVERB': 0.0,
    'DELAY_FB': 0.3,
    'DELAY_MIX': 0.0,
    'DECAY': 0.1,
    'RELEASE': 0.3,
    'FREQ': 0.3
};

// --- 自動演奏ロジック (音符) ---
function scheduleNextAutoNote() {
    if (autoNoteTimeout) clearTimeout(autoNoteTimeout);
    if (!autoNoteState.active) return;
    
    playAutoNote();
    
    const slowLimit = 8000;
    const fastLimit = 150;
    const baseInterval = slowLimit - ((autoNoteState.speed / 100) * (slowLimit - fastLimit));
    const randomFactor = 0.2 + (Math.random() * 1.6); 
    const nextDelay = baseInterval * randomFactor;
    
    autoNoteTimeout = setTimeout(scheduleNextAutoNote, nextDelay);
}

function playAutoNote() {
    const normX = Math.random();
    const normY = Math.random();
    const scaleNotes = SCALES[currentScaleName] || SCALES["MYSTERIOUS"];
    
    if (!scaleNotes) return;

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

// --- 自動操作ロジック (GHOST) ---
// ★変更: 滑らかな大波を作る
function startAutoParamDrift() {
    if (autoDriftInterval) clearInterval(autoDriftInterval);
    
    let time = 0;
    
    // 100msごとに更新 (クライアント側で補間するのでカクつかない)
    autoDriftInterval = setInterval(() => {
        time += 0.1;
        
        // 1. FILTER: サイン波を使って 0.0〜1.0 の間を大きく往復させる
        // Math.sin(time) は -1〜1 なので、加工して 0〜1 にする
        // 少しランダム要素も足して「機械的すぎない」ようにする
        const sineWave = (Math.sin(time * 0.5) + 1) / 2; // 0.0 ~ 1.0 のゆっくりな波
        const noise = (Math.random() - 0.5) * 0.2;       // 少しのゆらぎ
        let filterVal = sineWave + noise;
        globalParams['FILTER'] = Math.max(0, Math.min(1, filterVal));

        // 2. その他のパラメータ: ランダムウォーク
        const keys = ['PAN', 'REVERB', 'DELAY_FB', 'DELAY_MIX', 'DECAY', 'RELEASE'];
        // ランダムに1つ選んで少し動かす
        const key = keys[Math.floor(Math.random() * keys.length)];
        let val = globalParams[key];
        const drift = (Math.random() - 0.5) * 0.1; 
        val += drift;
        globalParams[key] = Math.max(0, Math.min(1, val));
        
        // 全パラメータを一括送信（帯域節約のため間引いて送る形に近い）
        io.emit('sync_all_params', globalParams);
        
    }, 100);
}

function stopAutoParamDrift() {
    if (autoDriftInterval) clearInterval(autoDriftInterval);
    autoDriftInterval = null;
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.emit('sync_waveform', currentWaveform);
    socket.emit('sync_adsr', currentADSR);
    socket.emit('sync_mixer', currentMixer);
    socket.emit('sync_eq', currentEQ); 
    socket.emit('sync_scale', currentScaleName);
    
    socket.emit('sync_auto_note', autoNoteState);
    socket.emit('sync_auto_drift', autoDriftState);
    
    socket.emit('sync_all_params', globalParams);

    socket.on('play_note', (data) => {
        io.emit('trigger_note', { ...data, id: socket.id });
    });

    socket.on('spawn_ball', (data) => {
        io.emit('spawn_ball', { ...data, id: socket.id });
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
        if (SCALE_DEFINITIONS[scaleName]) {
            currentScaleName = scaleName;
            io.emit('sync_scale', currentScaleName);
        }
    });

    socket.on('update_auto_note', (data) => {
        const wasActive = autoNoteState.active;
        autoNoteState = data;
        io.emit('sync_auto_note', autoNoteState);
        
        if (autoNoteState.active && !wasActive) {
            scheduleNextAutoNote();
        } else if (!autoNoteState.active) {
            if (autoNoteTimeout) clearTimeout(autoNoteTimeout);
        }
    });

    socket.on('update_auto_drift', (data) => {
        const wasActive = autoDriftState.active;
        autoDriftState = data;
        io.emit('sync_auto_drift', autoDriftState);

        if (autoDriftState.active && !wasActive) {
            startAutoParamDrift();
        } else if (!autoDriftState.active) {
            stopAutoParamDrift();
        }
    });

    socket.on('update_param', (data) => {
        if (data && data.target && typeof data.value === 'number') {
            globalParams[data.target] = data.value;
            socket.broadcast.emit('sync_param', data);
            if (data.target === 'FREQ') {
                autoNoteState.speed = Math.floor(data.value * 100);
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
