import * as path from 'path';
import { config } from 'dotenv';
import { DataSource, QueryRunner } from 'typeorm';

import { GetDocumentsUseCase } from './../src/document/applications/get-documents.use-case';
import { DocumentEntity } from './../src/document/entities/document.entity';
import { UserEntity } from './../src/user/entities/user.entity';
import { AccountMemberService } from './../src/account/account-member.service';
import { AccountEntity } from './../src/account/entities/account.entity';
import { DOCUMENT_VIEW_ENUM } from './../src/document/enum/document-view.enum';

config();

const DATABASE_URL = process.env.POSTGRES_DB_URL;

/**
 * Sin base no hay nada que integrar: la suite se salta entera y lo dice, en vez de fallar con un
 * error de conexión que parecería un fallo del código. Levantar el contenedor de Postgres
 * (`signature_postgres`, puerto 5434) es todo lo que hace falta para que corra.
 */
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

/**
 * Visibilidad del listado unificado CONTRA POSTGRES DE VERDAD.
 *
 * Existe porque las pruebas unitarias de `GetDocumentsUseCase` simulan el query builder: ven qué
 * condiciones se registraron, pero nunca arman SQL ni lo ejecutan. Eso deja fuera dos clases de
 * fallo que esta suite sí atrapa, y que de hecho atrapó al corregir este bug:
 *
 * 1. **SQL que no compila.** `applyView` usaba `:userId` y `:callerEmail` sin ligarlos: se los
 *    encontraba puestos por la vía de participación de `applyVisibility`. Al dejar de aplicarse
 *    esa vía dentro de una organización, Postgres respondía `syntax error at or near ":"` — con
 *    las pruebas unitarias en verde.
 * 2. **Qué documentos salen realmente**, que es lo que reportó el bug y lo único que un `WHERE`
 *    inspeccionado condición por condición no puede contestar.
 *
 * Cada prueba siembra su escenario dentro de una transacción y la revierte al terminar, así que
 * la base de desarrollo queda exactamente como estaba.
 */
