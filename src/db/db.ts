/**
 * db.ts
 *
 * Database abstraction layer.
 *
 * Defines a common DbExecutor contract (connect / query / nonQuery / disconnect)
 * and provides concrete implementations backed by the native drivers:
 *
 *   - MySQL        -> mysql2
 *   - PostgreSQL   -> pg
 *   - SQL Server   -> mssql      (node-mssql, built on Tedious)
 *   - Oracle       -> oracledb   (official Oracle driver)
 *   - SAP HANA     -> @sap/hana-client
 */

import mysql, { Pool as MySqlPool, ResultSetHeader } from 'mysql2/promise';
import { Pool as PgPool, QueryResult as PgQueryResult } from 'pg';
import * as mssql from 'mssql';
import * as oracledb from 'oracledb';
import * as hana from '@sap/hana-client';

/* ========================================================================== */
/*                              Public contracts                              */
/* ========================================================================== */

export type DbType = 'mysql' | 'postgres' | 'mssql' | 'oracle' | 'hana';

/** Parameter styles understood by the executors. */
export type SqlParams = ReadonlyArray<unknown> | Record<string, unknown>;

/** Connection settings shared by every backend. */
export interface DbConfig {
  /** Which backend implementation to instantiate. */
  type: DbType;
  /** Host name or IP address (defaults to localhost). */
  host?: string;
  /** TCP port (each driver falls back to its own default). */
  port?: number;
  /** Login user name. */
  user?: string;
  /** Login password. */
  password?: string;
  /** Database / service name. */
  database?: string;
  /** Optional full connection string (used by drivers that support it). */
  connectionString?: string;
  /** Extra driver-specific options merged into the connection config. */
  options?: Record<string, unknown>;
}

/** Result of a read (query) execution. */
export interface QueryResult<T = unknown> {
  /** Rows produced by the statement. */
  rows: T[];
  /** Number of rows affected, when reported by the driver. */
  affectedRows?: number;
  /** Column / field metadata, when available. */
  fields?: unknown;
}

/** The abstraction contract every database implementation must fulfil. */
export interface DbExecutor {
  /** Open the underlying connection (or pool). */
  connect(): Promise<void>;
  /** Execute a statement that returns rows. */
  query<T = unknown>(sql: string, params?: SqlParams): Promise<QueryResult<T>>;
  /** Execute a statement that returns no rows; resolves with affected-row count. */
  nonQuery(sql: string, params?: SqlParams): Promise<number>;
  /** Close the connection / pool and release all resources. */
  disconnect(): Promise<void>;
}

/* ========================================================================== */
/*                              Shared base class                             */
/* ========================================================================== */

/** Common functionality shared by all executors. */
export abstract class BaseExecutor implements DbExecutor {
  protected connected = false;

  /** Throws when the executor has not been connected yet. */
  protected assertConnected(): void {
    if (!this.connected) {
      throw new Error(`${this.constructor.name}: not connected. Call connect() first.`);
    }
  }

  abstract connect(): Promise<void>;
  abstract query<T = unknown>(sql: string, params?: SqlParams): Promise<QueryResult<T>>;
  abstract nonQuery(sql: string, params?: SqlParams): Promise<number>;
  abstract disconnect(): Promise<void>;
}

/* ========================================================================== */
/*                                   MySQL                                    */
/* ========================================================================== */

export class MySqlExecutor extends BaseExecutor {
  private pool?: MySqlPool;

  constructor(private readonly config: DbConfig) {
    super();
  }

  async connect(): Promise<void> {
    this.pool = mysql.createPool({
      host: this.config.host ?? 'localhost',
      port: this.config.port ?? 3306,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      waitForConnections: true,
      connectionLimit: 10,
      ...(this.config.options ?? {}),
    });

    // Verify the pool is usable before flagging the executor as connected.
    const conn = await this.pool.getConnection();
    conn.release();
    this.connected = true;
  }

  async query<T = unknown>(sql: string, params?: SqlParams): Promise<QueryResult<T>> {
    this.assertConnected();
    const [rows, fields] = await this.pool!.query(sql, params as any);
    return { rows: rows as T[], fields };
  }

  async nonQuery(sql: string, params?: SqlParams): Promise<number> {
    this.assertConnected();
    const [result] = await this.pool!.query(sql, params as any);
    return (result as ResultSetHeader).affectedRows ?? 0;
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = undefined;
    }
    this.connected = false;
  }
}

/* ========================================================================== */
/*                                 PostgreSQL                                 */
/* ========================================================================== */

export class PostgresExecutor extends BaseExecutor {
  private pool?: PgPool;

  constructor(private readonly config: DbConfig) {
    super();
  }

  async connect(): Promise<void> {
    this.pool = new PgPool({
      host: this.config.host ?? 'localhost',
      port: this.config.port ?? 5432,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      connectionString: this.config.connectionString,
      ...(this.config.options ?? {}),
    });

    const client = await this.pool.connect();
    client.release();
    this.connected = true;
  }

  async query<T = unknown>(sql: string, params?: SqlParams): Promise<QueryResult<T>> {
    this.assertConnected();
    const result: PgQueryResult = await this.pool!.query(
      sql,
      Array.isArray(params) ? (params as any[]) : undefined,
    );
    return {
      rows: result.rows as T[],
      affectedRows: result.rowCount ?? undefined,
      fields: result.fields,
    };
  }

  async nonQuery(sql: string, params?: SqlParams): Promise<number> {
    const result = await this.query(sql, params);
    return result.affectedRows ?? 0;
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = undefined;
    }
    this.connected = false;
  }
}

