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

const agents = new Map(); // Agent ID -> { ws, password }
const viewers = new Map(); // Viewer WS -> Agent ID they are watching

wss.on('connection', (ws) => {
    console.log('New WebSocket connection established.');
    let connectionInfo = { role: null, id: null };

    ws.on('message', (message, isBinary) => {
        if (isBinary) {
            // Rotta veloce per dati binari (Streaming Video)
            if (connectionInfo.role === 'agent') {
                wss.clients.forEach((client) => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        if (viewers.get(client) === connectionInfo.id) {
                            client.send(message, { binary: true });
                        }
                    }
                });
            }
            return;
        }

        try {
            const data = JSON.parse(message);
            // console.log('Received:', data); // Silenziato per performance

            if (data.type === 'register') {
                if (data.role === 'agent') {
                    connectionInfo.role = 'agent';
                    connectionInfo.id = data.id;
                    agents.set(data.id, { ws: ws, password: data.password });
                    console.log(`Agent registered: ${data.id} (Password Protected)`);
                    ws.send(JSON.stringify({ type: 'registered', status: 'success' }));
                } else if (data.role === 'viewer') {
                    const agentEntry = agents.get(data.targetId);
                    if (agentEntry) {
                        if (agentEntry.password === data.password) {
                            connectionInfo.role = 'viewer';
                            connectionInfo.targetId = data.targetId;
                            viewers.set(ws, data.targetId);
                            console.log(`Viewer authorized and connected to agent: ${data.targetId}`);
                            ws.send(JSON.stringify({ type: 'registered', status: 'success', targetId: data.targetId }));
                        } else {
                            ws.send(JSON.stringify({ type: 'error', message: 'Invalid password' }));
                        }
                    } else {
                        ws.send(JSON.stringify({ type: 'error', message: 'Agent not found or offline' }));
                    }
                }
            } else {
                // Forwarding logic
                if (connectionInfo.role === 'viewer' && connectionInfo.targetId) {
                    // Forward viewer message to agent
                    const agentEntry = agents.get(connectionInfo.targetId);
                    if (agentEntry && agentEntry.ws.readyState === WebSocket.OPEN) {
                        agentEntry.ws.send(JSON.stringify({ ...data, from: 'viewer' }));
                    }
                } else if (connectionInfo.role === 'agent') {
                    // Forward agent message to all viewers watching this agent
                    wss.clients.forEach((client) => {
                        if (client !== ws && client.readyState === WebSocket.OPEN) {
                            if (viewers.get(client) === connectionInfo.id) {
                                client.send(JSON.stringify({ ...data, from: 'agent' }));
                            }
                        }
                    });
                }
            }
        } catch (e) {
            console.log(`Raw message: ${message}`);
        }
    });

    ws.on('close', () => {
        if (connectionInfo.role === 'agent' && connectionInfo.id) {
            agents.delete(connectionInfo.id);
            console.log(`Agent disconnected: ${connectionInfo.id}`);
        } else if (connectionInfo.role === 'viewer') {
            viewers.delete(ws);
            console.log(`Viewer disconnected from: ${connectionInfo.targetId}`);
        }
    });
});


server.listen(PORT, () => {
    console.log(`[RELAY] Server running at http://localhost:${PORT}`);
    console.log(`[RELAY] WebSocket server integrated.`);
});
