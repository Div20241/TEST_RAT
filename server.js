const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({
    server,
    perMessageDeflate: false,
    maxPayload: 50 * 1024 * 1024,
    skipUTF8Validation: true
});

const PORT = process.env.PORT || 3000;

// Serve standard static files
app.use(express.static(path.join(__dirname, 'public')));

const agents = new Map(); // Agent ID -> { ws, password, viewers: Set }
const viewers = new Map(); // Viewer WS -> Agent ID
const viewerStats = new Map(); // Viewer WS -> counters

function bumpTypeCounter(mapObj, key, inc = 1) {
    mapObj[key] = (mapObj[key] || 0) + inc;
}

function sanitizePreview(obj) {
    try {
        const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
        return s.length > 180 ? `${s.slice(0, 180)}...` : s;
    } catch {
        return '[unserializable]';
    }
}

function pushTrace(vs, direction, packetType, preview) {
    if (!vs || !vs.traceEnabled) return;
    vs.traceRows.push({
        ts: Date.now(),
        dir: direction,
        type: packetType,
        preview
    });
    if (vs.traceRows.length > 80) {
        vs.traceRows.splice(0, vs.traceRows.length - 80);
    }
}

function safeSendJSON(ws, payload) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    try {
        ws.send(JSON.stringify(payload));
        return true;
    } catch {
        return false;
    }
}

function normalizeStreamMode(rawMode) {
    const m0 = String(rawMode || 'performance').trim().toLowerCase();
    const aliases = {
        perf: 'performance',
        turbo: 'performance',
        fast: 'performance',
        balanced: 'performance',
        ultra_turbo: 'ultra',
        hd: 'quality',
        native: 'auto_native',
        auto: 'auto_native'
    };
    const m = aliases[m0] || m0;
    return ['performance', 'ultra', 'quality', 'auto_native'].includes(m) ? m : 'performance';
}

function normalizeStreamPreset(rawPreset) {
    const p = String(rawPreset || 'balanced').trim().toLowerCase();
    return ['fluid', 'balanced', 'quality'].includes(p) ? p : 'balanced';
}

