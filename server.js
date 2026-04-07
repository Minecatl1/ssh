const express = require('express');
const WebSocket = require('ws');
const { Client } = require('ssh2');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

// Store active SSH connections
const connections = new Map();

app.use(express.json());
app.use(express.static('public')); // optional static landing

// Simple health check
app.get('/health', (req, res) => {
  res.send('OK');
});

wss.on('connection', (ws) => {
  const sessionId = uuidv4();
  let sshClient = null;
  let stream = null;

  ws.on('message', async (data) => {
    const message = JSON.parse(data);

    switch (message.type) {
      case 'connect':
        const { host, port, username, password, privateKey } = message;
        sshClient = new Client();

        sshClient.on('ready', () => {
          sshClient.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, shellStream) => {
            if (err) {
              ws.send(JSON.stringify({ type: 'error', message: err.message }));
              return;
            }
            stream = shellStream;
            connections.set(sessionId, { sshClient, stream });

            // Send data from SSH to WebSocket
            stream.on('data', (data) => {
              ws.send(JSON.stringify({ type: 'data', data: data.toString('utf-8') }));
            });

            stream.on('close', () => {
              ws.send(JSON.stringify({ type: 'closed' }));
              cleanUp();
            });

            ws.send(JSON.stringify({ type: 'connected' }));
          });
        });

        sshClient.on('error', (err) => {
          ws.send(JSON.stringify({ type: 'error', message: err.message }));
          cleanUp();
        });

        sshClient.on('close', () => {
          ws.send(JSON.stringify({ type: 'closed' }));
          cleanUp();
        });

        // Connect with password or private key
        const connectConfig = {
          host,
          port: port || 22,
          username,
          readyTimeout: 10000,
        };
        if (privateKey) {
          connectConfig.privateKey = privateKey;
        } else if (password) {
          connectConfig.password = password;
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'No password or private key provided' }));
          return;
        }

        sshClient.connect(connectConfig);
        break;

      case 'data':
        if (stream && stream.writable) {
          stream.write(message.data);
        }
        break;

      case 'resize':
        if (stream && stream.setWindow) {
          stream.setWindow(message.rows, message.cols);
        }
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    cleanUp();
  });

  function cleanUp() {
    if (stream) stream.end();
    if (sshClient) sshClient.end();
    connections.delete(sessionId);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`WebSocket SSH proxy listening on port ${PORT}`);
});
