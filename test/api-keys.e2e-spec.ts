import { config } from 'dotenv';
import { join } from 'path';
import { Client } from 'pg';
import { DataSource, QueryFailedError, Repository } from 'typeorm';

import { AccountEntity } from './../src/account/entities/account.entity';
import { OrganizationEntity } from './../src/account/entities/organization.entity';
import { ApiKeyEntity } from './../src/api-key/entities/api-key.entity';
import { ApiKeyStatusEnum } from './../src/api-key/enums/api-key-status.enum';
import { PermissionEntity } from './../src/roles/entities/permission.entity';

config({ path: join(__dirname, '..', '.env') });

/**
 * Modelo de persistencia de API keys contra Postgres de verdad: las relaciones de `ApiKeyEntity`
 * y las restricciones que pone `CreateApiKeys1784300000077` (unicidad de `public_id`, una sola
 * llave `ACTIVE` por organización, reglas de borrado de `api_key_permissions`).
 *
 * **No toca `signature_db`.** Crea una base propia (`signature_api_keys_e2e_*`) en el mismo
 * servidor de `POSTGRES_DB_URL`, le aplica todas las migraciones y la borra al terminar.
 */
describe('API keys de organización (e2e)', () => {
  const DATABASE_NAME = `signature_api_keys_e2e_${process.pid}_${Date.now()}`;
  const baseUrl = process.env.POSTGRES_DB_URL as string;
  const adminUrl = baseUrl.replace(/\/[^/?]+(\?.*)?$/, '/postgres$1');
  const databaseUrl = baseUrl.replace(
    /\/[^/?]+(\?.*)?$/,
    `/${DATABASE_NAME}$1`,
  );

  /** Organizaciones, membresías y permisos sembrados; los ids los genera Postgres. */
  const ids: Record<string, string> = {};

  let dataSource: DataSource;
  let apiKeys: Repository<ApiKeyEntity>;

  async function adminQuery(sql: string): Promise<void> {
    const client = new Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  async function seedOrganization(key: string): Promise<void> {
    const [organization] = await dataSource.query(
      `INSERT INTO organizations (name, display_name) VALUES ($1, $1) RETURNING id`,
      [`Org ${key}`],
    );
    ids[`org:${key}`] = organization.id;
  }

  /**
   * Siembra un usuario y su membresía en una organización.
   *
   * @param key - Nombre con el que la prueba se refiere a la membresía.
   * @param organizationKey - Organización de la membresía.
   * @returns El `accounts.id` creado.
   *
   * @example
   * ```ts
   * await seedMember('org1-ana', 'org1');
   * ```
   */
  async function seedMember(
    key: string,
    organizationKey: string,
  ): Promise<string> {
    const [info] = await dataSource.query(
      `INSERT INTO personal_information (name, last_name, curp) VALUES ($1, 'E2E', $2) RETURNING id`,
      [key, `CURP${key}`.slice(0, 18)],
    );
    const [user] = await dataSource.query(
      `INSERT INTO users (first_name, last_name, email, roles, national_id, password, personal_information_id)
       VALUES ($1, 'E2E', $2, 'user', $3, 'x', $4) RETURNING id`,
      [key, `${key}@api-keys-e2e.test`, `NID${key}`, info.id],
    );
    const [account] = await dataSource.query(
      `INSERT INTO accounts (user_id, account_type, organization_id, role_id, email, password)
       SELECT $1, 'ORGANIZATION', $2, r.id, $3, 'x' FROM roles r WHERE r.name = 'OWNER' AND r.is_system_role = true
       RETURNING id`,
      [user.id, ids[`org:${organizationKey}`], `${key}@api-keys-e2e.test`],
    );
    ids[key] = account.id;
    return account.id;
  }

  /**
   * Siembra un permiso propio de la prueba, para poder borrarlo sin tocar el catálogo sembrado
   * por las migraciones.
   *
   * @param key - Nombre con el que la prueba se refiere al permiso.
   * @returns El `permissions.id` creado.
   *
   * @example
   * ```ts
   * await seedPermission('read');
   * ```
   */
  async function seedPermission(key: string): Promise<string> {
    const [resource] = await dataSource.query(
      `INSERT INTO resources (key, description) VALUES ($1, 'E2E') RETURNING id`,
      [`API_KEY_E2E_${key.toUpperCase()}`],
    );
    const [action] = await dataSource.query(
      `INSERT INTO actions (key, description) VALUES ($1, 'E2E') RETURNING id`,
      [`API_KEY_E2E_${key.toUpperCase()}`],
    );
    const [permission] = await dataSource.query(
      `INSERT INTO permissions (resource_id, action_id, scope) VALUES ($1, $2, 'ANY') RETURNING id`,
      [resource.id, action.id],
    );
    ids[`permission:${key}`] = permission.id;
    return permission.id;
  }

  /**
   * Guarda una llave con valores de relleno; `overrides` fija lo que la prueba necesita.
   *
   * @param overrides - Campos de la llave que difieren del relleno.
   * @returns La llave guardada.
   *
   * @throws {QueryFailedError} Si la fila viola alguna restricción de `api_keys`.
   *
   * @example
   * ```ts
   * await saveApiKey({ organizationId: ids['org:org1'], createdByAccountId: ids['org1-ana'] });
   * ```
   */
  async function saveApiKey(
    overrides: Partial<ApiKeyEntity> &
      Pick<ApiKeyEntity, 'organizationId' | 'createdByAccountId'>,
  ): Promise<ApiKeyEntity> {
    const suffix = Math.random().toString(36).slice(2, 10);
    return apiKeys.save(
      apiKeys.create({
        publicId: `pk_${suffix}`,
        keyPrefix: `sk_${suffix.slice(0, 4)}`,
        secretHash: `hash_${suffix}`,
        name: 'Integración ERP',
        ...overrides,
      }),
    );
  }

  /**
   * Espera que la promesa falle por una restricción concreta de Postgres.
   *
   * @param promise - Operación que debe fallar.
   * @param code - SQLSTATE esperado (`23505` unicidad, `23503` llave foránea, `23514` check).
   * @param constraint - Nombre de la restricción violada.
   * @returns Nada.
   *
   * @example
   * ```ts
   * await expectViolation(saveApiKey(...), '23505', 'UQ_api_keys_public_id');
   * ```
   */
  async function expectViolation(
    promise: Promise<unknown>,
    code: string,
    constraint: string,
  ): Promise<void> {
    const error = await promise.then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(QueryFailedError);
    expect(
      (error as QueryFailedError & { driverError: unknown }).driverError,
    ).toMatchObject({ code, constraint });
  }

  beforeAll(async () => {
    await adminQuery(`CREATE DATABASE "${DATABASE_NAME}"`);

    dataSource = new DataSource({
      type: 'postgres',
      url: databaseUrl,
      entities: [join(__dirname, '..', 'src', '**', '*.entity{.ts,.js}')],
      migrations: [join(__dirname, '..', 'src', 'migrations', '*{.ts,.js}')],
      migrationsTransactionMode: 'each',
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    apiKeys = dataSource.getRepository(ApiKeyEntity);

    await seedOrganization('org1');
    await seedOrganization('org2');
    await seedMember('org1-ana', 'org1');
    await seedMember('org1-beto', 'org1');
    await seedMember('org2-carla', 'org2');
    await seedPermission('read');
    await seedPermission('write');
  }, 180_000);

  afterAll(async () => {
    await dataSource?.destroy();
    await adminQuery(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DATABASE_NAME}' AND pid <> pg_backend_pid()`,
    );
    await adminQuery(`DROP DATABASE IF EXISTS "${DATABASE_NAME}"`);
  });

  afterEach(async () => {
    await dataSource.query(`DELETE FROM api_keys`);
  });

  describe('relaciones', () => {
    it('carga organización, autor, revocador y permisos desde la llave', async () => {
      const permissions = await dataSource
        .getRepository(PermissionEntity)
        .findBy([
          { id: ids['permission:read'] },
          { id: ids['permission:write'] },
        ]);
      const saved = await saveApiKey({
        organizationId: ids['org:org1'],
        createdByAccountId: ids['org1-ana'],
        status: ApiKeyStatusEnum.REVOKED,
        revokedAt: new Date(),
        revokedByAccountId: ids['org1-beto'],
        permissions,
      });

      const loaded = await apiKeys.findOneOrFail({
        where: { id: saved.id },
        relations: {
          organization: true,
          createdByAccount: true,
          revokedByAccount: true,
          permissions: true,
        },
      });

      expect(loaded.organization.id).toBe(ids['org:org1']);
      expect(loaded.createdByAccount.id).toBe(ids['org1-ana']);
      expect(loaded.revokedByAccount?.id).toBe(ids['org1-beto']);
      expect(
        loaded.permissions.map((permission) => permission.id).sort(),
      ).toEqual([ids['permission:read'], ids['permission:write']].sort());
      expect(loaded).toMatchObject({
        status: ApiKeyStatusEnum.REVOKED,
        lastUsedAt: null,
        expiresAt: null,
      });
    });

    it('una llave nueva nace ACTIVE y sin datos de revocación', async () => {
      const saved = await saveApiKey({
        organizationId: ids['org:org1'],
        createdByAccountId: ids['org1-ana'],
      });

      const loaded = await apiKeys.findOneByOrFail({ id: saved.id });
      expect(loaded).toMatchObject({
        status: ApiKeyStatusEnum.ACTIVE,
        revokedAt: null,
        revokedByAccountId: null,
      });
      expect(loaded.createdAt).toBeInstanceOf(Date);
    });

    it('navega desde organización, membresías y permiso hacia sus llaves', async () => {
      const [permission] = await dataSource
        .getRepository(PermissionEntity)
        .findBy({ id: ids['permission:read'] });
      const saved = await saveApiKey({
        organizationId: ids['org:org1'],
        createdByAccountId: ids['org1-ana'],
        status: ApiKeyStatusEnum.REVOKED,
        revokedAt: new Date(),
        revokedByAccountId: ids['org1-beto'],
        permissions: [permission],
      });

      const organization = await dataSource
        .getRepository(OrganizationEntity)
        .findOneOrFail({
          where: { id: ids['org:org1'] },
          relations: { apiKeys: true },
        });
      const author = await dataSource
        .getRepository(AccountEntity)
        .findOneOrFail({
          where: { id: ids['org1-ana'] },
          relations: { createdApiKeys: true, revokedApiKeys: true },
        });
      const revoker = await dataSource
        .getRepository(AccountEntity)
        .findOneOrFail({
          where: { id: ids['org1-beto'] },
          relations: { createdApiKeys: true, revokedApiKeys: true },
        });
      const withKeys = await dataSource
        .getRepository(PermissionEntity)
        .findOneOrFail({
          where: { id: ids['permission:read'] },
          relations: { apiKeys: true },
        });

      expect(organization.apiKeys.map((apiKey) => apiKey.id)).toEqual([
        saved.id,
      ]);
      expect(author.createdApiKeys.map((apiKey) => apiKey.id)).toEqual([
        saved.id,
      ]);
      expect(author.revokedApiKeys).toEqual([]);
      expect(revoker.createdApiKeys).toEqual([]);
      expect(revoker.revokedApiKeys.map((apiKey) => apiKey.id)).toEqual([
        saved.id,
      ]);
      expect(withKeys.apiKeys.map((apiKey) => apiKey.id)).toEqual([saved.id]);
    });
  });

  describe('unicidad de publicId', () => {
    it('rechaza dos llaves con el mismo publicId, aun en organizaciones distintas', async () => {
      await saveApiKey({
        organizationId: ids['org:org1'],
        createdByAccountId: ids['org1-ana'],
        publicId: 'pk_duplicated',
      });

      await expectViolation(
        saveApiKey({
          organizationId: ids['org:org2'],
          createdByAccountId: ids['org2-carla'],
          publicId: 'pk_duplicated',
        }),
        '23505',
        'UQ_api_keys_public_id',
      );
    });
  });

  describe('una sola llave ACTIVE por organización', () => {
    it('rechaza una segunda llave ACTIVE en la misma organización', async () => {
      await saveApiKey({
        organizationId: ids['org:org1'],
        createdByAccountId: ids['org1-ana'],
      });

      await expectViolation(
        saveApiKey({
          organizationId: ids['org:org1'],
          createdByAccountId: ids['org1-beto'],
        }),
        '23505',
        'uq_api_keys_one_active_per_organization',
      );
    });

    it('cada organización tiene su propia llave ACTIVE', async () => {
      await saveApiKey({
        organizationId: ids['org:org1'],
        createdByAccountId: ids['org1-ana'],
      });

      await expect(
        saveApiKey({
          organizationId: ids['org:org2'],
          createdByAccountId: ids['org2-carla'],
        }),
      ).resolves.toBeDefined();
    });

    it('al revocar la vigente se emite otra y las revocadas quedan como historial', async () => {
      const first = await saveApiKey({
        organizationId: ids['org:org1'],
        createdByAccountId: ids['org1-ana'],
      });
      await apiKeys.update(first.id, {
        status: ApiKeyStatusEnum.REVOKED,
        revokedAt: new Date(),
        revokedByAccountId: ids['org1-beto'],
      });
      const second = await saveApiKey({
        organizationId: ids['org:org1'],
        createdByAccountId: ids['org1-beto'],
      });
      await apiKeys.update(second.id, {
        status: ApiKeyStatusEnum.REVOKED,
        revokedAt: new Date(),
      });
      await saveApiKey({
        organizationId: ids['org:org1'],
        createdByAccountId: ids['org1-ana'],
      });

      const history = await apiKeys.findBy({ organizationId: ids['org:org1'] });
      expect(history.map((apiKey) => apiKey.status).sort()).toEqual([
        ApiKeyStatusEnum.ACTIVE,
        ApiKeyStatusEnum.REVOKED,
        ApiKeyStatusEnum.REVOKED,
      ]);
    });

    it('rechaza reactivar una revocada mientras haya otra ACTIVE', async () => {
      const revoked = await saveApiKey({
        organizationId: ids['org:org1'],
        createdByAccountId: ids['org1-ana'],
        status: ApiKeyStatusEnum.REVOKED,
        revokedAt: new Date(),
      });
      await saveApiKey({
        organizationId: ids['org:org1'],
        createdByAccountId: ids['org1-ana'],
      });

      await expectViolation(
        apiKeys.update(revoked.id, {
          status: ApiKeyStatusEnum.ACTIVE,
          revokedAt: null,
        }),
        '23505',
        'uq_api_keys_one_active_per_organization',
      );
    });
  });

  describe('coherencia de la revocación y el vencimiento', () => {
    it('rechaza una llave REVOKED sin revokedAt', async () => {
      await expectViolation(
        saveApiKey({
          organizationId: ids['org:org1'],
          createdByAccountId: ids['org1-ana'],
          status: ApiKeyStatusEnum.REVOKED,
        }),
        '23514',
        'CHK_api_keys_revocation',
      );
    });

    it('rechaza una llave ACTIVE con datos de revocación', async () => {
      await expectViolation(
        saveApiKey({
          organizationId: ids['org:org1'],
          createdByAccountId: ids['org1-ana'],
          revokedAt: new Date(),
          revokedByAccountId: ids['org1-beto'],
        }),
        '23514',
        'CHK_api_keys_revocation',
      );
    });

    it('rechaza un vencimiento anterior a la creación', async () => {
      await expectViolation(
        saveApiKey({
          organizationId: ids['org:org1'],
          createdByAccountId: ids['org1-ana'],
          expiresAt: new Date('2000-01-01T00:00:00Z'),
        }),
        '23514',
        'CHK_api_keys_expiry',
      );
    });
  });

  describe('reglas de borrado', () => {
    it('borrar la llave borra sus permisos en la pivote, no los permisos', async () => {
      const [permission] = await dataSource
        .getRepository(PermissionEntity)
        .findBy({ id: ids['permission:write'] });
      const saved = await saveApiKey({
        organizationId: ids['org:org1'],
        createdByAccountId: ids['org1-ana'],
        permissions: [permission],
      });

      await apiKeys.delete(saved.id);

      const [{ count }] = await dataSource.query(
        `SELECT count(*)::int AS count FROM api_key_permissions WHERE api_key_id = $1`,
        [saved.id],
      );
      expect(count).toBe(0);
      await expect(
        dataSource
          .getRepository(PermissionEntity)
          .existsBy({ id: ids['permission:write'] }),
      ).resolves.toBe(true);
    });

    it('no deja borrar un permiso asignado a una llave', async () => {
      const [permission] = await dataSource
        .getRepository(PermissionEntity)
        .findBy({ id: ids['permission:write'] });
      await saveApiKey({
        organizationId: ids['org:org1'],
        createdByAccountId: ids['org1-ana'],
        permissions: [permission],
      });

      await expectViolation(
        dataSource.query(`DELETE FROM permissions WHERE id = $1`, [
          ids['permission:write'],
        ]),
        '23503',
        'FK_api_key_permissions_permission_id',
      );
    });

    it('no deja borrar la membresía que emitió una llave', async () => {
      await saveApiKey({
        organizationId: ids['org:org2'],
        createdByAccountId: ids['org2-carla'],
      });

      await expectViolation(
        dataSource.query(`DELETE FROM accounts WHERE id = $1`, [
          ids['org2-carla'],
        ]),
        '23503',
        'FK_api_keys_created_by_account_id',
      );
    });

    it('borrar la organización borra sus llaves junto con sus membresías', async () => {
      await seedOrganization('org3');
      await seedMember('org3-dario', 'org3');
      const saved = await saveApiKey({
        organizationId: ids['org:org3'],
        createdByAccountId: ids['org3-dario'],
      });

      await dataSource.query(`DELETE FROM organizations WHERE id = $1`, [
        ids['org:org3'],
      ]);

      await expect(apiKeys.existsBy({ id: saved.id })).resolves.toBe(false);
    });
  });

  describe('migración', () => {
    it('se revierte y se vuelve a aplicar', async () => {
      const objects = () =>
        dataSource.query(
          `SELECT to_regclass('api_keys') AS keys, to_regclass('api_key_permissions') AS pivot,
                  (SELECT count(*)::int FROM pg_type WHERE typname = 'api_key_status_enum') AS enum`,
        );

      // Revierte también las migraciones posteriores (p. ej. `AddApiKeyManagePermission`), que
      // se aplicaron después y tienen que salir antes.
      const isApplied = async () =>
        (
          await dataSource.query(
            `SELECT 1 FROM migrations WHERE name = 'CreateApiKeys1784300000077'`,
          )
        ).length > 0;
      while (await isApplied()) {
        await dataSource.undoLastMigration({ transaction: 'each' });
      }
      await expect(objects()).resolves.toEqual([
        { keys: null, pivot: null, enum: 0 },
      ]);

      await dataSource.runMigrations({ transaction: 'each' });
      await expect(objects()).resolves.toEqual([
        { keys: 'api_keys', pivot: 'api_key_permissions', enum: 1 },
      ]);
    });
  });
});
