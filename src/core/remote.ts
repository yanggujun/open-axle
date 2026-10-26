import * as fs from 'fs';

/**
 * Remote SSH connection management with per-target connection caching.
 *
 * Opening a brand-new SSH connection for every remote operation (e.g. each
 * folder-picker expansion) is slow and puts needless load on the remote host.
 * This module keeps ONE reusable ssh2 Client per (host, port, user, auth) tuple
 * in a module-scoped cache and reuses it for as long as it stays alive.
 *
 * A cached client that has died (remote closed the session, network hiccup,
 * idle timeout) is evicted and transparently replaced by a fresh connection.
 * Callers must NEVER call end()/destroy() on a client handed out by
 * getSshConn(): this module owns the lifecycle of every client it stores.
 */

/** Connection parameters for a remote SSH target (from .skill.config). */
export interface SshTarget {
  /** Hostname or IP address of the remote server. */
  host: string;
  /** SSH port; defaults to 22 when omitted/falsy. */
  port?: string | number;
  /** Login user name. */
  user?: string;
  /** 'password' (default) or 'key'. */
  authType?: string;
  /** Private key file path, required when authType is 'key'. */
  keyFile?: string;
  /** Password (or key passphrase when authType is 'key'). */
  password?: string;
}

interface SshConnEntry {
  /** The ssh2 Client instance. */
  client: any;
  /** Set once the transport reported close/end/error. */
  dead: boolean;
  /** Epoch ms of the last successful use (drives idle eviction). */
  lastUsed: number;
  /** Resolves once the client has reached the 'ready' state. */
  ready: Promise<any>;
}

/** Reusable connections, keyed by buildSshCacheKey(target). */
const sshConnCache = new Map<string, SshConnEntry>();

/** Cached connections idle for longer than this are closed and evicted. */
export const SSH_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Build the cache key for a target. Every parameter that can change how the
 * connection is established (host, port, user, auth type, key file) is part of
 * the key so two servers - or the same server with different credentials -
 * never share a cached session.
 */
export function buildSshCacheKey(target: SshTarget): string {
  const port = target.port ?? '22';
  const user = target.user ?? '';
  const authType = target.authType ?? 'password';
  const keyFile = target.keyFile ?? '';
  return `${target.host}|${port}|${user}|${authType}|${keyFile}`;
}

/** True while the ssh2 client still owns a usable socket. */
export function isSshConnAlive(client: any): boolean {
  try {
    if (!client) return false;
    // ssh2 keeps the underlying net.Socket on `_sock`. A missing or destroyed
    // socket (or a half-closed one) means the client can no longer be used.
    const sock = client._sock;
    if (!sock || sock.destroyed) return false;
    if (sock.readable === false || sock.writable === false) return false;
    return true;
  } catch {
    return false;
  }
}

/** Forget a cached connection and close its transport (never throws). */
export function evictSshConn(key: string): void {
  const entry = sshConnCache.get(key);
  if (!entry) return;
  sshConnCache.delete(key);
  entry.dead = true;
  try {
    entry.client.end();
  } catch {
    /* transport already closed */
  }
  try {
    if (typeof entry.client.destroy === 'function') {
      entry.client.destroy();
    }
  } catch {
    /* transport already destroyed */
  }
}

/** Evict cached connections that died or have been idle for too long. */
export function sweepSshConns(): void {
  const now = Date.now();
  for (const [key, entry] of Array.from(sshConnCache.entries())) {
    if (entry.dead || !isSshConnAlive(entry.client) || now - entry.lastUsed > SSH_IDLE_TIMEOUT_MS) {
      evictSshConn(key);
    }
  }
}

/** Close and forget EVERY cached connection (e.g. on app shutdown). */
export function closeAllSshConns(): void {
  for (const key of Array.from(sshConnCache.keys())) {
    evictSshConn(key);
  }
}

/** Build the ssh2 connect config from a target descriptor. */
export function buildSshConnectConfig(target: SshTarget): any {
  const connectConfig: any = {
    host: target.host,
    port: Number(target.port ?? 22) || 22,
    username: target.user ?? '',
    readyTimeout: 20000,
    // Keepalives keep the cached session usable across short network stalls
    // so a reused connection is not silently dropped between two calls.
    keepaliveInterval: 15000,
    keepaliveCountMax: 3,
  };
  const authType = target.authType ?? 'password';
  const keyFile = target.keyFile ?? '';
  const password = target.password ?? '';
  if (authType === 'key' && keyFile) {
    connectConfig.privateKey = fs.readFileSync(keyFile);
    if (password) {
      connectConfig.passphrase = password;
    }
  } else {
    connectConfig.password = password;
  }
  return connectConfig;
}