wss.on('connection', (ws) => {
    console.log('New WebSocket connection.');
    let connectionInfo = { role: null, id: null };
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    try {
        ws._socket?.setNoDelay(true);
        ws._socket?.setKeepAlive(true, 10000);
    } catch {}

    ws.on('message', (message, isBinary) => {
        if (isBinary) {
            if (connectionInfo.role === 'agent') {
                const agent = agents.get(connectionInfo.id);
                if (!agent || !agent.viewers || agent.viewers.size === 0) return;
                if (agent && agent.viewers) {
                    agent.viewers.forEach(vws => {
                        if (vws.readyState === WebSocket.OPEN) {
                            // Avoid viewer-side frame backlog: skip when socket queue is already too large.
                            if (vws.bufferedAmount > 512 * 1024) {
                                const vs = viewerStats.get(vws);
                                if (vs) vs.droppedFrames += 1;
                                vws.slowFrames = (vws.slowFrames || 0) + 1;
                                // Persistently slow clients are dropped to protect realtime stream.
                                if (vws.slowFrames > 40) {
                                    try { vws.terminate(); } catch {}
                                }
                                return;
                            }
                            vws.slowFrames = 0;
                            const vs = viewerStats.get(vws);
                            if (vs) {
                                vs.txFrames += 1;
                                vs.txBytes += message.length || message.byteLength || 0;
                                bumpTypeCounter(vs.packetTypes, 'down_video_frame');
                                pushTrace(vs, 'down', 'down_video_frame', `bytes=${message.length || message.byteLength || 0}`);
                            }
                            vws.send(message, { binary: true, compress: false });
                        }
                    });
                }
            }
            return;
        }

        try {
            const data = JSON.parse(message);

            if (data.type === 'register') {
                if (data.role === 'agent') {
                    const oldAgent = agents.get(data.id);
                    if (oldAgent && oldAgent.ws !== ws) {
                        try { oldAgent.ws.close(); } catch {}
                    }
                    connectionInfo.role = 'agent';
                    connectionInfo.id = data.id;
                    agents.set(data.id, { 
                        ws: ws, 
                        password: data.password, 
                        width: data.width, 
                        height: data.height,
                        viewers: new Set() 
                    });
                    console.log(`Agent registered: ${data.id}`);
                    safeSendJSON(ws, { type: 'registered', status: 'success' });
                } else if (data.role === 'viewer') {
                    const agent = agents.get(data.targetId);
                    if (agent && agent.password === data.password) {
                        connectionInfo.role = 'viewer';
                        connectionInfo.targetId = data.targetId;
                        viewers.set(ws, data.targetId);
                        agent.viewers.add(ws);
                        viewerStats.set(ws, {
                            txFrames: 0,
                            txBytes: 0,
                            droppedFrames: 0,
                            lastTxFrames: 0,
                            lastTxBytes: 0,
                            lastDroppedFrames: 0,
                            uplinkJson: 0,
                            downlinkJson: 0,
                            lastUplinkJson: 0,
                            lastDownlinkJson: 0,
                            packetTypes: {},
                            lastPacketTypes: {},
                            traceEnabled: false,
                            traceRows: [],
                            traceBaseline: null
                        });
                        console.log(`Viewer added to agent: ${data.targetId}`);
                        safeSendJSON(ws, { 
                            type: 'registered', 
                            status: 'success', 
                            width: agent.width, 
                            height: agent.height 
                        });
                    } else {
                        safeSendJSON(ws, { type: 'error', message: 'Auth failed' });
                    }
                }
            } else {
                // Forward viewer -> agent (mouse/keyboard/files/clipboard)
                if (connectionInfo.role === 'viewer') {
                    const agent = agents.get(connectionInfo.targetId);
                    if (agent && agent.ws.readyState === WebSocket.OPEN) {
                        if (data.type === 'set_trace_mode') {
                            const vs = viewerStats.get(ws);
                            if (vs) {
                                vs.traceEnabled = !!data.enabled;
                                vs.traceRows = [];
                                vs.traceBaseline = null;
                            }
                            return;
                        }
                        if (data.type === 'start_stream') {
                            data.mode = normalizeStreamMode(data.mode);
                            data.stream_preset = normalizeStreamPreset(data.stream_preset);
                            data.quality = Math.max(10, Math.min(95, Number(data.quality || 40)));
                            data.adaptive_target_kb = Math.max(6, Math.min(120, Number(data.adaptive_target_kb || 20)));
                            data.manual_scale = Math.max(0.26, Math.min(1.0, Number(data.manual_scale || 1.0)));
                            data.adaptive_enabled = !!data.adaptive_enabled;
                        }
                        if (data.type === 'terminal_exec') {
                            data.timeout = Math.max(3, Math.min(180, Number(data.timeout || 60)));
                            if (typeof data.command === 'string' && data.command.length > 8000) {
                                data.command = data.command.slice(0, 8000);
                            }
                            if (data.cwd != null && typeof data.cwd === 'string' && data.cwd.length > 4096) {
                                data.cwd = data.cwd.slice(0, 4096);
                            }
                        }
                        if (data.type === 'terminal_input' && typeof data.data === 'string' && data.data.length > 16384) {
                            data.data = data.data.slice(0, 16384);
                        }
                        if (data.type === 'terminal_open') {
                            if (data.cwd != null && typeof data.cwd === 'string' && data.cwd.length > 4096) {
                                data.cwd = data.cwd.slice(0, 4096);
                            }
                        }
                        agent.ws.send(JSON.stringify(data));
                        const vs = viewerStats.get(ws);
                        if (vs) {
                            vs.uplinkJson += 1;
                            bumpTypeCounter(vs.packetTypes, `up_${data.type || "unknown"}`);
                            pushTrace(vs, 'up', `up_${data.type || "unknown"}`, sanitizePreview(data));
                        }
                    }
                }
                // Forward agent -> all viewers (stream_info, clipboard_data, file_list, ecc)
                else if (connectionInfo.role === 'agent') {
                    const agent = agents.get(connectionInfo.id);
                    if (!agent || !agent.viewers) return;
                    const payload = JSON.stringify(data);
                    agent.viewers.forEach(vws => {
                        if (vws.readyState === WebSocket.OPEN) {
                            try { vws.send(payload); } catch {}
                            const vs = viewerStats.get(vws);
                            if (vs) {
                                vs.downlinkJson += 1;
                                bumpTypeCounter(vs.packetTypes, `down_${data.type || "unknown"}`);
                                pushTrace(vs, 'down', `down_${data.type || "unknown"}`, sanitizePreview(data));
                            }
                        } else {
                            agent.viewers.delete(vws);
                            viewers.delete(vws);
                        }
                    });
                }
            }
        } catch (e) {
            safeSendJSON(ws, { type: 'error', message: 'Invalid JSON payload' });
        }
    });

    ws.on('close', () => {
        if (connectionInfo.role === 'agent') {
            agents.delete(connectionInfo.id);
        } else if (connectionInfo.role === 'viewer') {
            const agent = agents.get(connectionInfo.targetId);
            if (agent) agent.viewers.delete(ws);
            viewers.delete(ws);
            viewerStats.delete(ws);
        }
    });
});

