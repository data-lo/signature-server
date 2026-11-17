import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { config } from 'dotenv';
import { join } from 'path';
import { Client } from 'pg';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { ApiKeyModule } from './../src/api-key/api-key.module';
import { JwtAuthGuard } from './../src/auth/guards/jwt-auth.guard';
import { AuthorizationModule } from './../src/authorization/authorization.module';
import { applyGlobalApiPrefix } from './../src/common/constants/api-prefix.constants';
import { RedisService } from './../src/common/redis/redis.service';
import { IntegrationSettingsModule } from './../src/integration-settings/integration-settings.module';
import { AddWebhooksEnabledToIntegrationSettings1784300000096 } from './../src/migrations/1784300000096-AddWebhooksEnabledToIntegrationSettings';

config({ path: join(__dirname, '..', '.env') });

const JWT_SECRET = 'jwt-secret-de-la-e2e-de-integration-api-settings';
const INTEGRATION_API_KEY_HMAC_SECRET =
  'secret-hmac-de-la-e2e-de-integration-api-settings-con-mas-de-32-caracteres';
const SETTINGS_URL = '/api/v1/integration/settings';

/** Ruta administrativa (JWT) del interruptor `status` de la misma fila. */
const adminSettingsUrl = (organizationId: string) =>
  `/api/v1/organizations/${organizationId}/integration-settings`;

