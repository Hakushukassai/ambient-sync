const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

// --- サーバー側の状態管理 ---

const WAVE_SIZE = 128;
let currentWaveform = new Array(WAVE_SIZE).fill(0).map((_, i) => 
    Math.sin((i / WAVE_SIZE) * Math.PI * 2)
);

let currentADSR = { attack: 0.1, decay: 0.2, sustain: 0.5, release: 1.5 };

// ★修正: Synthの音量を少し上げ、Droneもしっかり出す
let currentMixer = { synth: -4, drone: -6 };

// ★修正: 初期EQで「低音強め・高音控えめ」にしてバランスを整える
let currentEQ = {
    low:  { freq: 100,  gain: 4 },   // 低音をブースト
    mid:  { freq: 1000, gain: -2 },  // 中域を少しスッキリさせる
    high: { freq: 5000, gain: -6 }   // 耳に痛い高音を抑える
};

let currentScaleName = "MYSTERIOUS";

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.emit('sync_waveform', currentWaveform);
    socket.emit('sync_adsr', currentADSR);
    socket.emit('sync_mixer', currentMixer);
    socket.emit('sync_eq', currentEQ); 
    socket.emit('sync_scale', currentScaleName);

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

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