/**
 * Return a cached, ready ssh2 Client for the given connection parameters.
 * A live cached client is reused (its `lastUsed` is refreshed); otherwise a
 * fresh connection is opened and stored in the cache. The caller must NOT
 * close the returned client - it stays cached for the next call.
 */
export async function getSshConn(key: string, connectConfig: any): Promise<any> {
  sweepSshConns();

  const cached = sshConnCache.get(key);
  if (cached) {
    if (!cached.dead && isSshConnAlive(cached.client)) {
      try {
        await cached.ready;
        cached.lastUsed = Date.now();
        return cached.client;
      } catch {
        // Never became ready (or failed while we awaited it) - rebuild below.
        evictSshConn(key);
      }
    } else {
      evictSshConn(key);
    }
  }

  const { Client } = require('ssh2');
  const client = new Client();
  const entry: SshConnEntry = {
    client,
    dead: false,
    lastUsed: Date.now(),
    ready: Promise.resolve(client),
  };

  // Any terminal transport event invalidates the cache entry immediately so
  // the NEXT call opens a fresh connection instead of reusing a dead one.
  const onGone = (): void => {
    entry.dead = true;
    if (sshConnCache.get(key) === entry) {
      sshConnCache.delete(key);
    }
  };
  client.on('close', onGone);
  client.on('end', onGone);
  client.on('error', onGone);

  entry.ready = new Promise<any>((resolve, reject) => {
    let settled = false;
    client.once('ready', () => {
      settled = true;
      resolve(client);
    });
    client.once('error', (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    client.once('close', () => {
      if (settled) return;
      settled = true;
      reject(new Error('SSH connection closed before becoming ready'));
    });
    client.connect(connectConfig);
  });

  sshConnCache.set(key, entry);
  try {
    await entry.ready;
  } catch (error) {
    evictSshConn(key);
    throw error;
  }
  entry.lastUsed = Date.now();
  return client;
}

/** True when an error indicates the SSH transport went away mid-command. */
export function isSshConnLostError(error: unknown): boolean {
  const code = String((error as any)?.code ?? '').toUpperCase();
  if (
    ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)
  ) {
    return true;
  }
  const msg = String(error instanceof Error ? error.message : error ?? '').toLowerCase();
  return /client is not connected|not connected|channel closed|connection lost|connection closed|socket hang up|remote end closed|no response from server|timed out while waiting|ssh connection closed/.test(
    msg,
  );
}

/**
 * Run ONE command over a cached SSH connection and resolve with its stdout.
 *
 * If the cached connection turns out to be dead, the entry is evicted, a fresh
 * connection is opened and the command is retried EXACTLY ONCE before the error
 * is surfaced. The retry goes through the cache, so no connection leaks.
 */
export async function sshExec(target: SshTarget, command: string, isRetry = false): Promise<string> {
  const key = buildSshCacheKey(target);
  const connectConfig = buildSshConnectConfig(target);

  const client = await getSshConn(key, connectConfig);
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      client.exec(command, (err: Error | undefined, stream: any) => {
        if (err) {
          reject(err);
          return;
        }
        let out = '';
        let errOut = '';
        let settled = false;
        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          fn();
        };
        stream.on('close', (code: number) => {
          settle(() => {
            if (code && code !== 0 && !out) {
              reject(new Error(errOut || `Remote command exited with code ${code}`));
              return;
            }
            resolve(out);
          });
        });
        stream.on('data', (chunk: Buffer) => {
          out += chunk.toString();
        });
        stream.on('error', (streamErr: Error) => {
          settle(() => reject(streamErr));
        });
        stream.stderr.on('data', (chunk: Buffer) => {
          errOut += chunk.toString();
        });
      });
    });

    const entry = sshConnCache.get(key);
    if (entry) {
      entry.lastUsed = Date.now();
    }
    return stdout;
  } catch (error) {
    if (!isRetry && isSshConnLostError(error)) {
      // The cached connection died between calls (or mid-flight). Drop it and
      // retry once over a brand-new connection.
      evictSshConn(key);
      return sshExec(target, command, true);
    }
    throw error;
  }
}
