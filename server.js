const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Serve standard static files
app.use(express.static(path.join(__dirname, 'public')));

const agents = new Map(); // Agent ID -> { ws, password, viewers: Set }
const viewers = new Map(); // Viewer WS -> Agent ID

wss.on('connection', (ws) => {
    console.log('New WebSocket connection.');
    let connectionInfo = { role: null, id: null };

    ws.on('message', (message, isBinary) => {
        if (isBinary) {
            if (connectionInfo.role === 'agent') {
                const agent = agents.get(connectionInfo.id);
                if (agent && agent.viewers) {
                    agent.viewers.forEach(vws => {
                        if (vws.readyState === WebSocket.OPEN) {
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
                    ws.send(JSON.stringify({ type: 'registered', status: 'success' }));
                } else if (data.role === 'viewer') {
                    const agent = agents.get(data.targetId);
                    if (agent && agent.password === data.password) {
                        connectionInfo.role = 'viewer';
                        connectionInfo.targetId = data.targetId;
                        viewers.set(ws, data.targetId);
                        agent.viewers.add(ws);
                        console.log(`Viewer added to agent: ${data.targetId}`);
                        ws.send(JSON.stringify({ 
                            type: 'registered', 
                            status: 'success', 
                            width: agent.width, 
                            height: agent.height 
                        }));
                    } else {
                        ws.send(JSON.stringify({ type: 'error', message: 'Auth failed' }));
                    }
                }
            } else {
                // Forwarding messaggi JSON (Mouse, ecc)
                if (connectionInfo.role === 'viewer') {
                    const agent = agents.get(connectionInfo.targetId);
                    if (agent) agent.ws.send(JSON.stringify(data));
                }
            }
        } catch (e) {}
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