describeWithDatabase(
  'Visibilidad del listado de documentos (e2e con base)',
  () => {
    let dataSource: DataSource;
    let runner: QueryRunner;

    beforeAll(async () => {
      dataSource = new DataSource({
        type: 'postgres',
        url: DATABASE_URL,
        entities: [path.join(__dirname, '../src/**/*.entity.ts')],
        synchronize: false,
        logging: false,
      });
      await dataSource.initialize();
    }, 30_000);

    afterAll(async () => {
      await dataSource?.destroy();
    });

    beforeEach(async () => {
      runner = dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
    });

    afterEach(async () => {
      await runner.rollbackTransaction();
      await runner.release();
    });

    /** Un uuid nuevo pedido a la propia base, para no acarrear una dependencia sólo por esto. */
    async function newId(): Promise<string> {
      const [row] = await runner.query('SELECT uuid_generate_v4() AS id');
      return row.id;
    }

    interface Escenario {
      anaUserId: string;
      anaPersonalAccountId: string;
      anaAcmeAccountId: string;
      acmeOrganizationId: string;
    }

    /**
     * El escenario del bug, con los tres documentos que lo destapan.
     *
     * Ana tiene cuenta personal y es miembro de Acme. Es firmante PENDIENTE en los tres documentos,
     * que es justo lo que antes los colaba en cualquier contexto:
     *
     * - `personal.pdf` — de su cuenta personal.
     * - `de-mi-org.pdf` — de Acme, la organización de la que ella es miembro.
     * - `de-org-ajena.pdf` — de otra organización, creado por otra persona: Ana sólo firma ahí.
     */
    async function sembrarEscenario(): Promise<Escenario> {
      const ids = {
        anaInfo: await newId(),
        betoInfo: await newId(),
        ana: await newId(),
        beto: await newId(),
        acme: await newId(),
        ajena: await newId(),
        anaPersonal: await newId(),
        anaAcme: await newId(),
        betoAjena: await newId(),
        docPersonal: await newId(),
        docAcme: await newId(),
        docAjena: await newId(),
      };

      await runner.query(
        `INSERT INTO personal_information (id, name, last_name, curp) VALUES ($1,'Ana','Lopez','ANA'), ($2,'Beto','Ruiz','BETO')`,
        [ids.anaInfo, ids.betoInfo],
      );
      await runner.query(
        `INSERT INTO users (id, first_name, last_name, email, roles, national_id, password, personal_information_id)
       VALUES ($1,'Ana','Lopez','ana@prueba.mx','{}','ANA','x',$3), ($2,'Beto','Ruiz','beto@prueba.mx','{}','BETO','x',$4)`,
        [ids.ana, ids.beto, ids.anaInfo, ids.betoInfo],
      );
      await runner.query(
        `INSERT INTO organizations (id, name, is_active, index_documents) VALUES ($1,'Acme',true,false), ($2,'Ajena',true,false)`,
        [ids.acme, ids.ajena],
      );
      await runner.query(
        `INSERT INTO accounts (id, user_id, account_type, status, email, password, is_active, index_documents, organization_id) VALUES
        ($1,$4,'PERSONAL','active','ana@prueba.mx','x',true,false,NULL),
        ($2,$4,'ORGANIZATION','active','ana@prueba.mx','x',true,false,$6),
        ($3,$5,'ORGANIZATION','active','beto@prueba.mx','x',true,false,$7)`,
        [
          ids.anaPersonal,
          ids.anaAcme,
          ids.betoAjena,
          ids.ana,
          ids.beto,
          ids.acme,
          ids.ajena,
        ],
      );
      await runner.query(
        `INSERT INTO documents (id, object_key, file_name, file_type, total_pages, ip_address, original_hash, status, created_by, account_id, organization_id, total_signers) VALUES
        ($1,'k','personal.pdf','application/pdf',1,'127.0.0.1','h','pending',$4,$6,NULL,1),
        ($2,'k','de-mi-org.pdf','application/pdf',1,'127.0.0.1','h','pending',$4,$7,$9,1),
        ($3,'k','de-org-ajena.pdf','application/pdf',1,'127.0.0.1','h','pending',$5,$8,$10,1)`,
        [
          ids.docPersonal,
          ids.docAcme,
          ids.docAjena,
          ids.ana,
          ids.beto,
          ids.anaPersonal,
          ids.anaAcme,
          ids.betoAjena,
          ids.acme,
          ids.ajena,
        ],
      );

      // Ana es firmante pendiente en los tres: su cuenta de colaborador es siempre la PERSONAL.
      for (const documentId of [ids.docPersonal, ids.docAcme, ids.docAjena]) {
        await runner.query(
          `INSERT INTO collaborators (id, document_id, account_id, email, status, ip_address, colaborator_type, signing_order)
         VALUES ($1,$2,$3,'ana@prueba.mx','pending','127.0.0.1','signer',1)`,
          [await newId(), documentId, ids.anaPersonal],
        );
      }

      return {
        anaUserId: ids.ana,
        anaPersonalAccountId: ids.anaPersonal,
        anaAcmeAccountId: ids.anaAcme,
        acmeOrganizationId: ids.acme,
      };
    }

    /**
     * El caso de uso REAL, con el repositorio de la transacción.
     *
     * `AccountMemberService` también es el real y lee `accounts` de verdad: es quien traduce el
     * `X-Account-Id` en "esto es una cuenta personal" o "esto es una membresía de tal organización",
     * que es justo el dato del que depende la rama de la visibilidad. Sólo se sustituye
     * `UserService` —arrastra Redis, correo y firma, nada de lo cual participa acá— por una lectura
     * directa de `users`, así que el correo con el que se busca la participación sigue siendo el de
     * la base y no uno inventado.
     */
    async function listarDocumentos(
      userId: string,
      accountId: string,
      view: DOCUMENT_VIEW_ENUM,
    ): Promise<string[]> {
      const accountMemberService = new AccountMemberService(
        runner.manager.getRepository(AccountEntity),
        runner.manager.getRepository(UserEntity),
        {} as never,
      );
      const userService = {
        findOne: (id: string) =>
          runner.manager.getRepository(UserEntity).findOneByOrFail({ id }),
      };

      const useCase = new GetDocumentsUseCase(
        runner.manager.getRepository(DocumentEntity),
        { getFile: async () => ({ secureUrl: '', expiresIn: 0 }) } as never,
        accountMemberService,
        userService as never,
        {
          resolveDocumentSignatureType: () => null,
          resolveDocumentBucket: () => 'created-documents',
        } as never,
      );

      const { items } = await useCase.execute({
        userId,
        accountId,
        filters: { page: 1, limit: 50, view } as never,
      });

      return items.map((item) => item.fileName).sort();
    }

    /**
     * El síntoma exacto del reporte: la lista no cambiaba al cambiar de cuenta. Se comprueba primero
     * porque es la afirmación que resume todo lo demás — antes del arreglo, estas dos llamadas
     * devolvían los mismos tres documentos.
     */
    it('la lista cambia al cambiar de cuenta activa', async () => {
      const escenario = await sembrarEscenario();

      const personal = await listarDocumentos(
        escenario.anaUserId,
        escenario.anaPersonalAccountId,
        DOCUMENT_VIEW_ENUM.ALL,
      );
      const organizacion = await listarDocumentos(
        escenario.anaUserId,
        escenario.anaAcmeAccountId,
        DOCUMENT_VIEW_ENUM.ALL,
      );

      expect(personal).not.toEqual(organizacion);
    });

    it('dentro de la organización lista sólo los documentos de esa organización', async () => {
      const escenario = await sembrarEscenario();

      const documentos = await listarDocumentos(
        escenario.anaUserId,
        escenario.anaAcmeAccountId,
        DOCUMENT_VIEW_ENUM.ALL,
      );

      expect(documentos).toEqual(['de-mi-org.pdf']);
    });

    /**
     * Los documentos de Acme NO se repiten en la bandeja personal —ya se listan en su contexto—,
     * pero el de la organización ajena sí entra: Ana tiene que firmarlo y no hay otro contexto desde
     * el que verlo. Sin esa segunda vía, un firmante externo no vería nunca lo que se le pidió.
     */
    it('en la cuenta personal lista lo suyo y lo que firma fuera de sus organizaciones', async () => {
      const escenario = await sembrarEscenario();

      const documentos = await listarDocumentos(
        escenario.anaUserId,
        escenario.anaPersonalAccountId,
        DOCUMENT_VIEW_ENUM.ALL,
      );

      expect(documentos).toEqual(['de-org-ajena.pdf', 'personal.pdf']);
    });

    /**
     * Las cuatro vistas, en las dos ramas, contra Postgres: es la prueba que habría cazado el
     * `syntax error at or near ":"` de `requires_my_signature` dentro de una organización, donde el
     * SQL se quedó sin los parámetros que antes le ponía la visibilidad.
     */
    it.each(Object.values(DOCUMENT_VIEW_ENUM))(
      'la vista %s produce SQL válido en las dos ramas',
      async (view) => {
        const escenario = await sembrarEscenario();

        await expect(
          listarDocumentos(
            escenario.anaUserId,
            escenario.anaPersonalAccountId,
            view,
          ),
        ).resolves.toBeDefined();
        await expect(
          listarDocumentos(
            escenario.anaUserId,
            escenario.anaAcmeAccountId,
            view,
          ),
        ).resolves.toBeDefined();
      },
    );

    /**
     * `requires_my_signature` es la vista por omisión de la pantalla, así que es la que el usuario
     * ve al entrar: dentro de la organización tiene que traer su documento pendiente, y sólo ése.
     */
    it('la vista por omisión sigue mostrando lo que hay que firmar en cada contexto', async () => {
      const escenario = await sembrarEscenario();

      await expect(
        listarDocumentos(
          escenario.anaUserId,
          escenario.anaAcmeAccountId,
          DOCUMENT_VIEW_ENUM.REQUIRES_MY_SIGNATURE,
        ),
      ).resolves.toEqual(['de-mi-org.pdf']);
      await expect(
        listarDocumentos(
          escenario.anaUserId,
          escenario.anaPersonalAccountId,
          DOCUMENT_VIEW_ENUM.REQUIRES_MY_SIGNATURE,
        ),
      ).resolves.toEqual(['de-org-ajena.pdf', 'personal.pdf']);
    });
  },
);
