const WS_URL = 'ws://127.0.0.1:8080';

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pendingType: string | null = null;

const messageInput = document.getElementById('message-input') as HTMLInputElement;
const btnSend = document.getElementById('btn-send') as HTMLButtonElement;
const chatLog = document.getElementById('chat-log') as HTMLDivElement;
const serverStatus = document.getElementById('server-status') as HTMLDivElement;
const btnSkills = document.getElementById('btn-skills') as HTMLButtonElement;
const btnReload = document.getElementById('btn-reload') as HTMLButtonElement;
const btnClear = document.getElementById('btn-clear') as HTMLButtonElement;
const btnCd = document.getElementById('btn-cd') as HTMLButtonElement;
const cdPath = document.getElementById('cd-path') as HTMLInputElement;

// Helper: escape HTML so message text is rendered as text, not interpreted as markup.
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Helper: pretty-print JSON text with indentation for readability.
function formatJson(text: string): string {
  try {
    const parsed = JSON.parse(text);
    return JSON.stringify(parsed, null, 2);
  } catch (e) {
    return text;
  }
}

// Helper: produce a formatted body for a message, wrapping JSON in a <pre> block.
function formatBody(text: string): string {
  const escaped = escapeHtml(text);
  if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
    const pretty = formatJson(text);
    return `<pre class="json-block">${escapeHtml(pretty)}</pre>`;
  }
  return `<span class="body">${escaped}</span>`;
}

function addMessage(type: string, text: string): void {
  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${type}`;
  const time = new Date().toLocaleTimeString();
  const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);

  msgDiv.innerHTML = `
    <div class="message-header">
      <span class="time">${time}</span>
      <span class="type-label">${typeLabel}</span>
    </div>
    <div class="message-divider"></div>
    <div class="message-body">${formatBody(text)}</div>
  `;
  chatLog.appendChild(msgDiv);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function setStatus(text: string, isError: boolean = false): void {
  serverStatus.textContent = text;
  serverStatus.className = `server-status ${isError ? 'error' : 'ok'}`;
}

function scheduleReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 3000);
}

function connect(): void {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    setStatus('Connected');
  };

  ws.onmessage = (event: MessageEvent) => {
    let data: any;
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

function sendRequest(type: string, payload: Record<string, unknown> = {}): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    pendingType = type;
    ws.send(JSON.stringify({ type, ...payload }));
  } else {
    addMessage('error', 'Server is not connected');
  }
}

function handleResponse(data: any): void {
  if (data && typeof data === 'object' && data.error) {
    addMessage('error', typeof data.error === 'string' ? data.error : JSON.stringify(data.error, null, 2));
    return;
  }
  // Broadcast messages from the queue handler (server-side enqueue) are
  // wrapped as { type: 'broadcast', message: ... }.
  if (data && typeof data === 'object' && data.type === 'broadcast') {
    const text = typeof data.message === 'string' ? data.message : JSON.stringify(data.message, null, 2);
    addMessage('broadcast', text);
    return;
  }
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  addMessage('agent', text);
}

function handleSend(): void {
  const text = messageInput.value.trim();
  if (!text) return;
  addMessage('user', text);
  messageInput.value = '';
  sendRequest('talk', { text });
}

function handleSkills(): void {
  sendRequest('skills');
}

function handleReload(): void {
  sendRequest('reload');
}

function handleClear(): void {
  sendRequest('clear');
}

function handleCd(): void {
  const path = cdPath.value.trim();
  if (!path) return;
  sendRequest('cd', { path });
}

btnSend.addEventListener('click', handleSend);
messageInput.addEventListener('keydown', (e: KeyboardEvent) => {
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
