import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
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

config({ path: join(__dirname, '..', '.env') });

const JWT_SECRET = 'jwt-secret-de-la-e2e-de-api-keys';
const API_KEY_PEPPER = 'pepper-de-la-e2e-de-api-keys-con-mas-de-32-caracteres';

/**
 * `JwtAuthGuard` real como guard global, con un Redis simulado que no tiene sesiones cerradas.
 * Va en su propio módulo, importado ANTES que `AuthorizationModule`, para que la cadena quede
 * `JwtAuthGuard` → `PermissionsGuard`, igual que en `AppModule`.
 */
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
 * Administración de API keys de punta a punta, contra Postgres de verdad.
 *
 * Se monta la cadena REAL: JWT firmado → `JwtAuthGuard` → `@RequirePermission(API_KEY, MANAGE)` →
 * `PermissionsGuard` → `role_permissions` sembrados por `AddApiKeyManagePermission`, y los casos de
 * uso sobre `api_keys` con su índice parcial. Lo único simulado es Redis (blacklist de sesiones).
 *
 * **No toca `signature_db`.** Crea una base propia (`signature_api_keys_http_e2e_*`) en el mismo
 * servidor de `POSTGRES_DB_URL`, le aplica todas las migraciones y la borra al terminar.
 */
describe('Administración de API keys por organización (e2e)', () => {
  const DATABASE_NAME = `signature_api_keys_http_e2e_${process.pid}_${Date.now()}`;
  const baseUrl = process.env.POSTGRES_DB_URL as string;
  const adminUrl = baseUrl.replace(/\/[^/?]+(\?.*)?$/, '/postgres$1');
  const databaseUrl = baseUrl.replace(
    /\/[^/?]+(\?.*)?$/,
    `/${DATABASE_NAME}$1`,
  );

  /** Usuarios, membresías, organizaciones y permisos sembrados. */
  const ids: Record<string, string> = {};

  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let swagger: OpenAPIObject;

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
   * Siembra un usuario y su membresía en una organización con un rol de sistema.
   *
   * @param userKey - Nombre con el que la prueba se refiere al usuario.
   * @param organizationKey - Organización de la membresía.
   * @param roleName - Rol de sistema de la membresía.
   * @param isActive - `false` para una membresía dada de baja.
   * @returns El `accounts.id` creado.
   *
   * @example
   * ```ts
   * await seedMember('ana', 'org1', 'OWNER');
   * ```
   */
  async function seedMember(
    userKey: string,
    organizationKey: string,
    roleName: 'OWNER' | 'ADMIN' | 'MEMBER',
    isActive = true,
  ): Promise<string> {
    const [info] = await dataSource.query(
      `INSERT INTO personal_information (name, last_name, curp) VALUES ($1, 'E2E', $2) RETURNING id`,
      [userKey, `CURP${userKey}`.slice(0, 18)],
    );
    const [user] = await dataSource.query(
      `INSERT INTO users (first_name, last_name, email, roles, national_id, password, personal_information_id)
       VALUES ($1, 'E2E', $2, 'user', $3, 'x', $4) RETURNING id`,
      [userKey, `${userKey}@api-keys-http.test`, `NID${userKey}`, info.id],
    );
    const [account] = await dataSource.query(
      `INSERT INTO accounts (user_id, account_type, organization_id, role_id, email, password, is_active)
       SELECT $1, 'ORGANIZATION', $2, r.id, $3, 'x', $5 FROM roles r WHERE r.name = $4 AND r.is_system_role = true
       RETURNING id`,
      [
        user.id,
        ids[`org:${organizationKey}`],
        `${userKey}@api-keys-http.test`,
        roleName,
        isActive,
      ],
    );
    ids[`user:${userKey}`] = user.id;
    ids[`account:${userKey}`] = account.id;
    return account.id;
  }

  /** Id del permiso `RESOURCE.ACTION` (alcance `ANY`) sembrado por las migraciones. */
  async function permissionId(
    resource: string,
    action: string,
  ): Promise<string> {
    const [row] = await dataSource.query(
      `SELECT p.id FROM permissions p
       JOIN resources r ON r.id = p.resource_id JOIN actions a ON a.id = p.action_id
       WHERE r.key = $1 AND a.key = $2 AND p.scope = 'ANY'`,
      [resource, action],
    );
    return row.id;
  }

  /** Encabezado `Authorization` con un JWT real del usuario. */
  function as(userKey: string): Record<string, string> {
    const token = jwtService.sign({
      sub: ids[`user:${userKey}`],
      email: `${userKey}@api-keys-http.test`,
      roles: 'user',
      nationalId: `NID${userKey}`,
      jti: randomUUID(),
    });
    return { Authorization: `Bearer ${token}` };
  }

  function url(organizationKey: string, suffix = ''): string {
    return `/api/v1/organizations/${ids[`org:${organizationKey}`]}/api-keys${suffix}`;
  }

  async function activeKeysOf(organizationKey: string): Promise<number> {
    const [{ count }] = await dataSource.query(
      `SELECT count(*)::int AS count FROM api_keys WHERE organization_id = $1 AND status = 'ACTIVE'`,
      [ids[`org:${organizationKey}`]],
    );
    return count;
  }

  function validBody(): Record<string, unknown> {
    return {
      name: 'Integración ERP',
      permissionIds: [ids['permission:directory-read']],
      expiresAt: '2999-01-01T00:00:00.000Z',
    };
  }

  beforeAll(async () => {
    process.env.API_KEY_PEPPER = API_KEY_PEPPER;
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
    ids['permission:directory-read'] = await permissionId('DIRECTORY', 'READ');
    ids['permission:directory-create'] = await permissionId(
      'DIRECTORY',
      'CREATE',
    );
    ids['permission:api-key-manage'] = await permissionId('API_KEY', 'MANAGE');
    ids['permission:member-delete'] = await permissionId('MEMBER', 'DELETE');

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
      ],
    })
    class ApiKeysE2eModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [ApiKeysE2eModule],
    }).compile();

    app = moduleRef.createNestApplication();
    applyGlobalApiPrefix(app);
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    jwtService = app.get(JwtService);

    swagger = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .addBearerAuth(
          { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          'access-token',
        )
        .build(),
      { include: [ApiKeyModule] },
    );
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
  });

  describe('crear', () => {
    it('emite la llave sin una activa y devuelve el secreto una sola vez', async () => {
      const response = await request(app.getHttpServer())
        .post(url('org1'))
        .set(as('ana'))
        .send(validBody())
        .expect(201);

      const { data } = response.body;
      expect(response.body.success).toBe(true);
      expect(data).toMatchObject({
        name: 'Integración ERP',
        status: 'ACTIVE',
        createdByAccountId: ids['account:ana'],
        expiresAt: '2999-01-01T00:00:00.000Z',
        permissions: [
          { id: ids['permission:directory-read'], key: 'DIRECTORY.READ' },
        ],
      });
      expect(data.prefix).toMatch(/^fma_live_[0-9a-f]{16}$/);
      expect(data.key.startsWith(`${data.prefix}_`)).toBe(true);
      expect(data).not.toHaveProperty('secretHash');

      const [row] = await dataSource.query(
        `SELECT secret_hash, key_prefix FROM api_keys WHERE id = $1`,
        [data.id],
      );
      const secret = data.key.slice(data.prefix.length + 1);
      expect(row.key_prefix).toBe(data.prefix);
      expect(row.secret_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.secret_hash).not.toContain(secret);
    });

    it('un ADMIN también puede, porque trae API_KEY.MANAGE', async () => {
      await request(app.getHttpServer())
        .post(url('org1'))
        .set(as('beto'))
        .send(validBody())
        .expect(201);
    });

    it('rechaza con 409 API_KEY_ALREADY_ACTIVE si ya hay una activa', async () => {
      await request(app.getHttpServer())
        .post(url('org1'))
        .set(as('ana'))
        .send(validBody())
        .expect(201);

      const response = await request(app.getHttpServer())
        .post(url('org1'))
        .set(as('ana'))
        .send(validBody())
        .expect(409);
      expect(response.body.code).toBe('API_KEY_ALREADY_ACTIVE');
    });

    it.each([
      ['inexistente', () => randomUUID(), 'API_KEY_PERMISSION_NOT_FOUND'],
      [
        'API_KEY.MANAGE',
        () => ids['permission:api-key-manage'],
        'API_KEY_PERMISSION_NOT_ALLOWED',
      ],
      [
        'MEMBER.DELETE (rejilla heredada)',
        () => ids['permission:member-delete'],
        'API_KEY_PERMISSION_NOT_ALLOWED',
      ],
    ])('rechaza con 422 un permiso %s', async (_label, id, code) => {
      const response = await request(app.getHttpServer())
        .post(url('org1'))
        .set(as('ana'))
        .send({
          ...validBody(),
          permissionIds: [ids['permission:directory-read'], id()],
        })
        .expect(422);
      expect(response.body.code).toBe(code);
      await expect(activeKeysOf('org1')).resolves.toBe(0);
    });

    it.each([
      ['sin nombre', { name: '' }],
      ['sin permisos', { permissionIds: [] }],
      ['con un permiso que no es UUID', { permissionIds: ['no-es-uuid'] }],
      ['con una fecha mal formada', { expiresAt: 'mañana' }],
    ])(
      'rechaza con 422 API_KEY_INVALID_BODY un body %s',
      async (_label, patch) => {
        const response = await request(app.getHttpServer())
          .post(url('org1'))
          .set(as('ana'))
          .send({ ...validBody(), ...patch })
          .expect(422);
        expect(response.body.code).toBe('API_KEY_INVALID_BODY');
      },
    );

    it('rechaza con 422 API_KEY_INVALID_EXPIRATION una expiración pasada', async () => {
      const response = await request(app.getHttpServer())
        .post(url('org1'))
        .set(as('ana'))
        .send({ ...validBody(), expiresAt: '2000-01-01T00:00:00.000Z' })
        .expect(422);
      expect(response.body.code).toBe('API_KEY_INVALID_EXPIRATION');
    });

    it('dos altas simultáneas dejan una sola llave activa', async () => {
      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(app.getHttpServer())
            .post(url('org1'))
            .set(as('ana'))
            .send(validBody()),
        ),
      );

      expect(responses.map((response) => response.status).sort()).toEqual([
        201, 409, 409, 409, 409,
      ]);
      await expect(activeKeysOf('org1')).resolves.toBe(1);
    });
  });

  describe('consultar', () => {
    it('lista el historial sin llave completa ni hash', async () => {
      await request(app.getHttpServer())
        .post(url('org1'))
        .set(as('ana'))
        .send(validBody())
        .expect(201);
      await request(app.getHttpServer())
        .post(url('org1', '/rotate'))
        .set(as('ana'))
        .send({})
        .expect(201);

      const response = await request(app.getHttpServer())
        .get(url('org1'))
        .set(as('ana'))
        .expect(200);

      expect(
        response.body.data.map((apiKey: { status: string }) => apiKey.status),
      ).toEqual(['ACTIVE', 'REVOKED']);
      for (const apiKey of response.body.data) {
        expect(apiKey).not.toHaveProperty('key');
        expect(apiKey).not.toHaveProperty('secretHash');
      }
      expect(JSON.stringify(response.body)).not.toMatch(
        /fma_live_[0-9a-f]{16}_/,
      );
    });

    it('devuelve la llave vigente sin el secreto', async () => {
      const created = await request(app.getHttpServer())
        .post(url('org1'))
        .set(as('ana'))
        .send(validBody())
        .expect(201);

      const response = await request(app.getHttpServer())
        .get(url('org1', '/current'))
        .set(as('ana'))
        .expect(200);

      expect(response.body.data).toMatchObject({
        id: created.body.data.id,
        prefix: created.body.data.prefix,
        lastUsedAt: null,
        expiresAt: '2999-01-01T00:00:00.000Z',
      });
      expect(response.body.data).not.toHaveProperty('key');
    });

    it('responde 404 API_KEY_NOT_FOUND si no hay llave vigente', async () => {
      const response = await request(app.getHttpServer())
        .get(url('org1', '/current'))
        .set(as('ana'))
        .expect(404);
      expect(response.body.code).toBe('API_KEY_NOT_FOUND');
    });
  });

  describe('rotar', () => {
    it('revoca la anterior con quién y cuándo, y emite otra con secreto nuevo', async () => {
      const created = await request(app.getHttpServer())
        .post(url('org1'))
        .set(as('ana'))
        .send(validBody())
        .expect(201);

      const rotated = await request(app.getHttpServer())
        .post(url('org1', '/rotate'))
        .set(as('beto'))
        .send({ name: 'Integración ERP - llave 2027' })
        .expect(201);

      expect(rotated.body.data).toMatchObject({
        name: 'Integración ERP - llave 2027',
        status: 'ACTIVE',
        expiresAt: null,
        createdByAccountId: ids['account:beto'],
        permissions: [{ key: 'DIRECTORY.READ' }],
      });
      expect(rotated.body.data.key).not.toBe(created.body.data.key);

      const [previous] = await dataSource.query(
        `SELECT status, revoked_at, revoked_by_account_id FROM api_keys WHERE id = $1`,
        [created.body.data.id],
      );
      expect(previous).toMatchObject({
        status: 'REVOKED',
        revoked_by_account_id: ids['account:beto'],
      });
      expect(previous.revoked_at).toBeInstanceOf(Date);
      await expect(activeKeysOf('org1')).resolves.toBe(1);
    });

    it('acepta rotar sin body', async () => {
      await request(app.getHttpServer())
        .post(url('org1'))
        .set(as('ana'))
        .send(validBody())
        .expect(201);

      await request(app.getHttpServer())
        .post(url('org1', '/rotate'))
        .set(as('ana'))
        .expect(201);
    });

    it('responde 404 si no hay llave que rotar', async () => {
      const response = await request(app.getHttpServer())
        .post(url('org1', '/rotate'))
        .set(as('ana'))
        .send({})
        .expect(404);
      expect(response.body.code).toBe('API_KEY_NOT_FOUND');
    });

    it('dos rotaciones simultáneas dejan una sola llave activa', async () => {
      await request(app.getHttpServer())
        .post(url('org1'))
        .set(as('ana'))
        .send(validBody())
        .expect(201);

      const responses = await Promise.all(
        Array.from({ length: 4 }, () =>
          request(app.getHttpServer())
            .post(url('org1', '/rotate'))
            .set(as('ana'))
            .send({}),
        ),
      );

      for (const response of responses) {
        expect([201, 409]).toContain(response.status);
        if (response.status === 409) {
          expect(response.body.code).toBe('API_KEY_ROTATION_CONFLICT');
        }
      }
      expect(responses.some((response) => response.status === 201)).toBe(true);
      await expect(activeKeysOf('org1')).resolves.toBe(1);
    });
  });

  describe('revocar', () => {
    it('revoca sin borrar, registra quién y es idempotente', async () => {
      const created = await request(app.getHttpServer())
        .post(url('org1'))
        .set(as('ana'))
        .send(validBody())
        .expect(201);

      const revoked = await request(app.getHttpServer())
        .delete(url('org1', `/${created.body.data.id}`))
        .set(as('beto'))
        .expect(200);
      expect(revoked.body.data).toMatchObject({
        status: 'REVOKED',
        revokedByAccountId: ids['account:beto'],
      });

      const again = await request(app.getHttpServer())
        .delete(url('org1', `/${created.body.data.id}`))
        .set(as('ana'))
        .expect(200);
      expect(again.body.data).toMatchObject({
        revokedAt: revoked.body.data.revokedAt,
        revokedByAccountId: ids['account:beto'],
      });

      await expect(activeKeysOf('org1')).resolves.toBe(0);
      const [{ count }] = await dataSource.query(
        `SELECT count(*)::int AS count FROM api_keys WHERE id = $1`,
        [created.body.data.id],
      );
      expect(count).toBe(1);
    });

    it('responde 404 a una llave de otra organización o a un id que no es UUID', async () => {
      const foreign = await request(app.getHttpServer())
        .post(url('org2'))
        .set(as('eva'))
        .send(validBody())
        .expect(201);

      for (const apiKeyId of [foreign.body.data.id, 'no-es-uuid']) {
        const response = await request(app.getHttpServer())
          .delete(url('org1', `/${apiKeyId}`))
          .set(as('ana'))
          .expect(404);
        expect(response.body.code).toBe('API_KEY_NOT_FOUND');
      }
      await expect(activeKeysOf('org2')).resolves.toBe(1);
    });
  });

  describe('autorización', () => {
    const routes: Array<[string, (organizationKey: string) => request.Test]> = [
      [
        'POST /',
        (org) => request(app.getHttpServer()).post(url(org)).send(validBody()),
      ],
      ['GET /', (org) => request(app.getHttpServer()).get(url(org))],
      [
        'GET /current',
        (org) => request(app.getHttpServer()).get(url(org, '/current')),
      ],
      [
        'POST /rotate',
        (org) =>
          request(app.getHttpServer()).post(url(org, '/rotate')).send({}),
      ],
      [
        'DELETE /:apiKeyId',
        (org) =>
          request(app.getHttpServer()).delete(url(org, `/${randomUUID()}`)),
      ],
    ];

    it.each(routes)('%s responde 401 sin JWT', async (_route, call) => {
      await call('org1').expect(401);
    });

    it.each(routes)(
      '%s responde 401 con un JWT inválido',
      async (_route, call) => {
        await call('org1')
          .set({ Authorization: 'Bearer no-es-un-jwt' })
          .expect(401);
      },
    );

    it.each(routes)(
      '%s responde 403 a un MEMBER, que no tiene API_KEY.MANAGE',
      async (_route, call) => {
        await call('org1').set(as('carla')).expect(403);
      },
    );

    it.each(routes)(
      '%s responde 403 a un miembro de otra organización',
      async (_route, call) => {
        await call('org1').set(as('eva')).expect(403);
      },
    );

    it.each(routes)(
      '%s responde 403 a una membresía dada de baja',
      async (_route, call) => {
        await call('org1').set(as('dario')).expect(403);
      },
    );

    it('un miembro de otra organización no puede revocar la llave ajena', async () => {
      const created = await request(app.getHttpServer())
        .post(url('org1'))
        .set(as('ana'))
        .send(validBody())
        .expect(201);

      await request(app.getHttpServer())
        .delete(url('org1', `/${created.body.data.id}`))
        .set(as('eva'))
        .expect(403);
      await expect(activeKeysOf('org1')).resolves.toBe(1);
    });

    it('crear una organización no emite una llave', async () => {
      await seedOrganization('org3');
      await seedMember('fabi', 'org3', 'OWNER');

      await request(app.getHttpServer())
        .get(url('org3', '/current'))
        .set(as('fabi'))
        .expect(404);
    });
  });

  describe('documentación Swagger', () => {
    const base = '/api/v1/organizations/{organizationId}/api-keys';

    it.each([
      [base, 'post', ['201', '401', '403', '404', '409', '422']],
      [base, 'get', ['200', '401', '403', '404']],
      [`${base}/current`, 'get', ['200', '401', '403', '404']],
      [`${base}/rotate`, 'post', ['201', '401', '403', '404', '409', '422']],
      [`${base}/{apiKeyId}`, 'delete', ['200', '401', '403', '404']],
    ])('%s %s documenta sus respuestas y el JWT', (path, method, statuses) => {
      const operation = (
        swagger.paths[path] as Record<
          string,
          { responses: Record<string, unknown>; security?: unknown[] }
        >
      )?.[method];

      expect(operation).toBeDefined();
      expect(Object.keys(operation.responses).sort()).toEqual(statuses.sort());
      expect(operation.security).toEqual([{ 'access-token': [] }]);
    });

    it('la respuesta de emisión documenta `key` y las de consulta no', () => {
      const schemas = swagger.components?.schemas as Record<
        string,
        { properties: Record<string, unknown> }
      >;

      expect(schemas.IssuedOrganizationApiKeyData.properties).toHaveProperty(
        'key',
      );
      expect(schemas.OrganizationApiKeyData.properties).not.toHaveProperty(
        'key',
      );
      expect(schemas.OrganizationApiKeyData.properties).not.toHaveProperty(
        'secretHash',
      );
    });
  });
});