// Remove dead sockets quickly so relay doesn't waste work.
const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            try { ws.terminate(); } catch {}
            return;
        }
        ws.isAlive = false;
        try { ws.ping(); } catch {}
    });
}, 15000);
wss.on('close', () => clearInterval(heartbeat));

// Push relay-side transport stats to viewers once per second.
setInterval(() => {
    viewerStats.forEach((vs, ws) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const fps = vs.txFrames - vs.lastTxFrames;
        const bytes = vs.txBytes - vs.lastTxBytes;
        const droppedDelta = vs.droppedFrames - vs.lastDroppedFrames;
        const upJsonPps = vs.uplinkJson - vs.lastUplinkJson;
        const downJsonPps = vs.downlinkJson - vs.lastDownlinkJson;
        vs.lastTxFrames = vs.txFrames;
        vs.lastTxBytes = vs.txBytes;
        vs.lastDroppedFrames = vs.droppedFrames;
        vs.lastUplinkJson = vs.uplinkJson;
        vs.lastDownlinkJson = vs.downlinkJson;
        const packetTypePps = {};
        Object.keys(vs.packetTypes).forEach((k) => {
            const prev = vs.lastPacketTypes[k] || 0;
            const now = vs.packetTypes[k];
            const delta = now - prev;
            if (delta > 0) packetTypePps[k] = delta;
            vs.lastPacketTypes[k] = now;
        });
        if (vs.traceEnabled && !vs.traceBaseline) {
            vs.traceBaseline = {
                tx_fps: fps,
                tx_kbps: Number(((bytes * 8) / 1000).toFixed(1)),
                dropped_per_s: droppedDelta,
                up_json_pps: upJsonPps,
                down_json_pps: downJsonPps
            };
        }
        const txKbps = Number(((bytes * 8) / 1000).toFixed(1));
        const compare = vs.traceBaseline ? {
            base_tx_fps: vs.traceBaseline.tx_fps,
            base_tx_kbps: vs.traceBaseline.tx_kbps,
            base_dropped_per_s: vs.traceBaseline.dropped_per_s,
            diff_tx_fps: Number((fps - vs.traceBaseline.tx_fps).toFixed(1)),
            diff_tx_kbps: Number((txKbps - vs.traceBaseline.tx_kbps).toFixed(1)),
            diff_dropped_per_s: droppedDelta - vs.traceBaseline.dropped_per_s
        } : null;
        safeSendJSON(ws, {
            type: 'relay_stats',
            tx_fps: fps,
            tx_kbps: txKbps,
            up_json_pps: upJsonPps,
            down_json_pps: downJsonPps,
            dropped_frames: vs.droppedFrames,
            dropped_per_s: droppedDelta,
            buffered_amount: ws.bufferedAmount,
            packet_type_pps: packetTypePps,
            trace_enabled: vs.traceEnabled,
            trace_rows: vs.traceEnabled ? vs.traceRows : [],
            trace_compare: compare
        });
    });
}, 1000);


server.listen(PORT, () => {
    console.log(`[RELAY] Server running at http://localhost:${PORT}`);
    console.log(`[RELAY] WebSocket server integrated.`);
});
