import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { config } from 'dotenv';
import { join } from 'path';
import { Client } from 'pg';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { AuthorizationModule } from './../src/authorization/authorization.module';
import { applyGlobalApiPrefix } from './../src/common/constants/api-prefix.constants';
import { DirectoryModule } from './../src/directory/directory.module';

config({ path: join(__dirname, '..', '.env') });

/**
 * Directorio de contactos de punta a punta, contra Postgres de verdad.
 *
 * Lo que se monta es la cadena REAL: `@RequirePermission` → `PermissionsGuard` →
 * `AuthorizationService` → `role_permissions` sembrados por las migraciones (incluida
 * `AddDirectoryPermissions`), y `DirectoryService` sobre las tablas con sus restricciones. Lo único
 * simulado es el JWT: un middleware toma el usuario de `X-Test-User-Id`, porque lo que se prueba
 * aquí es qué puede hacer una membresía, no la firma del token.
 *
 * **No toca `signature_db`.** Crea una base propia (`signature_directory_e2e_*`) en el mismo
 * servidor de `POSTGRES_DB_URL`, le aplica todas las migraciones y la borra al terminar.
 */
describe('Directorio de contactos (e2e)', () => {
  const DATABASE_NAME = `signature_directory_e2e_${process.pid}_${Date.now()}`;
  const baseUrl = process.env.POSTGRES_DB_URL as string;
  const adminUrl = baseUrl.replace(/\/[^/?]+(\?.*)?$/, '/postgres$1');
  const databaseUrl = baseUrl.replace(
    /\/[^/?]+(\?.*)?$/,
    `/${DATABASE_NAME}$1`,
  );

  /** Usuarios y membresías sembrados; los ids los genera Postgres. */
  const ids: Record<string, string> = {};

  let app: INestApplication;
  let dataSource: DataSource;

  async function adminQuery(sql: string): Promise<void> {
    const client = new Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  /**
   * Siembra un usuario con su ficha personal.
   *
   * @param key - Nombre con el que la prueba se refiere al usuario.
   * @returns El `users.id` creado.
   *
   * @example
   * ```ts
   * const userId = await seedUser('ana');
   * ```
   */
  async function seedUser(key: string): Promise<string> {
    const [info] = await dataSource.query(
      `INSERT INTO personal_information (name, last_name, curp) VALUES ($1, 'E2E', $2) RETURNING id`,
      [key, `CURP${key}`.slice(0, 18)],
    );
    const [user] = await dataSource.query(
      `INSERT INTO users (first_name, last_name, email, roles, national_id, password, personal_information_id)
       VALUES ($1, 'E2E', $2, 'user', $3, 'x', $4) RETURNING id`,
      [key, `${key}@directory-e2e.test`, `NID${key}`, info.id],
    );
    ids[`user:${key}`] = user.id;
    return user.id;
  }

  /**
   * Siembra una membresía: la cuenta personal del usuario o su fila en una organización.
   *
   * @param key - Nombre con el que la prueba se refiere a la membresía.
   * @param userKey - Usuario dueño de la membresía.
   * @param roleName - Rol de sistema (OWNER, ADMIN o MEMBER).
   * @param organizationKey - Organización; se omite para una cuenta PERSONAL.
   * @returns El `accounts.id` creado.
   *
   * @example
   * ```ts
   * await seedAccount('org1-admin', 'ana', 'ADMIN', 'org1');
   * ```
   */
  async function seedAccount(
    key: string,
    userKey: string,
    roleName: 'OWNER' | 'ADMIN' | 'MEMBER',
    organizationKey?: string,
  ): Promise<string> {
    const [account] = await dataSource.query(
      `INSERT INTO accounts (user_id, account_type, organization_id, role_id, email, password)
       SELECT $1, $2, $3, r.id, $4, 'x' FROM roles r WHERE r.name = $5 AND r.is_system_role = true
       RETURNING id`,
      [
        ids[`user:${userKey}`],
        organizationKey ? 'ORGANIZATION' : 'PERSONAL',
        organizationKey ? ids[`org:${organizationKey}`] : null,
        `${userKey}@directory-e2e.test`,
        roleName,
      ],
    );
    ids[key] = account.id;
    return account.id;
  }

  async function seedOrganization(key: string): Promise<void> {
    const [organization] = await dataSource.query(
      `INSERT INTO organizations (name, display_name) VALUES ($1, $1) RETURNING id`,
      [`Org ${key}`],
    );
    ids[`org:${key}`] = organization.id;
  }

  /**
   * Petición como una membresía concreta: su usuario en el "JWT" y su cuenta en `X-Account-Id`.
   *
   * @param accountKey - Membresía desde la que se actúa.
   * @param userKey - Usuario autenticado; por omisión, el dueño de la membresía.
   * @returns Los encabezados de la petición.
   *
   * @example
   * ```ts
   * request(server).get(URL).set(as('personal-ana'));
   * ```
   */
  function as(accountKey: string, userKey?: string): Record<string, string> {
    const owner = userKey ?? accountKey.split('-').pop()!;
    return {
      'X-Test-User-Id': ids[`user:${owner}`],
      'X-Account-Id': ids[accountKey],
    };
  }

  const URL = '/api/v1/directory/contacts';
  const anaContact = {
    firstName: 'Ana',
    lastName: 'García',
    email: '  Ana@Example.com ',
    taxId: 'gaaa900101xxx',
    phone: '+526141234567',
  };

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

    await seedOrganization('org1');
    await seedOrganization('org2');
    // ana y beto: dos personas con su cuenta personal.
    await seedUser('ana');
    await seedUser('beto');
    await seedAccount('personal-ana', 'ana', 'OWNER');
    await seedAccount('personal-beto', 'beto', 'OWNER');
    // org1: ana es ADMIN, carla es OWNER, dario es MEMBER. org2: eva es OWNER.
    await seedUser('carla');
    await seedUser('dario');
    await seedUser('eva');
    await seedAccount('org1-ana', 'ana', 'ADMIN', 'org1');
    await seedAccount('org1-carla', 'carla', 'OWNER', 'org1');
    await seedAccount('org1-dario', 'dario', 'MEMBER', 'org1');
    await seedAccount('org2-eva', 'eva', 'OWNER', 'org2');

    @Module({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          url: databaseUrl,
          entities: [join(__dirname, '..', 'src', '**', '*.entity{.ts,.js}')],
        }),
        AuthorizationModule,
        DirectoryModule,
      ],
    })
    class DirectoryE2eModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [DirectoryE2eModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(
      (
        req: { headers: Record<string, string>; user?: unknown },
        _res: unknown,
        next: () => void,
      ) => {
        const userId = req.headers['x-test-user-id'];
        if (userId) req.user = { sub: userId };
        next();
      },
    );
    applyGlobalApiPrefix(app);
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await dataSource?.destroy();
    await adminQuery(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DATABASE_NAME}' AND pid <> pg_backend_pid()`,
    );
    await adminQuery(`DROP DATABASE IF EXISTS "${DATABASE_NAME}"`);
  });

  describe('aislamiento por cuenta personal', () => {
    let anaContactId: string;

    it('crea el contacto con el correo y el RFC normalizados', async () => {
      const response = await request(app.getHttpServer())
        .post(URL)
        .set(as('personal-ana'))
        .send(anaContact)
        .expect(201);

      anaContactId = response.body.id;
      expect(response.body).toMatchObject({
        firstName: 'Ana',
        lastName: 'García',
        email: 'ana@example.com',
        taxId: 'GAAA900101XXX',
        archivedAt: null,
      });
      const [row] = await dataSource.query(
        `SELECT created_by_account_id, updated_by_account_id FROM directory_contacts WHERE id = $1`,
        [anaContactId],
      );
      expect(row).toEqual({
        created_by_account_id: ids['personal-ana'],
        updated_by_account_id: ids['personal-ana'],
      });
    });

    it('la dueña lo ve; otra cuenta personal no', async () => {
      const own = await request(app.getHttpServer())
        .get(URL)
        .set(as('personal-ana'))
        .expect(200);
      const other = await request(app.getHttpServer())
        .get(URL)
        .set(as('personal-beto'))
        .expect(200);

      expect(own.body.items.map((c: { id: string }) => c.id)).toEqual([
        anaContactId,
      ]);
      expect(other.body).toEqual({
        items: [],
        pagination: { page: 1, limit: 25, total: 0, totalPages: 0 },
      });
    });

    it('otra cuenta personal recibe 404 al editar o archivar conociendo el contactId', async () => {
      await request(app.getHttpServer())
        .patch(`${URL}/${anaContactId}`)
        .set(as('personal-beto'))
        .send({ firstName: 'Intruso' })
        .expect(404);
      await request(app.getHttpServer())
        .delete(`${URL}/${anaContactId}`)
        .set(as('personal-beto'))
        .expect(404);

      const [row] = await dataSource.query(
        `SELECT first_name, archived_at FROM directory_contacts WHERE id = $1`,
        [anaContactId],
      );
      expect(row).toEqual({ first_name: 'Ana', archived_at: null });
    });

    it('nombrar en X-Account-Id una cuenta ajena responde 403', async () => {
      await request(app.getHttpServer())
        .get(URL)
        .set(as('personal-ana', 'beto'))
        .expect(403);
    });

    it('busca por nombre completo, correo y RFC', async () => {
      for (const search of ['ana garcía', 'EXAMPLE.COM', 'gaaa9001']) {
        const response = await request(app.getHttpServer())
          .get(URL)
          .query({ search })
          .set(as('personal-ana'))
          .expect(200);
        expect(response.body.pagination.total).toBe(1);
      }

      const none = await request(app.getHttpServer())
        .get(URL)
        .query({ search: 'zzz' })
        .set(as('personal-ana'))
        .expect(200);
      expect(none.body.pagination.total).toBe(0);
    });

    it('descarta directoryId y la autoría que lleguen en el cuerpo', async () => {
      const [beto] = await dataSource.query(
        `INSERT INTO directories (personal_account_id) VALUES ($1) RETURNING id`,
        [ids['personal-beto']],
      );

      const response = await request(app.getHttpServer())
        .post(URL)
        .set(as('personal-ana'))
        .send({
          firstName: 'Colado',
          lastName: 'X',
          email: 'colado@example.com',
          directoryId: beto.id,
          organizationId: ids['org:org1'],
          createdByAccountId: ids['personal-beto'],
          updatedByAccountId: ids['personal-beto'],
        })
        .expect(201);

      const [row] = await dataSource.query(
        `SELECT d.personal_account_id, c.created_by_account_id
         FROM directory_contacts c JOIN directories d ON d.id = c.directory_id WHERE c.id = $1`,
        [response.body.id],
      );
      expect(row).toEqual({
        personal_account_id: ids['personal-ana'],
        created_by_account_id: ids['personal-ana'],
      });
    });
  });

  describe('aislamiento por organización', () => {
    let orgContactId: string;

    it('dos miembros autorizados de la misma organización comparten el directorio', async () => {
      const created = await request(app.getHttpServer())
        .post(URL)
        .set(as('org1-ana'))
        .send({
          firstName: 'Proveedor',
          lastName: 'Uno',
          email: 'p1@example.com',
        })
        .expect(201);
      orgContactId = created.body.id;

      const listed = await request(app.getHttpServer())
        .get(URL)
        .set(as('org1-carla'))
        .expect(200);
      expect(listed.body.items.map((c: { id: string }) => c.id)).toEqual([
        orgContactId,
      ]);

      const [{ count }] = await dataSource.query(
        `SELECT count(*)::int AS count FROM directories WHERE organization_id = $1`,
        [ids['org:org1']],
      );
      expect(count).toBe(1);
    });

    it('la edición de otro miembro queda registrada como suya', async () => {
      await request(app.getHttpServer())
        .patch(`${URL}/${orgContactId}`)
        .set(as('org1-carla'))
        .send({ phone: '+526140000000' })
        .expect(200);

      const [row] = await dataSource.query(
        `SELECT created_by_account_id, updated_by_account_id, phone FROM directory_contacts WHERE id = $1`,
        [orgContactId],
      );
      expect(row).toEqual({
        created_by_account_id: ids['org1-ana'],
        updated_by_account_id: ids['org1-carla'],
        phone: '+526140000000',
      });
    });

    it('el directorio de la organización no es el personal del mismo usuario', async () => {
      const personal = await request(app.getHttpServer())
        .get(URL)
        .set(as('personal-ana'))
        .expect(200);

      expect(
        personal.body.items.map((c: { id: string }) => c.id),
      ).not.toContain(orgContactId);
    });

    it('un miembro de otra organización no lo ve y recibe 404 al tocarlo', async () => {
      const listed = await request(app.getHttpServer())
        .get(URL)
        .set(as('org2-eva'))
        .expect(200);
      expect(listed.body.items).toEqual([]);

      await request(app.getHttpServer())
        .patch(`${URL}/${orgContactId}`)
        .set(as('org2-eva'))
        .send({ firstName: 'Intruso' })
        .expect(404);
      await request(app.getHttpServer())
        .delete(`${URL}/${orgContactId}`)
        .set(as('org2-eva'))
        .expect(404);
    });

    it('dos altas simultáneas en un directorio nuevo crean un solo directorio', async () => {
      const responses = await Promise.all(
        ['c1@example.com', 'c2@example.com', 'c3@example.com'].map((email) =>
          request(app.getHttpServer())
            .post(URL)
            .set(as('org2-eva'))
            .send({ firstName: 'Simultáneo', lastName: 'X', email }),
        ),
      );

      expect(responses.map((response) => response.status)).toEqual([
        201, 201, 201,
      ]);
      const [{ count }] = await dataSource.query(
        `SELECT count(*)::int AS count FROM directories WHERE organization_id = $1`,
        [ids['org:org2']],
      );
      expect(count).toBe(1);
    });
  });

  describe('RBAC en organizaciones', () => {
    it('un MEMBER sin DIRECTORY.* recibe 403 en los cuatro endpoints', async () => {
      const server = app.getHttpServer();
      const someId = '00000000-0000-4000-8000-000000000000';

      await request(server).get(URL).set(as('org1-dario')).expect(403);
      await request(server)
        .post(URL)
        .set(as('org1-dario'))
        .send({ firstName: 'A', lastName: 'B', email: 'm@example.com' })
        .expect(403);
      await request(server)
        .patch(`${URL}/${someId}`)
        .set(as('org1-dario'))
        .send({ firstName: 'A' })
        .expect(403);
      await request(server)
        .delete(`${URL}/${someId}`)
        .set(as('org1-dario'))
        .expect(403);
    });

    it('sin X-Account-Id no hay cuenta activa: 403', async () => {
      await request(app.getHttpServer())
        .get(URL)
        .set('X-Test-User-Id', ids['user:ana'])
        .expect(403);
    });
  });

  describe('duplicados', () => {
    it('el mismo correo normalizado en el mismo directorio responde 409', async () => {
      await request(app.getHttpServer())
        .post(URL)
        .set(as('personal-ana'))
        .send({ ...anaContact, email: 'ANA@EXAMPLE.COM' })
        .expect(409);
    });

    it('el mismo correo en otro directorio se acepta', async () => {
      await request(app.getHttpServer())
        .post(URL)
        .set(as('org1-ana'))
        .send(anaContact)
        .expect(201);
      await request(app.getHttpServer())
        .post(URL)
        .set(as('personal-beto'))
        .send(anaContact)
        .expect(201);
    });

    it('cambiar el correo a uno ya usado en el directorio responde 409', async () => {
      const list = await request(app.getHttpServer())
        .get(URL)
        .query({ search: 'colado' })
        .set(as('personal-ana'))
        .expect(200);

      await request(app.getHttpServer())
        .patch(`${URL}/${list.body.items[0].id}`)
        .set(as('personal-ana'))
        .send({ email: ' ana@example.com' })
        .expect(409);
    });
  });

  describe('archivado', () => {
    let contactId: string;

    beforeAll(async () => {
      const response = await request(app.getHttpServer())
        .post(URL)
        .set(as('personal-ana'))
        .send({
          firstName: 'Temporal',
          lastName: 'Z',
          email: 'temp@example.com',
        });
      contactId = response.body.id;
    });

    it('DELETE archiva sin borrar la fila', async () => {
      const response = await request(app.getHttpServer())
        .delete(`${URL}/${contactId}`)
        .set(as('personal-ana'))
        .expect(200);

      expect(response.body.archivedAt).not.toBeNull();
      const rows = await dataSource.query(
        `SELECT archived_at FROM directory_contacts WHERE id = $1`,
        [contactId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].archived_at).not.toBeNull();
    });

    it('el archivado no aparece en GET ni se puede editar o archivar otra vez', async () => {
      const list = await request(app.getHttpServer())
        .get(URL)
        .query({ search: 'temp@' })
        .set(as('personal-ana'))
        .expect(200);
      expect(list.body.items).toEqual([]);

      await request(app.getHttpServer())
        .patch(`${URL}/${contactId}`)
        .set(as('personal-ana'))
        .send({ firstName: 'X' })
        .expect(404);
      await request(app.getHttpServer())
        .delete(`${URL}/${contactId}`)
        .set(as('personal-ana'))
        .expect(404);
    });

    it('volver a dar de alta su correo reactiva el mismo contacto', async () => {
      const response = await request(app.getHttpServer())
        .post(URL)
        .set(as('personal-ana'))
        .send({
          firstName: 'Regresa',
          lastName: 'Z',
          email: 'TEMP@example.com',
        })
        .expect(201);

      expect(response.body).toMatchObject({
        id: contactId,
        firstName: 'Regresa',
        archivedAt: null,
      });
    });
  });
});
