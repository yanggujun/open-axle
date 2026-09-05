const SERVER_URL = 'http://127.0.0.1:8080';

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

async function apiRequest(endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${SERVER_URL}${endpoint}`, options);
  return await response.json();
}

async function checkServer() {
  try {
    const res = await fetch(`${SERVER_URL}/skills`);
    if (res.ok) {
      setStatus('Connected');
    } else {
      setStatus('Offline', true);
    }
  } catch (err) {
    setStatus('Offline', true);
  }
}

async function handleSend() {
  const text = messageInput.value.trim();
  if (!text) return;
  addMessage('user', text);
  messageInput.value = '';
  try {
    const data = await apiRequest('/talk', 'POST', { text });
    if (data.error) {
      addMessage('error', data.error);
    } else {
      addMessage('agent', typeof data === 'string' ? data : JSON.stringify(data));
    }
  } catch (err) {
    addMessage('error', 'Failed to reach server');
  }
}

async function handleSkills() {
  try {
    const data = await apiRequest('/skills', 'GET');
    addMessage('agent', JSON.stringify(data));
  } catch (err) {
    addMessage('error', 'Failed to reach server');
  }
}

async function handleReload() {
  try {
    const data = await apiRequest('/reload', 'GET');
    addMessage('agent', typeof data === 'string' ? data : JSON.stringify(data));
  } catch (err) {
    addMessage('error', 'Failed to reach server');
  }
}

async function handleClear() {
  try {
    const data = await apiRequest('/clear', 'GET');
    addMessage('agent', typeof data === 'string' ? data : JSON.stringify(data));
  } catch (err) {
    addMessage('error', 'Failed to reach server');
  }
}

async function handleCd() {
  const path = cdPath.value.trim();
  if (!path) return;
  try {
    const data = await apiRequest('/cd', 'POST', { path });
    addMessage('agent', typeof data === 'string' ? data : JSON.stringify(data));
  } catch (err) {
    addMessage('error', 'Failed to reach server');
  }
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

checkServer();
setInterval(checkServer, 10000);
