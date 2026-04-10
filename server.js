const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({
    server,
    perMessageDeflate: false,
    maxPayload: 50 * 1024 * 1024
});

const PORT = process.env.PORT || 3000;

// Serve standard static files
app.use(express.static(path.join(__dirname, 'public')));

const agents = new Map(); // Agent ID -> { ws, password, viewers: Set }
const viewers = new Map(); // Viewer WS -> Agent ID

function safeSendJSON(ws, payload) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    try {
        ws.send(JSON.stringify(payload));
        return true;
    } catch {
        return false;
    }
}

wss.on('connection', (ws) => {
    console.log('New WebSocket connection.');
    let connectionInfo = { role: null, id: null };
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
                            if (vws.bufferedAmount > 2 * 1024 * 1024) return;
                            vws.send(message, { binary: true });
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
                        agent.ws.send(JSON.stringify(data));
                    }
                }
                // Forward agent -> all viewers (stream_info, clipboard_data, file_list, ecc)
                else if (connectionInfo.role === 'agent') {
                    const agent = agents.get(connectionInfo.id);
                    if (!agent || !agent.viewers) return;
                    agent.viewers.forEach(vws => {
                        if (vws.readyState === WebSocket.OPEN) {
                            safeSendJSON(vws, data);
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
        }
    });
});


server.listen(PORT, () => {
    console.log(`[RELAY] Server running at http://localhost:${PORT}`);
    console.log(`[RELAY] WebSocket server integrated.`);
});
