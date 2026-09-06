const WS_URL = 'ws://127.0.0.1:8080';

let ws = null;
let reconnectTimer = null;
let pendingType = null;

const messageInput = document.getElementById('message-input');
const btnSend = document.getElementById('btn-send');
const chatLog = document.getElementById('chat-log');
const serverStatus = document.getElementById('server-status');
const btnSkills = document.getElementById('btn-skills');
const btnReload = document.getElementById('btn-reload');
const btnClear = document.getElementById('btn-clear');
const btnCd = document.getElementById('btn-cd');
const cdPath = document.getElementById('cd-path');

function addMessage(type, text) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${type}`;
  const time = new Date().toLocaleTimeString();
  msgDiv.innerHTML = `<span class="time">${time}</span> <span class="body">${text}</span>`;
  chatLog.appendChild(msgDiv);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function setStatus(text, isError = false) {
  serverStatus.textContent = text;
  serverStatus.className = `server-status ${isError ? 'error' : 'ok'}`;
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 3000);
}

function connect() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    setStatus('Connected');
  };

  ws.onmessage = (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (e) {
      data = event.data;
    }
    handleResponse(data);
  };

  ws.onerror = () => {
    setStatus('Offline', true);
  };

  ws.onclose = () => {
    setStatus('Offline', true);
    scheduleReconnect();
  };
}

function sendRequest(type, payload = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    pendingType = type;
    ws.send(JSON.stringify({ type, ...payload }));
  } else {
    addMessage('error', 'Server is not connected');
  }
}

function handleResponse(data) {
  if (data && typeof data === 'object' && data.error) {
    addMessage('error', data.error);
    return;
  }
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  addMessage('agent', text);
}

function handleSend() {
  const text = messageInput.value.trim();
  if (!text) return;
  addMessage('user', text);
  messageInput.value = '';
  sendRequest('talk', { text });
}

function handleSkills() {
  sendRequest('skills');
}

function handleReload() {
  sendRequest('reload');
}

function handleClear() {
  sendRequest('clear');
}

function handleCd() {
  const path = cdPath.value.trim();
  if (!path) return;
  sendRequest('cd', { path });
}

btnSend.addEventListener('click', handleSend);
messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});
btnSkills.addEventListener('click', handleSkills);
btnReload.addEventListener('click', handleReload);
btnClear.addEventListener('click', handleClear);
btnCd.addEventListener('click', handleCd);

connect();
