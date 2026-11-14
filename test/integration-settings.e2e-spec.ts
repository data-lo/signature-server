import {
  Controller,
  Get,
  INestApplication,
  Module,
  UseFilters,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
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
import { OrganizationApiKeyGuard } from './../src/api-key/guards/organization-api-key.guard';
import { SkipJwtAuth } from './../src/auth/decorators/skip-jwt-auth.decorator';
import { JwtAuthGuard } from './../src/auth/guards/jwt-auth.guard';
import { AuthorizationModule } from './../src/authorization/authorization.module';
import { applyGlobalApiPrefix } from './../src/common/constants/api-prefix.constants';
import { RedisService } from './../src/common/redis/redis.service';
import { IntegrationErrorFilter } from './../src/document/integration/filters/integration-error.filter';
import { IntegrationSettingsModule } from './../src/integration-settings/integration-settings.module';
import { CreateIntegrationSettings1784300000095 } from './../src/migrations/1784300000095-CreateIntegrationSettings';
import { AddWebhooksEnabledToIntegrationSettings1784300000096 } from './../src/migrations/1784300000096-AddWebhooksEnabledToIntegrationSettings';

config({ path: join(__dirname, '..', '.env') });

const JWT_SECRET = 'jwt-secret-de-la-e2e-de-integration-settings';
const INTEGRATION_API_KEY_HMAC_SECRET =
  'secret-hmac-de-la-e2e-de-integration-settings-con-mas-de-32-caracteres';

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

/**
 * Ruta mínima protegida por `OrganizationApiKeyGuard` y con el filtro de errores de la API de
 * integración: es lo que comparten todos los controllers de `/integration/...`.
 */
@SkipJwtAuth()
@UseGuards(OrganizationApiKeyGuard)
@UseFilters(IntegrationErrorFilter)
@Controller('integration/e2e-ping')
class IntegrationPingController {
  @Get()
  ping() {
    return { success: true };
  }
}

@Module({ imports: [ApiKeyModule], controllers: [IntegrationPingController] })
class IntegrationPingModule {}

describe('Configuración de integración por organización (e2e)', () => {
  const DATABASE_NAME = `signature_integration_settings_e2e_${process.pid}_${Date.now()}`;
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

  async function seedOrganization(key: string): Promise<string> {
    const [organization] = await dataSource.query(
      `INSERT INTO organizations (name, display_name) VALUES ($1, $1) RETURNING id`,
      [`Org ${key} ${randomUUID()}`],
    );
    ids[`org:${key}`] = organization.id;
    return organization.id;
  }

  async function seedMember(
    userKey: string,
    organizationKey: string,
    roleName: 'OWNER' | 'ADMIN' | 'MEMBER',
    isActive = true,
  ): Promise<void> {
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
       SELECT $1, 'ORGANIZATION', $2, r.id, $3, 'x', $5 FROM roles r WHERE r.name = $4 AND r.is_system_role = true`,
      [
        user.id,
        ids[`org:${organizationKey}`],
        `${userKey}@integration-settings.test`,
        roleName,
        isActive,
      ],
    );
    ids[`user:${userKey}`] = user.id;
  }

  /** Inserta una llave directamente, como las que existían antes de la migración. */
  async function seedRawApiKey(
    organizationKey: string,
    status: 'ACTIVE' | 'REVOKED',
  ): Promise<void> {
    const publicId = randomUUID().replace(/-/g, '').slice(0, 16);
    await dataSource.query(
      `INSERT INTO api_keys (organization_id, public_id, key_prefix, secret_hash, name, status, revoked_at)
       VALUES ($1, $2, $3, $4, 'Llave previa', $5, $6)`,
      [
        ids[`org:${organizationKey}`],
        publicId,
        `fma_live_${publicId}`,
        'a'.repeat(64),
        status,
        status === 'REVOKED' ? new Date() : null,
      ],
    );
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

  function settingsUrl(organizationKey: string): string {
    return `/api/v1/organizations/${ids[`org:${organizationKey}`]}/integration-settings`;
  }

  async function settingsRows(organizationKey: string) {
    return dataSource.query(
      `SELECT status, created_at, updated_at FROM integration_settings WHERE organization_id = $1`,
      [ids[`org:${organizationKey}`]],
    );
  }

  /** Emite la llave de la organización por la API administrativa y devuelve la llave en claro. */
  async function issueKey(organizationKey: string, owner: string) {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/organizations/${ids[`org:${organizationKey}`]}/api-keys`)
      .set(as(owner))
      .send({
        name: 'Integración ERP',
        permissionIds: [ids['permission:directory-read']],
      })
      .expect(201);
    return response.body.data as { id: string; key: string };
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
    await seedMember('ana', 'org1', 'OWNER');
    await seedMember('beto', 'org1', 'ADMIN');
    await seedMember('carla', 'org1', 'MEMBER');
    await seedMember('dario', 'org1', 'ADMIN', false);
    await seedMember('eva', 'org2', 'OWNER');
    const [permission] = await dataSource.query(
      `SELECT p.id FROM permissions p
       JOIN resources r ON r.id = p.resource_id JOIN actions a ON a.id = p.action_id
       WHERE r.key = 'DIRECTORY' AND a.key = 'READ' AND p.scope = 'ANY'`,
    );
    ids['permission:directory-read'] = permission.id;

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
        IntegrationPingModule,
      ],
    })
    class IntegrationSettingsE2eModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [IntegrationSettingsE2eModule],
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
    it('da configuración ACTIVE a las organizaciones con llaves (activas o revocadas) y no a las demás', async () => {
      await seedOrganization('legacy-active');
      await seedOrganization('legacy-revoked');
      await seedOrganization('legacy-none');
      await seedRawApiKey('legacy-active', 'ACTIVE');
      await seedRawApiKey('legacy-revoked', 'REVOKED');
      await seedRawApiKey('legacy-revoked', 'REVOKED');

      // La 096 agrega una columna a esta tabla: se revierte antes y se reaplica después, como haría
      // `migration:revert` en orden inverso.
      const migration = new CreateIntegrationSettings1784300000095();
      const webhooksMigration =
        new AddWebhooksEnabledToIntegrationSettings1784300000096();
      const queryRunner = dataSource.createQueryRunner();
      try {
        await webhooksMigration.down(queryRunner);
        await migration.down(queryRunner);
        await migration.up(queryRunner);
        await webhooksMigration.up(queryRunner);
      } finally {
        await queryRunner.release();
      }

      expect(await settingsRows('legacy-active')).toEqual([
        expect.objectContaining({ status: 'ACTIVE' }),
      ]);
      expect(await settingsRows('legacy-revoked')).toEqual([
        expect.objectContaining({ status: 'ACTIVE' }),
      ]);
      expect(await settingsRows('legacy-none')).toEqual([]);
    });

    it('admite una sola configuración por organización', async () => {
      await dataSource.query(
        `INSERT INTO integration_settings (organization_id) VALUES ($1)`,
        [ids['org:org1']],
      );

      await expect(
        dataSource.query(
          `INSERT INTO integration_settings (organization_id, status) VALUES ($1, 'DISABLED')`,
          [ids['org:org1']],
        ),
      ).rejects.toThrow(/UQ_integration_settings_organization_id/);
    });

    it('borra la configuración con la organización', async () => {
      await seedOrganization('to-delete');
      await dataSource.query(
        `INSERT INTO integration_settings (organization_id) VALUES ($1)`,
        [ids['org:to-delete']],
      );

      await dataSource.query(`DELETE FROM organizations WHERE id = $1`, [
        ids['org:to-delete'],
      ]);

      expect(await settingsRows('to-delete')).toEqual([]);
    });
  });

  describe('autorización', () => {
    it.each([
      ['OWNER', 'ana'],
      ['ADMIN', 'beto'],
    ])(
      'un %s con API_KEY.MANAGE puede consultar y actualizar',
      async (_role, user) => {
        await request(app.getHttpServer())
          .get(settingsUrl('org1'))
          .set(as(user))
          .expect(200);
        await request(app.getHttpServer())
          .patch(settingsUrl('org1'))
          .set(as(user))
          .send({ status: 'DISABLED' })
          .expect(200);
      },
    );

    it.each([
      ['un MEMBER sin API_KEY.MANAGE', 'carla'],
      ['un ADMIN dado de baja', 'dario'],
      ['el OWNER de otra organización', 'eva'],
    ])('%s recibe 403 y no cambia nada', async (_label, user) => {
      await request(app.getHttpServer())
        .get(settingsUrl('org1'))
        .set(as(user))
        .expect(403);
      await request(app.getHttpServer())
        .patch(settingsUrl('org1'))
        .set(as(user))
        .send({ status: 'DISABLED' })
        .expect(403);

      expect(await settingsRows('org1')).toEqual([]);
    });

    it('sin sesión responde 401', async () => {
      await request(app.getHttpServer()).get(settingsUrl('org1')).expect(401);
    });

    it('ignora un organizationId en el body: sólo cambia la organización de la ruta', async () => {
      await request(app.getHttpServer())
        .patch(settingsUrl('org1'))
        .set(as('ana'))
        .send({ status: 'DISABLED', organizationId: ids['org:org2'] })
        .expect(200);

      expect(await settingsRows('org1')).toEqual([
        expect.objectContaining({ status: 'DISABLED' }),
      ]);
      expect(await settingsRows('org2')).toEqual([]);
    });

    it('rechaza un status inválido con 422 INTEGRATION_SETTINGS_INVALID_BODY', async () => {
      const response = await request(app.getHttpServer())
        .patch(settingsUrl('org1'))
        .set(as('ana'))
        .send({ status: 'PAUSED' })
        .expect(422);

      expect(response.body.code).toBe('INTEGRATION_SETTINGS_INVALID_BODY');
    });
  });

  describe('consulta y actualización', () => {
    it('sin configuración responde ACTIVE sin crear la fila', async () => {
      const response = await request(app.getHttpServer())
        .get(settingsUrl('org1'))
        .set(as('ana'))
        .expect(200);

      expect(response.body.data).toEqual({
        organizationId: ids['org:org1'],
        status: 'ACTIVE',
        createdAt: null,
        updatedAt: null,
      });
      expect(response.body.data).not.toHaveProperty('apiKeys');
      expect(await settingsRows('org1')).toEqual([]);
    });

    it('repetir el mismo estado no crea filas ni cambia updated_at', async () => {
      const first = await request(app.getHttpServer())
        .patch(settingsUrl('org1'))
        .set(as('ana'))
        .send({ status: 'DISABLED' })
        .expect(200);
      const [before] = await settingsRows('org1');

      const second = await request(app.getHttpServer())
        .patch(settingsUrl('org1'))
        .set(as('ana'))
        .send({ status: 'DISABLED' })
        .expect(200);
      const rows = await settingsRows('org1');

      expect(rows).toHaveLength(1);
      expect(rows[0].updated_at).toEqual(before.updated_at);
      expect(second.body.data).toEqual(first.body.data);
    });

    it('cambiar de estado sí actualiza updated_at', async () => {
      await request(app.getHttpServer())
        .patch(settingsUrl('org1'))
        .set(as('ana'))
        .send({ status: 'DISABLED' })
        .expect(200);
      const [before] = await settingsRows('org1');

      const response = await request(app.getHttpServer())
        .patch(settingsUrl('org1'))
        .set(as('ana'))
        .send({ status: 'ACTIVE' })
        .expect(200);
      const [after] = await settingsRows('org1');

      expect(response.body.data.status).toBe('ACTIVE');
      expect(after.updated_at.getTime()).toBeGreaterThan(
        before.updated_at.getTime(),
      );
    });
  });

  describe('compatibilidad con la emisión de llaves', () => {
    it('la primera llave deja la integración ACTIVE', async () => {
      await issueKey('org1', 'ana');

      expect(await settingsRows('org1')).toEqual([
        expect.objectContaining({ status: 'ACTIVE' }),
      ]);
    });

    it('rotar la llave no reactiva una integración DISABLED', async () => {
      await issueKey('org1', 'ana');
      await request(app.getHttpServer())
        .patch(settingsUrl('org1'))
        .set(as('ana'))
        .send({ status: 'DISABLED' })
        .expect(200);

      await request(app.getHttpServer())
        .post(`/api/v1/organizations/${ids['org:org1']}/api-keys/rotate`)
        .set(as('ana'))
        .send({})
        .expect(201);

      expect(await settingsRows('org1')).toEqual([
        expect.objectContaining({ status: 'DISABLED' }),
      ]);
    });
  });

  describe('OrganizationApiKeyGuard', () => {
    function ping(key: string) {
      return request(app.getHttpServer())
        .get('/api/v1/integration/e2e-ping')
        .set('X-API-Key', key);
    }

    it('acepta la llave con la integración ACTIVE', async () => {
      const { key } = await issueKey('org1', 'ana');

      await ping(key).expect(200);
    });

    it('con DISABLED rechaza 403 INTEGRATION_DISABLED sin revocar ni rotar la llave, y al reactivar vuelve a aceptarla', async () => {
      const { id, key } = await issueKey('org1', 'ana');
      const [keyBefore] = await dataSource.query(
        `SELECT status, secret_hash, revoked_at FROM api_keys WHERE id = $1`,
        [id],
      );

      await request(app.getHttpServer())
        .patch(settingsUrl('org1'))
        .set(as('ana'))
        .send({ status: 'DISABLED' })
        .expect(200);

      const rejected = await ping(key).expect(403);
      expect(rejected.body).toEqual({
        success: false,
        error: expect.objectContaining({ code: 'INTEGRATION_DISABLED' }),
      });

      const [keyWhileDisabled] = await dataSource.query(
        `SELECT status, secret_hash, revoked_at FROM api_keys WHERE id = $1`,
        [id],
      );
      expect(keyWhileDisabled).toEqual(keyBefore);
      const [{ count }] = await dataSource.query(
        `SELECT count(*)::int AS count FROM api_keys WHERE organization_id = $1`,
        [ids['org:org1']],
      );
      expect(count).toBe(1);

      await request(app.getHttpServer())
        .patch(settingsUrl('org1'))
        .set(as('ana'))
        .send({ status: 'ACTIVE' })
        .expect(200);

      await ping(key).expect(200);
    });

    it('desactivar una organización no afecta a la llave de otra', async () => {
      await issueKey('org1', 'ana');
      const { key: otherKey } = await issueKey('org2', 'eva');

      await request(app.getHttpServer())
        .patch(settingsUrl('org1'))
        .set(as('ana'))
        .send({ status: 'DISABLED' })
        .expect(200);

      await ping(otherKey).expect(200);
    });
  });
});