@Module({
  imports: [JwtModule.register({ secret: JWT_SECRET })],
  providers: [
    {
      provide: RedisService,
      useValue: { exists: async () => false, get: async () => null },
    },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
class E2eJwtModule {}

describe('Configuración de integración desde la Integration API (e2e)', () => {
  const DATABASE_NAME = `signature_integration_api_settings_e2e_${process.pid}_${Date.now()}`;
  const baseUrl = process.env.POSTGRES_DB_URL as string;
  const adminUrl = baseUrl.replace(/\/[^/?]+(\?.*)?$/, '/postgres$1');
  const databaseUrl = baseUrl.replace(
    /\/[^/?]+(\?.*)?$/,
    `/${DATABASE_NAME}$1`,
  );

  const ids: Record<string, string> = {};

  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;

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
      [`Org ${key} ${randomUUID()}`],
    );
    ids[`org:${key}`] = organization.id;
  }

  async function seedOwner(userKey: string, organizationKey: string) {
    const [info] = await dataSource.query(
      `INSERT INTO personal_information (name, last_name, curp) VALUES ($1, 'E2E', $2) RETURNING id`,
      [userKey, `CURP${userKey}`.slice(0, 18)],
    );
    const [user] = await dataSource.query(
      `INSERT INTO users (first_name, last_name, email, roles, national_id, password, personal_information_id)
       VALUES ($1, 'E2E', $2, 'user', $3, 'x', $4) RETURNING id`,
      [
        userKey,
        `${userKey}@integration-settings.test`,
        `NID${userKey}`,
        info.id,
      ],
    );
    await dataSource.query(
      `INSERT INTO accounts (user_id, account_type, organization_id, role_id, email, password, is_active)
       SELECT $1, 'ORGANIZATION', $2, r.id, $3, 'x', true FROM roles r WHERE r.name = 'OWNER' AND r.is_system_role = true`,
      [
        user.id,
        ids[`org:${organizationKey}`],
        `${userKey}@integration-settings.test`,
      ],
    );
    ids[`user:${userKey}`] = user.id;
  }

  async function permissionId(resource: string, action: string) {
    const [row] = await dataSource.query(
      `SELECT p.id FROM permissions p
       JOIN resources r ON r.id = p.resource_id JOIN actions a ON a.id = p.action_id
       WHERE r.key = $1 AND a.key = $2 AND p.scope = 'ANY'`,
      [resource, action],
    );
    return row?.id as string | undefined;
  }

  function as(userKey: string): Record<string, string> {
    const token = jwtService.sign({
      sub: ids[`user:${userKey}`],
      email: `${userKey}@integration-settings.test`,
      roles: 'user',
      nationalId: `NID${userKey}`,
      jti: randomUUID(),
    });
    return { Authorization: `Bearer ${token}` };
  }

  /** Emite la llave de la organización con los permisos dados y devuelve la llave en claro. */
  async function issueKey(
    organizationKey: string,
    owner: string,
    permissions: string[],
  ): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/organizations/${ids[`org:${organizationKey}`]}/api-keys`)
      .set(as(owner))
      .send({
        name: 'Integración ERP',
        permissionIds: permissions.map((key) => ids[`permission:${key}`]),
      })
      .expect(201);
    return response.body.data.key;
  }

  async function settingsRows(organizationKey: string) {
    return dataSource.query(
      `SELECT status, webhooks_enabled, updated_at FROM integration_settings WHERE organization_id = $1`,
      [ids[`org:${organizationKey}`]],
    );
  }

  /**
   * `webhooks_enabled` guardado, o `null` sin fila. Emitir la primera llave ya crea la fila
   * (`ensureInitialIntegrationSettings`), con `false`.
   */
  async function webhooksEnabledOf(organizationKey: string) {
    const [row] = await settingsRows(organizationKey);
    return (row?.webhooks_enabled ?? null) as boolean | null;
  }

  /** Cambia el `status` por la ruta administrativa, como lo haría un miembro con `API_KEY.MANAGE`. */
  function setStatusAsAdmin(
    organizationKey: string,
    owner: string,
    status: 'ACTIVE' | 'DISABLED',
  ) {
    return request(app.getHttpServer())
      .patch(adminSettingsUrl(ids[`org:${organizationKey}`]))
      .set(as(owner))
      .send({ status })
      .expect(200);
  }

  function getSettings(key: string) {
    return request(app.getHttpServer()).get(SETTINGS_URL).set('X-API-Key', key);
  }

  function patchSettings(key: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .patch(SETTINGS_URL)
      .set('X-API-Key', key)
      .send(body);
  }

  beforeAll(async () => {
    process.env.INTEGRATION_API_KEY_HMAC_SECRET =
      INTEGRATION_API_KEY_HMAC_SECRET;
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

    await seedOrganization('org1');
    await seedOrganization('org2');
    await seedOwner('ana', 'org1');
    await seedOwner('eva', 'org2');
    for (const [key, resource, action] of [
      ['settings-read', 'INTEGRATION_SETTINGS', 'READ'],
      ['settings-update', 'INTEGRATION_SETTINGS', 'UPDATE'],
      ['document-create', 'DOCUMENT', 'CREATE'],
    ]) {
      ids[`permission:${key}`] = (await permissionId(resource, action))!;
    }

    @Module({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          url: databaseUrl,
          entities: [join(__dirname, '..', 'src', '**', '*.entity{.ts,.js}')],
        }),
        E2eJwtModule,
        AuthorizationModule,
        ApiKeyModule,
        IntegrationSettingsModule,
      ],
    })
    class IntegrationApiSettingsE2eModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [IntegrationApiSettingsE2eModule],
    }).compile();

    app = moduleRef.createNestApplication();
    applyGlobalApiPrefix(app);
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    jwtService = app.get(JwtService);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await dataSource?.destroy();
    await adminQuery(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DATABASE_NAME}' AND pid <> pg_backend_pid()`,
    );
    await adminQuery(`DROP DATABASE IF EXISTS "${DATABASE_NAME}"`);
  });

  afterEach(async () => {
    await dataSource.query(`DELETE FROM api_keys`);
    await dataSource.query(`DELETE FROM integration_settings`);
  });

  describe('migración', () => {
    it('deja las configuraciones existentes con webhooks desactivados y conserva su status', async () => {
      await dataSource.query(
        `INSERT INTO integration_settings (organization_id, status) VALUES ($1, 'DISABLED')`,
        [ids['org:org1']],
      );
      await dataSource.query(
        `INSERT INTO integration_settings (organization_id, webhooks_enabled) VALUES ($1, true)`,
        [ids['org:org2']],
      );

      const migration =
        new AddWebhooksEnabledToIntegrationSettings1784300000096();
      const queryRunner = dataSource.createQueryRunner();
      try {
        await migration.down(queryRunner);
        await migration.up(queryRunner);
      } finally {
        await queryRunner.release();
      }
      for (const [key, resource, action] of [
        ['settings-read', 'INTEGRATION_SETTINGS', 'READ'],
        ['settings-update', 'INTEGRATION_SETTINGS', 'UPDATE'],
      ]) {
        ids[`permission:${key}`] = (await permissionId(resource, action))!;
      }

      expect(await settingsRows('org1')).toEqual([
        expect.objectContaining({
          status: 'DISABLED',
          webhooks_enabled: false,
        }),
      ]);
      expect(await settingsRows('org2')).toEqual([
        expect.objectContaining({ status: 'ACTIVE', webhooks_enabled: false }),
      ]);
      const [{ count }] = await dataSource.query(
        `SELECT count(*)::int AS count FROM integration_settings`,
      );
      expect(count).toBe(2);
    });

    it('siembra INTEGRATION_SETTINGS.READ y UPDATE para OWNER y ADMIN, no para MEMBER', async () => {
      const rows: Array<{ role: string; action: string }> =
        await dataSource.query(
          `SELECT ro.name AS role, a.key AS action
           FROM role_permissions rp
           JOIN roles ro ON ro.id = rp.role_id AND ro.is_system_role = true
           JOIN permissions p ON p.id = rp.permission_id
           JOIN resources r ON r.id = p.resource_id
           JOIN actions a ON a.id = p.action_id
           WHERE r.key = 'INTEGRATION_SETTINGS'
           ORDER BY ro.name, a.key`,
        );

      expect(rows).toEqual([
        { role: 'ADMIN', action: 'READ' },
        { role: 'ADMIN', action: 'UPDATE' },
        { role: 'OWNER', action: 'READ' },
        { role: 'OWNER', action: 'UPDATE' },
      ]);
    });

    it('admite una sola configuración por organización y la borra con ella', async () => {
      await seedOrganization('to-delete');
      await dataSource.query(
        `INSERT INTO integration_settings (organization_id) VALUES ($1)`,
        [ids['org:to-delete']],
      );

      await expect(
        dataSource.query(
          `INSERT INTO integration_settings (organization_id, webhooks_enabled) VALUES ($1, true)`,
          [ids['org:to-delete']],
        ),
      ).rejects.toThrow(/UQ_integration_settings_organization_id/);
      const [row] = await settingsRows('to-delete');
      expect(row.webhooks_enabled).toBe(false);

      await dataSource.query(`DELETE FROM organizations WHERE id = $1`, [
        ids['org:to-delete'],
      ]);
      expect(await settingsRows('to-delete')).toEqual([]);
    });
  });

  describe('consulta y actualización', () => {
    it('la configuración que nace con la primera llave tiene webhooksEnabled: false', async () => {
      const key = await issueKey('org1', 'ana', ['settings-read']);

      const response = await getSettings(key).expect(200);

      expect(response.body).toEqual({
        success: true,
        data: { webhooksEnabled: false },
      });
      expect(await settingsRows('org1')).toEqual([
        expect.objectContaining({ status: 'ACTIVE', webhooks_enabled: false }),
      ]);
    });

    it('sin fila GET devuelve webhooksEnabled: false sin crearla', async () => {
      const key = await issueKey('org1', 'ana', ['settings-read']);
      await dataSource.query(
        `DELETE FROM integration_settings WHERE organization_id = $1`,
        [ids['org:org1']],
      );

      const response = await getSettings(key).expect(200);

      expect(response.body.data).toEqual({ webhooksEnabled: false });
      expect(await settingsRows('org1')).toEqual([]);
    });

    it('PATCH activa y desactiva, y GET refleja el valor', async () => {
      const key = await issueKey('org1', 'ana', [
        'settings-read',
        'settings-update',
      ]);

      const enabled = await patchSettings(key, {
        webhooksEnabled: true,
      }).expect(200);
      expect(enabled.body).toEqual({
        success: true,
        data: { webhooksEnabled: true },
      });
      expect((await getSettings(key).expect(200)).body.data).toEqual({
        webhooksEnabled: true,
      });

      await patchSettings(key, { webhooksEnabled: false }).expect(200);
      expect((await getSettings(key).expect(200)).body.data).toEqual({
        webhooksEnabled: false,
      });
    });

    it('PATCH crea la fila ACTIVE si no existe', async () => {
      const key = await issueKey('org1', 'ana', ['settings-update']);
      await dataSource.query(
        `DELETE FROM integration_settings WHERE organization_id = $1`,
        [ids['org:org1']],
      );

      await patchSettings(key, { webhooksEnabled: true }).expect(200);

      expect(await settingsRows('org1')).toEqual([
        expect.objectContaining({ status: 'ACTIVE', webhooks_enabled: true }),
      ]);
    });

    it('repetir el mismo PATCH no crea filas ni cambia updated_at', async () => {
      const key = await issueKey('org1', 'ana', ['settings-update']);

      await patchSettings(key, { webhooksEnabled: true }).expect(200);
      const [before] = await settingsRows('org1');
      await patchSettings(key, { webhooksEnabled: true }).expect(200);
      const rows = await settingsRows('org1');

      expect(rows).toHaveLength(1);
      expect(rows[0].updated_at).toEqual(before.updated_at);
    });

    it.each([
      ['falta webhooksEnabled', {}],
      ['webhooksEnabled no es booleano', { webhooksEnabled: 'yes' }],
      [
        'trae una URL',
        { webhooksEnabled: true, url: 'https://cliente.example' },
      ],
      ['trae un secreto', { webhooksEnabled: true, secret: 'whsec_x' }],
      [
        'trae el status administrativo',
        { webhooksEnabled: true, status: 'DISABLED' },
      ],
    ])('rechaza con 422 INVALID_REQUEST cuando %s', async (_label, body) => {
      const key = await issueKey('org1', 'ana', ['settings-update']);

      const response = await patchSettings(key, body).expect(422);

      expect(response.body.error.code).toBe('INVALID_REQUEST');
      expect(await settingsRows('org1')).toEqual([
        expect.objectContaining({ status: 'ACTIVE', webhooks_enabled: false }),
      ]);
    });
  });

  describe('autorización', () => {
    it('sin X-API-Key responde 401', async () => {
      await request(app.getHttpServer()).get(SETTINGS_URL).expect(401);
      await request(app.getHttpServer())
        .patch(SETTINGS_URL)
        .send({ webhooksEnabled: true })
        .expect(401);
    });

    it('una llave que sólo crea documentos no puede consultar ni cambiar la configuración', async () => {
      const key = await issueKey('org1', 'ana', ['document-create']);

      const read = await getSettings(key).expect(403);
      const write = await patchSettings(key, { webhooksEnabled: true }).expect(
        403,
      );

      expect(read.body.error.code).toBe('API_KEY_PERMISSION_DENIED');
      expect(write.body.error.code).toBe('API_KEY_PERMISSION_DENIED');
      expect(await webhooksEnabledOf('org1')).toBe(false);
    });

    it('READ sin UPDATE consulta pero no modifica', async () => {
      const key = await issueKey('org1', 'ana', ['settings-read']);

      await getSettings(key).expect(200);
      const response = await patchSettings(key, {
        webhooksEnabled: true,
      }).expect(403);

      expect(response.body.error.message).toContain(
        'INTEGRATION_SETTINGS.UPDATE',
      );
      expect(await webhooksEnabledOf('org1')).toBe(false);
    });

    it('UPDATE sin READ modifica pero no consulta', async () => {
      const key = await issueKey('org1', 'ana', ['settings-update']);

      await patchSettings(key, { webhooksEnabled: true }).expect(200);
      await getSettings(key).expect(403);
    });

    it('rechaza un organizationId en el cuerpo o el query con 400 INTEGRATION_TENANT_OVERRIDE_NOT_ALLOWED', async () => {
      const key = await issueKey('org1', 'ana', [
        'settings-read',
        'settings-update',
      ]);

      const write = await patchSettings(key, {
        webhooksEnabled: true,
        organizationId: ids['org:org2'],
      }).expect(400);
      const read = await request(app.getHttpServer())
        .get(`${SETTINGS_URL}?organizationId=${ids['org:org2']}`)
        .set('X-API-Key', key)
        .expect(400);

      expect(write.body.error.code).toBe(
        'INTEGRATION_TENANT_OVERRIDE_NOT_ALLOWED',
      );
      expect(read.body.error.code).toBe(
        'INTEGRATION_TENANT_OVERRIDE_NOT_ALLOWED',
      );
      expect(await webhooksEnabledOf('org1')).toBe(false);
      expect(await settingsRows('org2')).toEqual([]);
    });
  });

  describe('aislamiento y API keys', () => {
    it('cada llave sólo ve y cambia la configuración de su organización', async () => {
      const permissions = ['settings-read', 'settings-update'];
      const key1 = await issueKey('org1', 'ana', permissions);
      const key2 = await issueKey('org2', 'eva', permissions);

      await patchSettings(key1, { webhooksEnabled: true }).expect(200);

      expect((await getSettings(key2).expect(200)).body.data).toEqual({
        webhooksEnabled: false,
      });
      expect(await webhooksEnabledOf('org2')).toBe(false);

      await patchSettings(key2, { webhooksEnabled: false }).expect(200);
      expect((await getSettings(key1).expect(200)).body.data).toEqual({
        webhooksEnabled: true,
      });
    });

    it('rotar la llave conserva la configuración de la organización', async () => {
      const oldKey = await issueKey('org1', 'ana', [
        'settings-read',
        'settings-update',
      ]);
      await patchSettings(oldKey, { webhooksEnabled: true }).expect(200);

      const rotated = await request(app.getHttpServer())
        .post(`/api/v1/organizations/${ids['org:org1']}/api-keys/rotate`)
        .set(as('ana'))
        .send({})
        .expect(201);
      const newKey: string = rotated.body.data.key;

      await getSettings(oldKey).expect(401);
      expect((await getSettings(newKey).expect(200)).body.data).toEqual({
        webhooksEnabled: true,
      });
      expect(await settingsRows('org1')).toHaveLength(1);
    });
  });
  describe('convivencia con el interruptor administrativo', () => {
    it('cambiar webhooksEnabled no toca el status', async () => {
      const key = await issueKey('org1', 'ana', ['settings-update']);

      await patchSettings(key, { webhooksEnabled: true }).expect(200);

      expect(await settingsRows('org1')).toEqual([
        expect.objectContaining({ status: 'ACTIVE', webhooks_enabled: true }),
      ]);
    });

    it('desactivar la integración bloquea la llave sin perder webhooksEnabled, y reactivarla lo conserva', async () => {
      const key = await issueKey('org1', 'ana', [
        'settings-read',
        'settings-update',
      ]);
      await patchSettings(key, { webhooksEnabled: true }).expect(200);

      const disabled = await setStatusAsAdmin('org1', 'ana', 'DISABLED');
      expect(disabled.body.data.status).toBe('DISABLED');

      const blocked = await getSettings(key).expect(403);
      expect(blocked.body.error.code).toBe('INTEGRATION_DISABLED');
      await patchSettings(key, { webhooksEnabled: false }).expect(403);
      expect(await settingsRows('org1')).toEqual([
        expect.objectContaining({ status: 'DISABLED', webhooks_enabled: true }),
      ]);

      await setStatusAsAdmin('org1', 'ana', 'ACTIVE');
      expect((await getSettings(key).expect(200)).body.data).toEqual({
        webhooksEnabled: true,
      });
    });

    it('la respuesta administrativa conserva su forma, sin webhooksEnabled', async () => {
      await issueKey('org1', 'ana', ['settings-read']);

      const response = await request(app.getHttpServer())
        .get(adminSettingsUrl(ids['org:org1']))
        .set(as('ana'))
        .expect(200);

      expect(Object.keys(response.body.data).sort()).toEqual(
        ['createdAt', 'organizationId', 'status', 'updatedAt'].sort(),
      );
    });
  });
});
