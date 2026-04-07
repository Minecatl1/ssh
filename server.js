const express = require('express');
const WebSocket = require('ws');
const { Client } = require('ssh2');
const net = require('net');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });
const connections = new Map(); // sessionId -> { type, sshClient, stream, vncSocket }

app.use(express.json());

wss.on('connection', (ws) => {
  const sessionId = uuidv4();
  let connectionInfo = null;

  ws.on('message', async (data) => {
    // Handle both text (JSON) and binary (VNC data) messages
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        handleJsonMessage(ws, sessionId, msg);
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      }
    } else {
      // Binary data – only forward if VNC session is active
      if (connectionInfo && connectionInfo.type === 'vnc' && connectionInfo.vncSocket) {
        connectionInfo.vncSocket.write(data);
      }
    }
  });

  ws.on('close', () => {
    cleanUp(sessionId);
  });

  function handleJsonMessage(ws, sessionId, msg) {
    switch (msg.type) {
      case 'connect':
        if (msg.protocol === 'ssh') {
          startSSH(ws, sessionId, msg);
        } else if (msg.protocol === 'vnc') {
          startVNC(ws, sessionId, msg);
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'Unknown protocol' }));
        }
        break;

      case 'data':   // used only for SSH keyboard input
        if (connectionInfo && connectionInfo.type === 'ssh' && connectionInfo.stream) {
          connectionInfo.stream.write(msg.data);
        }
        break;

      case 'resize': // used only for SSH terminal resize
        if (connectionInfo && connectionInfo.type === 'ssh' && connectionInfo.stream) {
          connectionInfo.stream.setWindow(msg.rows, msg.cols);
        }
        break;

      default:
        break;
    }
  }

  function startSSH(ws, sessionId, msg) {
    const { host, port, username, password, privateKey } = msg;
    const sshClient = new Client();
    let stream = null;

    sshClient.on('ready', () => {
      sshClient.shell({ term: 'xterm-256color' }, (err, shellStream) => {
        if (err) {
          ws.send(JSON.stringify({ type: 'error', message: err.message }));
          return;
        }
        stream = shellStream;
        connectionInfo = { type: 'ssh', sshClient, stream };
        connections.set(sessionId, connectionInfo);

        stream.on('data', (d) => {
          ws.send(JSON.stringify({ type: 'data', data: d.toString('utf-8') }));
        });
        stream.on('close', () => {
          ws.send(JSON.stringify({ type: 'closed' }));
          cleanUp(sessionId);
        });
        ws.send(JSON.stringify({ type: 'connected' }));
      });
    });

    sshClient.on('error', (err) => {
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
      cleanUp(sessionId);
    });

    sshClient.on('close', () => {
      ws.send(JSON.stringify({ type: 'closed' }));
      cleanUp(sessionId);
    });

    const connectConfig = { host, port: port || 22, username, readyTimeout: 10000 };
    if (privateKey) connectConfig.privateKey = privateKey;
    else if (password) connectConfig.password = password;
    else {
      ws.send(JSON.stringify({ type: 'error', message: 'No password or private key' }));
      return;
    }
    sshClient.connect(connectConfig);
  }

  function startVNC(ws, sessionId, msg) {
    const { host, port } = msg;
    const vncPort = port || 5900;
    const vncSocket = net.createConnection(vncPort, host);

    vncSocket.on('connect', () => {
      connectionInfo = { type: 'vnc', vncSocket };
      connections.set(sessionId, connectionInfo);
      ws.send(JSON.stringify({ type: 'connected' }));
      // Start forwarding binary data from VNC socket to WebSocket
      vncSocket.on('data', (chunk) => {
        ws.send(chunk); // binary frame
      });
    });

    vncSocket.on('error', (err) => {
      ws.send(JSON.stringify({ type: 'error', message: `VNC error: ${err.message}` }));
      cleanUp(sessionId);
    });

    vncSocket.on('close', () => {
      ws.send(JSON.stringify({ type: 'closed' }));
      cleanUp(sessionId);
    });
  }

  function cleanUp(sessionId) {
    const info = connections.get(sessionId);
    if (info) {
      if (info.type === 'ssh') {
        if (info.stream) info.stream.end();
        if (info.sshClient) info.sshClient.end();
      } else if (info.type === 'vnc') {
        if (info.vncSocket) info.vncSocket.destroy();
      }
      connections.delete(sessionId);
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`WebSocket proxy listening on port ${PORT} (SSH + VNC)`);
});