/* ========================================================================== */
/*                                 SQL Server                                 */
/* ========================================================================== */

export class MsSqlExecutor extends BaseExecutor {
  private pool?: mssql.ConnectionPool;

  constructor(private readonly config: DbConfig) {
    super();
  }

  async connect(): Promise<void> {
    const poolConfig: mssql.config = {
      server: this.config.host ?? 'localhost',
      port: this.config.port ?? 1433,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      options: {
        encrypt: true,
        trustServerCertificate: true,
        ...(this.config.options ?? {}),
      },
    };

    this.pool = new mssql.ConnectionPool(poolConfig);
    await this.pool.connect();
    this.connected = true;
  }

  async query<T = unknown>(sql: string, params?: SqlParams): Promise<QueryResult<T>> {
    this.assertConnected();
    const request = this.buildRequest(params);
    const result = await request.query(sql);
    return {
      rows: (result.recordset ?? []) as T[],
      affectedRows: result.rowsAffected?.[0],
    };
  }

  async nonQuery(sql: string, params?: SqlParams): Promise<number> {
    this.assertConnected();
    const request = this.buildRequest(params);
    const result = await request.query(sql);
    return result.rowsAffected?.[0] ?? 0;
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.close();
      this.pool = undefined;
    }
    this.connected = false;
  }

  /** Bind parameters onto a fresh request object. */
  private buildRequest(params?: SqlParams): mssql.Request {
    const request = this.pool!.request();
    if (!params) {
      return request;
    }
    if (Array.isArray(params)) {
      params.forEach((value, index) => request.input(`p${index}`, value as any));
    } else {
      Object.entries(params).forEach(([key, value]) => request.input(key, value as any));
    }
    return request;
  }
}

/* ========================================================================== */
/*                                   Oracle                                   */
/* ========================================================================== */

export class OracleExecutor extends BaseExecutor {
  private pool?: oracledb.Pool;

  constructor(private readonly config: DbConfig) {
    super();
  }

  async connect(): Promise<void> {
    const connectString =
      this.config.connectionString ??
      `${this.config.host ?? 'localhost'}:${this.config.port ?? 1521}/${this.config.database ?? ''}`;

    this.pool = await oracledb.createPool({
      user: this.config.user,
      password: this.config.password,
      connectString,
      ...(this.config.options ?? {}),
    });

    const conn = await this.pool.getConnection();
    await conn.close();
    this.connected = true;
  }

  async query<T = unknown>(sql: string, params?: SqlParams): Promise<QueryResult<T>> {
    this.assertConnected();
    const conn = await this.pool!.getConnection();
    try {
      const result = await conn.execute(sql, (params as any) ?? [], {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        autoCommit: true,
      });
      return { rows: (result.rows ?? []) as T[] };
    } finally {
      await conn.close();
    }
  }

  async nonQuery(sql: string, params?: SqlParams): Promise<number> {
    this.assertConnected();
    const conn = await this.pool!.getConnection();
    try {
      const result = await conn.execute(sql, (params as any) ?? [], {
        autoCommit: true,
      });
      return result.rowsAffected ?? 0;
    } finally {
      await conn.close();
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.close(0);
      this.pool = undefined;
    }
    this.connected = false;
  }
}

/* ========================================================================== */
/*                                  SAP HANA                                  */
/* ========================================================================== */

export class HanaExecutor extends BaseExecutor {
  private conn?: hana.Connection;

  constructor(private readonly config: DbConfig) {
    super();
  }

  async connect(): Promise<void> {
    this.conn = hana.createConnection();
    await new Promise<void>((resolve, reject) => {
      this.conn!.connect(
        {
          serverNode: `${this.config.host ?? 'localhost'}:${this.config.port ?? 30015}`,
          uid: this.config.user,
          pwd: this.config.password,
          currentSchema: this.config.database,
          ...(this.config.options ?? {}),
        },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    this.connected = true;
  }

  async query<T = unknown>(sql: string, params?: SqlParams): Promise<QueryResult<T>> {
    this.assertConnected();
    const rows = await new Promise<T[]>((resolve, reject) => {
      this.conn!.exec(sql, (params as any) ?? [], (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve((result as T[]) ?? []);
        }
      });
    });
    return { rows };
  }

  async nonQuery(sql: string, params?: SqlParams): Promise<number> {
    this.assertConnected();
    const affected = await new Promise<number>((resolve, reject) => {
      this.conn!.exec(sql, (params as any) ?? [], (err, count) => {
        if (err) {
          reject(err);
        } else {
          resolve((count as number) ?? 0);
        }
      });
    });
    return affected;
  }

  async disconnect(): Promise<void> {
    if (this.conn) {
      await new Promise<void>((resolve, reject) => {
        this.conn!.disconnect((err) => (err ? reject(err) : resolve()));
      });
      this.conn = undefined;
    }
    this.connected = false;
  }
}

/* ========================================================================== */
/*                                  Factory                                   */
/* ========================================================================== */

/** Create the executor matching the config type. */
export function createDbExecutor(config: DbConfig): DbExecutor {
  switch (config.type) {
    case 'mysql':
      return new MySqlExecutor(config);
    case 'postgres':
      return new PostgresExecutor(config);
    case 'mssql':
      return new MsSqlExecutor(config);
    case 'oracle':
      return new OracleExecutor(config);
    case 'hana':
      return new HanaExecutor(config);
    default: {
      const exhaustive: never = config.type;
      throw new Error(`Unsupported database type: ${String(exhaustive)}`);
    }
  }
}

export default createDbExecutor;
