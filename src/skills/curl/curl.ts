import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { ExecutionResponse, extractJson, getSequential, getSkillConfig } from '../../core/executor';

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

const BLOCKED_HOST_PATTERNS = [
  '::1',
  '10.',
  '172.16.',
  '172.17.',
  '172.18.',
  '172.19.',
  '172.20.',
  '172.21.',
  '172.22.',
  '172.23.',
  '172.24.',
  '172.25.',
  '172.26.',
  '172.27.',
  '172.28.',
  '172.29.',
  '172.30.',
  '172.31.',
  '192.168.',
  '169.254.',
];

const BLOCKED_URL_PATTERNS = [
  /^file:/i,
  /^ftp:/i,
  /^gopher:/i,
  /^dict:/i,
];

const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

const MAX_OUTPUT_SIZE = 1024 * 1024; // 1MB max

// ---------------------------------------------------------------------------
// Config resolution (curl authentication via getSkillConfig)
// ---------------------------------------------------------------------------

function _resolveAuthFromConfig(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (e: any) {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  const config = getSkillConfig('curl', host);
  const authString = config?.auth_string;
  if (authString) {
    const trimmed = authString.trim().replace(/^\s+/, '');
    const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    if (!match) {
      return trimmed;
    }
    const words: string[] = [match[1]];
    if (match[2] !== undefined) {
      words.push(match[2]);
    }

    let result = authString;
    if (words.length && words[0].toLowerCase() === 'bearer') {
      words[0] = 'Bearer';
      result = words.join(' ');
    }

    if (words.length && words[0].toLowerCase() === 'basic') {
      words[0] = 'Basic';
      if (words[1]) {
        words[1] = Buffer.from(words[1], 'utf8').toString('base64');
    }
    result = words.join(' ');
    return result;
  }

  }
  return null;
}

function _isBlockedUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (e: any) {
    return 'Invalid URL';
  }

  for (const pattern of BLOCKED_URL_PATTERNS) {
    if (pattern.test(url)) {
      return pattern.source;
    }
  }

  const host = parsed.hostname.toLowerCase();
  for (const frag of BLOCKED_HOST_PATTERNS) {
    if (host === frag || host.startsWith(frag)) {
      return frag;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Payload validation & normalization
// ---------------------------------------------------------------------------

function _toInt(value: any, def: number): number {
  if (value === null || value === undefined || value === '') return def;
  const n = parseInt(String(value).trim(), 10);
  return isNaN(n) ? def : n;
}

function _toBool(value: any, def: boolean): boolean {
  if (value === null || value === undefined || value === '') return def;
  const v = String(value).trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return def;
}

function _normalize(payload: Record<string, any>): Record<string, any> {
  const action = payload.action ?? 'curl';
  const [sequential, nextPromptRaw] = getSequential(payload);

  if (action !== 'curl') {
    throw new Error(`Unsupported action: ${action}`);
  }

  const props: Record<string, any> = {};
  for (const p of payload.properties ?? []) {
    props[p.name] = p.value;
  }

  const method = (props.method ?? 'GET').toString().toUpperCase().trim();
  const url = (props.url ?? '').toString().trim();
  const headersRaw = (props.headers ?? '{}').toString() || '{}';
  const data = (props.data ?? '').toString();
  const dataType = (props.dataType ?? 'text').toString().toLowerCase().trim() || 'text';
  let timeout = _toInt(props.timeout, 30);
  const followRedirects = _toBool(props.followRedirects, true);
  const auth = (props.auth ?? '').toString();
  const description = (props.description ?? '').toString();

  if (!url) {
    throw new Error("Missing required field: 'url'");
  }

  if (!ALLOWED_METHODS.includes(method)) {
    throw new Error(`Unsupported method: ${method}. Valid values: ${ALLOWED_METHODS.join(', ')}`);
  }

  if (!['text', 'json', 'form'].includes(dataType)) {
    throw new Error(`Unsupported dataType: ${dataType}. Valid values: text, json, form`);
  }

  // Enforce timeout limits (default 30s, max 120s).
  if (timeout < 1) timeout = 1;
  if (timeout > 120) timeout = 120;

  // Safety: check for blocked URLs.
  const blocked = _isBlockedUrl(url);
  if (blocked) {
    throw new Error(`Blocked URL (contains '${blocked}'); refusing to execute.`);
  }

  // Parse headers JSON if provided.
  let headers: Record<string, string> = {};
  if (headersRaw && headersRaw !== '{}') {
    try {
      const parsed = JSON.parse(headersRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        headers = Object.fromEntries(
          Object.entries(parsed).map(([k, v]) => [k, String(v)])
        );
      } else {
        throw new Error('headers must be a JSON object');
      }
    } catch (e: any) {
      throw new Error(`Invalid headers JSON: ${e.message}`);
    }
  }

  // Resolve authentication: explicit auth takes precedence, otherwise use config.
  let resolvedAuth = auth;
  if (!resolvedAuth) {
    const configAuth = _resolveAuthFromConfig(url);
    if (configAuth) {
      resolvedAuth = configAuth;
    }
  }

  // If auth is available, add Authorization header.
  if (resolvedAuth) {
    headers['Authorization'] = resolvedAuth.trim();
  }

  let nextPrompt = nextPromptRaw;
  if (sequential && nextPrompt) {
    nextPrompt = nextPrompt + '\n\n' + 'Following is the HTTP response: \n\n';
  }

  return {
    action,
    method,
    url,
    headers,
    data,
    dataType,
    timeout,
    followRedirects,
    description,
    sequential,
    prompt: nextPrompt,
  };
}

// ---------------------------------------------------------------------------
// Core HTTP request operation
// ---------------------------------------------------------------------------

function _buildRequestBody(data: Record<string, any>): string | undefined {
  let body = data.data;
  if (!body) return undefined;

  if (data.dataType === 'json') {
    // If already valid JSON string, use as-is; otherwise stringify.
    try {
      JSON.parse(body);
    } catch (e: any) {
      body = JSON.stringify(body);
    }
  } else if (data.dataType === 'form') {
    const params = new URLSearchParams();
    try {
      const obj = JSON.parse(body);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const [k, v] of Object.entries(obj)) {
          params.append(k, String(v));
        }
        body = params.toString();
      } else {
        body = String(body);
      }
    } catch (e: any) {
      // Not JSON; treat as raw string.
      body = String(body);
    }
  }

  return body;
}

async function _performRequest(data: Record<string, any>): Promise<{ status: number; headers: string; body: string }> {
  const parsedUrl = new URL(data.url);
  const isHttps = parsedUrl.protocol === 'https:';
  const lib = isHttps ? https : http;
  const body = _buildRequestBody(data);

  const headers: Record<string, string> = { ...data.headers };

  // Set default content-type based on dataType if not already set and body present.
  if (body && !headers['Content-Type'] && !headers['content-type']) {
    if (data.dataType === 'json') {
      headers['Content-Type'] = 'application/json';
    } else if (data.dataType === 'form') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else {
      headers['Content-Type'] = 'text/plain';
    }
  }
  if (body && !headers['Content-Length'] && !headers['content-length']) {
    headers['Content-Length'] = String(Buffer.byteLength(body));
  }

  return new Promise((resolve, reject) => {
    const req = lib.request(
      data.url,
      {
        method: data.method,
        headers,
        timeout: data.timeout * 1000,
      },
      (res) => {
        // Handle redirects.
        if (data.followRedirects && [301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
          const location = res.headers['location'];
          if (location) {
            res.resume();
            const redirectUrl = new URL(location, data.url).toString();
            const redirectData = { ...data, url: redirectUrl };
            _performRequest(redirectData)
              .then(resolve)
              .catch(reject);
            return;
          }
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          const bodyBuffer = Buffer.concat(chunks);
          let bodyStr = bodyBuffer.toString('utf-8');
          // Cap output size.
          if (bodyStr.length > MAX_OUTPUT_SIZE) {
            bodyStr = bodyStr.substring(0, MAX_OUTPUT_SIZE) + '\n... (truncated)';
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: JSON.stringify(res.headers),
            body: bodyStr,
          });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out after ${data.timeout} seconds`));
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function runCurlFromPayload(payload: string | Record<string, any>): Promise<ExecutionResponse | string> {
  let data: Record<string, any>;
  try {
    const raw = extractJson(payload) ?? {};
    data = _normalize(raw);
  } catch (e: any) {
    return `Invalid payload: ${e.message}`;
  }

  try {
    const result = await _performRequest(data);
    let out = `HTTP Status: ${result.status}\n`;
    if (result.headers) {
      const headers = JSON.parse(result.headers);
      out += `Headers:\n\n\`\`\`json\n${JSON.stringify(headers, null, 2)}\n\`\`\`\n\n`;

    }
    let body = result.body;
    let fence = 'html';
    if (body) {
      if (body.startsWith('{')) {
        fence = 'json'
        const bd = JSON.parse(body);
        body = JSON.stringify(bd, null, 2);
      }
      out += `Body:\n\n\`\`\`${fence}\n${body}\n\`\`\``;
    }

    const seq = data.sequential;
    const response = new ExecutionResponse(out, data.prompt, seq, !seq, 'md');
    return response;
  } catch (e: any) {
    return `Failed to make HTTP request: ${e.message}`;
  }
}

// ---------------------------------------------------------------------------
// Skill wrapper functions (called by the SkillManager)
// ---------------------------------------------------------------------------

function skillCurlExecute(jsonPayload: string): Promise<ExecutionResponse | string> {
  return runCurlFromPayload(jsonPayload);
}

export function execute(jsonPayload: string): Promise<ExecutionResponse | string> {
  return skillCurlExecute(jsonPayload);
}

export const ACTION_NAME = "curl";
