import { randomUUID } from 'crypto';
import { config } from 'dotenv';
import { join } from 'path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

config();

/**
 * Base Postgres aislada para las pruebas de sellado: se crea con un nombre único, se le aplican
 * TODAS las migraciones y se borra al terminar. Usa el servidor de `POSTGRES_DB_URL` (el de
 * desarrollo o el de CI), nunca la base de esa URL ni datos productivos.
 */
export class SealingTestDatabase {
  readonly name: string;
  private readonly adminUrl: string;
  readonly url: string;
  private readonly extra: DataSource[] = [];
  dataSource!: DataSource;
  userId = '';
  accountId = '';

  constructor(prefix: string) {
    const baseUrl = process.env.POSTGRES_DB_URL as string;
    if (!baseUrl) {
      throw new Error('Las pruebas de sellado necesitan POSTGRES_DB_URL.');
    }
    this.name = `${prefix}_${process.pid}_${Date.now()}`;
    this.adminUrl = baseUrl.replace(/\/[^/?]+(\?.*)?$/, '/postgres$1');
    this.url = baseUrl.replace(/\/[^/?]+(\?.*)?$/, `/${this.name}$1`);
  }

  /**
   * Crea la base, aplica las migraciones y siembra un usuario y su cuenta.
   *
   * @returns La propia base.
   */
  async create(): Promise<this> {
    await this.admin(`CREATE DATABASE "${this.name}"`);
    this.dataSource = await this.connect();
    await this.dataSource.runMigrations();

    this.userId = await this.insertReturningId(
      `INSERT INTO users (first_name, last_name, email, roles, lifecycle_status) VALUES ('Ana', 'López', $1, 'user', 'PROVISIONED')`,
      [`ana-${randomUUID()}@correo.example`],
    );
    this.accountId = await this.insertReturningId(
      `INSERT INTO accounts (user_id, account_type, email) VALUES ($1, 'PERSONAL', 'ana@correo.example')`,
      [this.userId],
    );
    return this;
  }

  /**
   * Abre OTRA conexión (otro pool) a la misma base: para probar concurrencia entre procesos.
   *
   * @returns Un `DataSource` independiente; se cierra en `destroy`.
   */
  async connect(): Promise<DataSource> {
    const dataSource = new DataSource({
      type: 'postgres',
      url: this.url,
      entities: [
        join(__dirname, '..', '..', '..', 'src', '**', '*.entity{.ts,.js}'),
      ],
      migrations: [
        join(__dirname, '..', '..', '..', 'src', 'migrations', '*{.ts,.js}'),
      ],
      migrationsTransactionMode: 'each',
    });
    await dataSource.initialize();
    this.extra.push(dataSource);
    return dataSource;
  }

  /** Cierra todas las conexiones y borra la base. */
  async destroy(): Promise<void> {
    for (const dataSource of this.extra) {
      if (dataSource.isInitialized) {
        await dataSource.destroy();
      }
    }
    await this.admin(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${this.name}' AND pid <> pg_backend_pid()`,
    );
    await this.admin(`DROP DATABASE IF EXISTS "${this.name}"`);
  }

  /**
   * Inserta y devuelve el id.
   *
   * @param sql - `INSERT` sin `RETURNING`.
   * @param params - Parámetros.
   * @returns El id de la fila.
   */
  async insertReturningId(sql: string, params: unknown[]): Promise<string> {
    const [row] = await this.dataSource.query(`${sql} RETURNING id`, params);
    return row.id as string;
  }

  /**
   * Documento con los datos mínimos.
   *
   * @param options - Estado, hashes y marca de pendiente.
   * @returns El id del documento.
   */
  insertDocument(
    options: {
      status?: string;
      signedHash?: string | null;
      sealingPending?: boolean;
      signatureType?: string;
      objectKey?: string;
    } = {},
  ): Promise<string> {
    return this.insertReturningId(
      `INSERT INTO documents (object_key, file_name, file_type, total_pages, ip_address, original_hash, signed_hash, created_by, account_id, total_signers, status, signature_type, sealing_pending_at)
       VALUES ($1, 'contrato.pdf', 'application/pdf', 1, '127.0.0.1', 'hash-original', $2, $3, $4, 1, $5, $6, $7)`,
      [
        options.objectKey ?? `${randomUUID()}.pdf`,
        options.signedHash === undefined ? 'hash-firmado' : options.signedHash,
        this.userId,
        this.accountId,
        options.status ?? 'SIGNED',
        options.signatureType ?? 'FIEL',
        options.sealingPending === false ? null : new Date(),
      ],
    );
  }

  /** Ejecuta SQL de administración contra la base `postgres`. */
  private async admin(sql: string): Promise<void> {
    const client = new Client({ connectionString: this.adminUrl });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }
}
