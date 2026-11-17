import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { config } from 'dotenv';
import { join } from 'path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { AccountEntity } from './../src/account/entities/account.entity';
import { ConsumeDocumentCreditUseCase } from './../src/billing/credits/consume-document-credit.use-case';
import { countAvailableCredits } from './../src/billing/credits/count-available-credits.util';
import { recordLotIssued } from './../src/billing/credits/credit-ledger.util';
import { CreditLotEntity } from './../src/billing/credits/credit-lot.entity';
import { CreditReservationService } from './../src/billing/credits/credit-reservation.service';
import { CloseBiometricReservationsUseCase } from './../src/billing/credits/close-biometric-reservations.use-case';
import { FinalizeBiometricSignatureCreditsUseCase } from './../src/billing/credits/finalize-biometric-signature-credits.use-case';
import { DOCUMENT_CLOSURE_REASON_ENUM } from './../src/billing/enums/document-closure-reason.enum';
import { ReleaseExpiredCreditReservationsUseCase } from './../src/billing/credits/release-expired-credit-reservations.use-case';
import { ReserveBiometricSignatureCreditsUseCase } from './../src/billing/credits/reserve-biometric-signature-credits.use-case';
import { ReserveDocumentCreditUseCase } from './../src/billing/credits/reserve-document-credit.use-case';
import { CREDIT_LEDGER_MOVEMENT_TYPE_ENUM } from './../src/billing/enums/credit-ledger-movement-type.enum';
import { CREDIT_LOT_ORIGIN_ENUM } from './../src/billing/enums/credit-lot-origin.enum';
import { CREDIT_TYPE_ENUM } from './../src/billing/enums/credit-type.enum';
import {
  InsufficientBiometricCreditsException,
  InsufficientDocumentCreditsException,
} from './../src/billing/exceptions/billing.exceptions';
import { BillingOwnerService } from './../src/billing/profiles/billing-owner.service';
import { BillingProfileEntity } from './../src/billing/profiles/billing-profile.entity';

config();

const DOC = CREDIT_TYPE_ENUM.DOCUMENT_SIGNATURE;
const BIO = CREDIT_TYPE_ENUM.BIOMETRIC_SIGNATURE;

/**
 * Reservas de créditos contra Postgres real (base desechable con TODAS las migraciones).
 *
 * Lo que sólo se prueba aquí y no con dobles: la carrera por el último crédito (la resuelve el
 * motor), los `CHECK` que impiden saldos negativos, la FK compuesta lote–perfil–tipo, el trigger
 * que hace inmutable el ledger, el backfill de la migración y que el saldo de cada lote puede
 * reconstruirse sumando sus movimientos.
 */
describe('Reservas de créditos biométricos (e2e)', () => {
  const DATABASE_NAME = `signature_credit_reservations_e2e_${process.pid}_${Date.now()}`;
  const baseUrl = process.env.POSTGRES_DB_URL as string;
  const adminUrl = baseUrl.replace(/\/[^/?]+(\?.*)?$/, '/postgres$1');
  const databaseUrl = baseUrl.replace(
    /\/[^/?]+(\?.*)?$/,
    `/${DATABASE_NAME}$1`,
  );
  const entities = [join(__dirname, '..', 'src', '**', '*.entity{.ts,.js}')];

  let dataSource: DataSource;
  let moduleClose: () => Promise<void>;
  let credits: CreditReservationService;
  let reserveDocument: ReserveDocumentCreditUseCase;
  let reserveBiometric: ReserveBiometricSignatureCreditsUseCase;
  let finalize: FinalizeBiometricSignatureCreditsUseCase;
  let closeBiometric: CloseBiometricReservationsUseCase;
  let releaseExpired: ReleaseExpiredCreditReservationsUseCase;
  let consumeDocument: ConsumeDocumentCreditUseCase;

  /** Usuario con cuenta personal y miembro de una organización, cada una con su perfil. */
  const ids: Record<string, string> = {};

  async function adminQuery(sql: string): Promise<void> {
    const client = new Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  async function insertReturningId(
    sql: string,
    params: unknown[],
  ): Promise<string> {
    const [row] = await dataSource.query(`${sql} RETURNING id`, params);
    return row.id as string;
  }

  /** Emite un lote y su movimiento PURCHASE, como lo haría una compra confirmada. */
  async function issueLot(
    billingProfileId: string,
    creditType: CREDIT_TYPE_ENUM,
    quantity: number,
  ): Promise<string> {
    return dataSource.transaction(async (manager) => {
      const lots = manager.getRepository(CreditLotEntity);
      const lot = await lots.save(
        lots.create({
          billingProfileId,
          origin: CREDIT_LOT_ORIGIN_ENUM.ADD_ON,
          creditType,
          issued: quantity,
          remaining: quantity,
          reserved: 0,
          stripePaymentIntentId: `pi_${randomUUID()}`,
        }),
      );
      await recordLotIssued(
        manager,
        lot,
        CREDIT_LEDGER_MOVEMENT_TYPE_ENUM.PURCHASE,
      );
      return lot.id;
    });
  }

  async function lot(
    id: string,
  ): Promise<{ remaining: number; reserved: number }> {
    const [row] = await dataSource.query(
      `SELECT remaining, reserved FROM credit_lots WHERE id = $1`,
      [id],
    );
    return { remaining: row.remaining, reserved: row.reserved };
  }

  async function createDocument(
    accountId: string,
    status = 'PENDING_SIGNATURE',
  ): Promise<string> {
    return insertReturningId(
      `INSERT INTO documents (object_key, file_name, file_type, total_pages, ip_address, original_hash, created_by, account_id, total_signers, status, signature_type)
       VALUES ($1, 'contrato.pdf', 'application/pdf', 1, '127.0.0.1', 'hash', $2, $3, 1, $4, 'BIOMETRIC')`,
      [`${randomUUID()}.pdf`, ids.user, accountId, status],
    );
  }

  /** Firmante biométrico del documento. */
  async function createBiometricSigner(documentId: string): Promise<string> {
    return insertReturningId(
      `INSERT INTO collaborators (document_id, ip_address, colaborator_type, signature_type) VALUES ($1, '127.0.0.1', 'SIGNER', 'BIOMETRIC')`,
      [documentId],
    );
  }

  /** Intento de Didit; sin `collaboratorId` crea un colaborador nuevo para él. */
  async function createAttempt(
    documentId: string,
    status = 'PENDING',
    existingCollaboratorId?: string,
  ): Promise<string> {
    const collaboratorId =
      existingCollaboratorId ??
      (await insertReturningId(
        `INSERT INTO collaborators (document_id, ip_address, colaborator_type) VALUES ($1, '127.0.0.1', 'SIGNER')`,
        [documentId],
      ));
    return insertReturningId(
      `INSERT INTO biometric_signature_attempts (document_id, collaborator_id, email_snapshot, provider, provider_workflow_id, document_hash, geolocation, consented_at, status)
       VALUES ($1, $2, 'firmante@correo.mx', 'DIDIT', 'wf-kyc', 'hash', '{}', now(), $3)`,
      [documentId, collaboratorId, status],
    );
  }

  /** Documento biométrico con su crédito documental reservado por la cuenta indicada. */
  async function reservedDocument(accountId: string): Promise<string> {
    const documentId = await createDocument(accountId);
    await reserveDocument.execute({
      documentId,
      accountId,
      userId: ids.user,
    });
    return documentId;
  }

  /**
   * Deshace migraciones, de la última hacia atrás, hasta revertir `name` inclusive. Así cada prueba
   * de migración revierte la suya aunque después se agreguen otras.
   */
  async function undoMigrationsThrough(name: string): Promise<void> {
    for (;;) {
      const [last] = await dataSource.query(
        `SELECT name FROM migrations ORDER BY id DESC LIMIT 1`,
      );
      if (!last) throw new Error(`La migración ${name} no está aplicada.`);
      await dataSource.undoLastMigration({ transaction: 'each' });
      if (last.name === name) return;
    }
  }

  async function ledgerCount(): Promise<number> {
    const [row] = await dataSource.query(
      `SELECT count(*)::int AS n FROM credit_ledger_entries`,
    );
    return row.n;
  }

  beforeAll(async () => {
    await adminQuery(`CREATE DATABASE "${DATABASE_NAME}"`);

    dataSource = new DataSource({
      type: 'postgres',
      url: databaseUrl,
      entities,
      migrations: [join(__dirname, '..', 'src', 'migrations', '*{.ts,.js}')],
      migrationsTransactionMode: 'each',
    });
    await dataSource.initialize();
    await dataSource.runMigrations();

    ids.user = await insertReturningId(
      // PROVISIONED: el CHECK de credenciales sólo aplica a usuarios activos.
      `INSERT INTO users (first_name, last_name, email, roles, lifecycle_status) VALUES ('Ana', 'López', $1, 'user', 'PROVISIONED')`,
      [`ana-${randomUUID()}@correo.mx`],
    );

    const moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({ type: 'postgres', url: databaseUrl, entities }),
        TypeOrmModule.forFeature([BillingProfileEntity, AccountEntity]),
      ],
      providers: [
        BillingOwnerService,
        CreditReservationService,
        ReserveDocumentCreditUseCase,
        ReserveBiometricSignatureCreditsUseCase,
        CloseBiometricReservationsUseCase,
        FinalizeBiometricSignatureCreditsUseCase,
        ReleaseExpiredCreditReservationsUseCase,
        ConsumeDocumentCreditUseCase,
      ],
    }).compile();
    await moduleRef.init();
    moduleClose = () => moduleRef.close();

    credits = moduleRef.get(CreditReservationService);
    reserveDocument = moduleRef.get(ReserveDocumentCreditUseCase);
    reserveBiometric = moduleRef.get(ReserveBiometricSignatureCreditsUseCase);
    finalize = moduleRef.get(FinalizeBiometricSignatureCreditsUseCase);
    closeBiometric = moduleRef.get(CloseBiometricReservationsUseCase);
    releaseExpired = moduleRef.get(ReleaseExpiredCreditReservationsUseCase);
    consumeDocument = moduleRef.get(ConsumeDocumentCreditUseCase);
  }, 180_000);

  afterAll(async () => {
    await moduleClose?.();
    await dataSource?.destroy();
    await adminQuery(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DATABASE_NAME}' AND pid <> pg_backend_pid()`,
    );
    await adminQuery(`DROP DATABASE IF EXISTS "${DATABASE_NAME}"`);
  });

  /**
   * Cada prueba trabaja con una cuenta personal y una organización nuevas, cada una con su perfil
   * y sin lotes: así el saldo y el lote elegido dependen sólo de lo que siembra la prueba, y el
   * ledger nunca se toca a mano.
   */
  beforeEach(async () => {
    ids.personalAccount = await insertReturningId(
      `INSERT INTO accounts (user_id, account_type, email) VALUES ($1, 'PERSONAL', 'ana@correo.mx')`,
      [ids.user],
    );
    ids.organization = await insertReturningId(
      `INSERT INTO organizations (name, display_name) VALUES ($1, 'ACME')`,
      [`acme-${randomUUID()}`],
    );
    ids.organizationAccount = await insertReturningId(
      `INSERT INTO accounts (user_id, account_type, email, organization_id) VALUES ($1, 'ORGANIZATION', 'ana@acme.mx', $2)`,
      [ids.user, ids.organization],
    );
    ids.personalProfile = await insertReturningId(
      `INSERT INTO billing_profiles (personal_account_id) VALUES ($1)`,
      [ids.personalAccount],
    );
    ids.organizationProfile = await insertReturningId(
      `INSERT INTO billing_profiles (organization_id) VALUES ($1)`,
      [ids.organization],
    );
  });

  describe('migración', () => {
    it('respalda en el ledger los lotes y consumos históricos, y se revierte y se vuelve a aplicar', async () => {
      // Un lote y un consumo "de antes": se escriben con el esquema sin la 093.
      await undoMigrationsThrough(
        'CreateCreditReservationsAndLedger1784300000093',
      );
      const legacyLot = await insertReturningId(
        `INSERT INTO credit_lots (billing_profile_id, origin, issued, remaining, stripe_invoice_id) VALUES ($1, 'CURRENT_PERIOD', 10, 9, $2)`,
        [ids.personalProfile, `in_${randomUUID()}`],
      );
      const legacyDocument = await insertReturningId(
        `INSERT INTO documents (object_key, file_name, file_type, total_pages, ip_address, original_hash, created_by, account_id, total_signers, status)
         VALUES ($1, 'viejo.pdf', 'application/pdf', 1, '127.0.0.1', 'hash', $2, $3, 1, 'SIGNED')`,
        [`${randomUUID()}.pdf`, ids.user, ids.personalAccount],
      );
      await dataSource.query(
        `INSERT INTO document_credit_consumptions (document_id, billing_profile_id, credit_lot_id, credits_consumed, signature_type) VALUES ($1, $2, $3, 1, 'SIMPLE')`,
        [legacyDocument, ids.personalProfile, legacyLot],
      );

      await dataSource.runMigrations({ transaction: 'each' });

      const entries = await dataSource.query(
        `SELECT movement_type, credit_type, quantity, idempotency_key FROM credit_ledger_entries WHERE credit_lot_id = $1 ORDER BY created_at`,
        [legacyLot],
      );
      expect(entries).toEqual([
        {
          movement_type: 'PURCHASE',
          credit_type: DOC,
          quantity: 10,
          idempotency_key: `issue:lot:${legacyLot}`,
        },
        {
          movement_type: 'CONSUME',
          credit_type: DOC,
          quantity: 1,
          idempotency_key: `consume:document:${legacyDocument}`,
        },
      ]);
      expect(await lot(legacyLot)).toEqual({ remaining: 9, reserved: 0 });
    });

    it('098: las reservas biométricas históricas por intento toman su colaborador y siguen válidas', async () => {
      // Una reserva "de antes" (sólo por intento): se escribe con el esquema sin la 098.
      await undoMigrationsThrough(
        'AddCollaboratorToCreditReservations1784300000098',
      );
      const lotId = await issueLot(ids.personalProfile, BIO, 1);
      const documentId = await createDocument(ids.personalAccount);
      const attemptId = await createAttempt(documentId, 'IN_PROGRESS');
      const [{ collaborator_id: collaboratorId }] = await dataSource.query(
        `SELECT collaborator_id FROM biometric_signature_attempts WHERE id = $1`,
        [attemptId],
      );
      await dataSource.query(
        `UPDATE credit_lots SET reserved = 1 WHERE id = $1`,
        [lotId],
      );
      const legacyId = await insertReturningId(
        `INSERT INTO credit_reservations (billing_profile_id, credit_lot_id, credit_type, biometric_signature_attempt_id, quantity, expires_at)
         VALUES ($1, $2, 'BIOMETRIC_SIGNATURE', $3, 1, now() + interval '1 day')`,
        [ids.personalProfile, lotId, attemptId],
      );

      await dataSource.runMigrations({ transaction: 'each' });

      const [row] = await dataSource.query(
        `SELECT document_id, collaborator_id, biometric_signature_attempt_id, status, quantity FROM credit_reservations WHERE id = $1`,
        [legacyId],
      );
      expect(row).toEqual({
        document_id: documentId,
        collaborator_id: collaboratorId,
        biometric_signature_attempt_id: attemptId,
        status: 'ACTIVE',
        quantity: 1,
      });
      expect(await lot(lotId)).toEqual({ remaining: 1, reserved: 1 });
      // Sigue siendo la reserva del intento: reintentar no bloquea otro crédito.
      await expect(
        reserveBiometric.execute({
          biometricSignatureAttemptId: attemptId,
          documentId,
        }),
      ).resolves.toMatchObject({ id: legacyId });
    });

    it('098: no se revierte si hay reservas biométricas sin intento', async () => {
      await issueLot(ids.personalProfile, DOC, 1);
      await issueLot(ids.personalProfile, BIO, 1);
      const documentId = await reservedDocument(ids.personalAccount);
      const collaboratorId = await createBiometricSigner(documentId);
      await reserveBiometric.reserveForCollaborators({
        documentId,
        collaboratorIds: [collaboratorId],
      });

      await expect(
        undoMigrationsThrough(
          'AddCollaboratorToCreditReservations1784300000098',
        ),
      ).rejects.toThrow(/sin intento de Didit/);
      const [column] = await dataSource.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'credit_reservations' AND column_name = 'collaborator_id'`,
      );
      expect(column).toBeDefined();
    });

    it('el ledger es inmutable: rechaza UPDATE, DELETE y TRUNCATE', async () => {
      await issueLot(ids.personalProfile, DOC, 1);

      await expect(
        dataSource.query(`UPDATE credit_ledger_entries SET quantity = 99`),
      ).rejects.toThrow(/inmutable/);
      await expect(
        dataSource.query(`DELETE FROM credit_ledger_entries`),
      ).rejects.toThrow(/inmutable/);
      await expect(
        dataSource.query(`TRUNCATE credit_ledger_entries`),
      ).rejects.toThrow(/inmutable/);
    });
  });

  describe('compras y saldos', () => {
    it('una compra acreditada a un perfil personal suma sólo a su saldo y a su tipo', async () => {
      await issueLot(ids.personalProfile, BIO, 5);

      expect(
        await countAvailableCredits(
          dataSource.manager,
          ids.personalProfile,
          BIO,
        ),
      ).toBe(5);
      expect(
        await countAvailableCredits(
          dataSource.manager,
          ids.personalProfile,
          DOC,
        ),
      ).toBe(0);
      expect(
        await countAvailableCredits(
          dataSource.manager,
          ids.organizationProfile,
          BIO,
        ),
      ).toBe(0);
    });

    it('una compra acreditada a un perfil organizacional la usan sus miembros y no toca el personal', async () => {
      await issueLot(ids.organizationProfile, DOC, 1);
      await issueLot(ids.organizationProfile, BIO, 7);

      // El miembro reserva desde su cuenta de organización: paga el perfil compartido.
      const documentId = await reservedDocument(ids.organizationAccount);
      const attemptId = await createAttempt(documentId);
      const reservation = await reserveBiometric.execute({
        biometricSignatureAttemptId: attemptId,
        documentId,
      });

      expect(reservation.billingProfileId).toBe(ids.organizationProfile);
      expect(
        await countAvailableCredits(
          dataSource.manager,
          ids.organizationProfile,
          BIO,
        ),
      ).toBe(6);
      expect(
        await countAvailableCredits(
          dataSource.manager,
          ids.personalProfile,
          BIO,
        ),
      ).toBe(0);
    });

    it('el disponible es remaining menos lo reservado', async () => {
      await issueLot(ids.organizationProfile, DOC, 3);
      await reservedDocument(ids.organizationAccount);

      expect(
        await countAvailableCredits(
          dataSource.manager,
          ids.organizationProfile,
          DOC,
        ),
      ).toBe(2);
    });
  });

  describe('reserva documental', () => {
    it('reserva un crédito por documento y es idempotente por documento', async () => {
      const lotId = await issueLot(ids.personalProfile, DOC, 2);
      const documentId = await createDocument(ids.personalAccount);

      const first = await reserveDocument.execute({
        documentId,
        accountId: ids.personalAccount,
        userId: ids.user,
      });
      const retry = await reserveDocument.execute({
        documentId,
        accountId: ids.personalAccount,
        userId: ids.user,
      });

      expect(retry.id).toBe(first.id);
      expect(first).toMatchObject({
        billingProfileId: ids.personalProfile,
        creditLotId: lotId,
        creditType: DOC,
        status: 'ACTIVE',
        expiresAt: null,
      });
      expect(await lot(lotId)).toEqual({ remaining: 2, reserved: 1 });
    });

    it('sin saldo documental responde 402 y no deja nada reservado', async () => {
      const documentId = await createDocument(ids.personalAccount);

      await expect(
        reserveDocument.execute({
          documentId,
          accountId: ids.personalAccount,
          userId: ids.user,
        }),
      ).rejects.toBeInstanceOf(InsufficientDocumentCreditsException);
      expect(await credits.findDocumentReservation(documentId)).toBeNull();
    });
  });

  describe('reserva biométrica', () => {
    it('la paga el perfil de la reserva documental del documento', async () => {
      await issueLot(ids.organizationProfile, DOC, 1);
      const bioLot = await issueLot(ids.organizationProfile, BIO, 1);
      const documentId = await reservedDocument(ids.organizationAccount);
      const attemptId = await createAttempt(documentId);

      const reservation = await reserveBiometric.execute({
        biometricSignatureAttemptId: attemptId,
        documentId,
      });

      expect(reservation).toMatchObject({
        billingProfileId: ids.organizationProfile,
        creditLotId: bioLot,
        creditType: BIO,
        biometricSignatureAttemptId: attemptId,
        status: 'ACTIVE',
      });
      // Comprometida con el colaborador hasta el cierre del documento: no vence sola.
      expect(reservation.expiresAt).toBeNull();
    });

    it('reintento de creación de sesión: el mismo intento reutiliza su reserva, también en paralelo', async () => {
      await issueLot(ids.personalProfile, DOC, 1);
      const bioLot = await issueLot(ids.personalProfile, BIO, 3);
      const documentId = await reservedDocument(ids.personalAccount);
      const attemptId = await createAttempt(documentId);

      const [a, b, c] = await Promise.all([
        reserveBiometric.execute({
          biometricSignatureAttemptId: attemptId,
          documentId,
        }),
        reserveBiometric.execute({
          biometricSignatureAttemptId: attemptId,
          documentId,
        }),
        reserveBiometric.execute({
          biometricSignatureAttemptId: attemptId,
          documentId,
        }),
      ]);

      expect(new Set([a.id, b.id, c.id]).size).toBe(1);
      expect(await lot(bioLot)).toEqual({ remaining: 3, reserved: 1 });
    });

    it('reserva concurrente del último crédito: sólo uno lo obtiene, el otro recibe 402', async () => {
      await issueLot(ids.personalProfile, DOC, 1);
      const bioLot = await issueLot(ids.personalProfile, BIO, 1);
      const documentId = await reservedDocument(ids.personalAccount);
      const attemptA = await createAttempt(documentId);
      const attemptB = await createAttempt(documentId);

      const results = await Promise.allSettled([
        reserveBiometric.execute({
          biometricSignatureAttemptId: attemptA,
          documentId,
        }),
        reserveBiometric.execute({
          biometricSignatureAttemptId: attemptB,
          documentId,
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(
        InsufficientBiometricCreditsException,
      );
      expect(await lot(bioLot)).toEqual({ remaining: 1, reserved: 1 });
    });

    it('un documento biométrico anterior a las reservas lo paga el perfil de su recibo de consumo', async () => {
      await issueLot(ids.organizationProfile, DOC, 1);
      const bioLot = await issueLot(ids.organizationProfile, BIO, 1);
      const legacyDocument = await createDocument(ids.organizationAccount);
      await consumeDocument.execute({
        documentId: legacyDocument,
        accountId: ids.organizationAccount,
        userId: ids.user,
      });
      const attemptId = await createAttempt(legacyDocument);

      const reservation = await reserveBiometric.execute({
        biometricSignatureAttemptId: attemptId,
        documentId: legacyDocument,
      });

      expect(reservation).toMatchObject({
        billingProfileId: ids.organizationProfile,
        creditLotId: bioLot,
      });
    });

    it('sin saldo biométrico bloquea el inicio (402)', async () => {
      await issueLot(ids.personalProfile, DOC, 1);
      const documentId = await reservedDocument(ids.personalAccount);
      const attemptId = await createAttempt(documentId);

      await expect(
        reserveBiometric.execute({
          biometricSignatureAttemptId: attemptId,
          documentId,
        }),
      ).rejects.toBeInstanceOf(InsufficientBiometricCreditsException);
    });

    it('falla de Didit antes de crear la sesión: el crédito NO vuelve al saldo y el siguiente intento lo reutiliza', async () => {
      await issueLot(ids.personalProfile, DOC, 1);
      const bioLot = await issueLot(ids.personalProfile, BIO, 1);
      const documentId = await reservedDocument(ids.personalAccount);
      const collaboratorId = await createBiometricSigner(documentId);
      const failedAttempt = await createAttempt(
        documentId,
        'PENDING',
        collaboratorId,
      );
      const reservation = await reserveBiometric.execute({
        biometricSignatureAttemptId: failedAttempt,
        documentId,
      });

      await expect(
        finalize.onAttemptFailed({
          biometricSignatureAttemptId: failedAttempt,
          reason: 'DIDIT_SESSION_NOT_CREATED',
        }),
      ).resolves.toBe(false);
      expect(await lot(bioLot)).toEqual({ remaining: 1, reserved: 1 });
      expect((await credits.findByAttempt(failedAttempt))?.status).toBe(
        'ACTIVE',
      );

      // Sin saldo libre, el reintento del mismo colaborador se asocia a su misma reserva.
      await dataSource.query(
        `UPDATE biometric_signature_attempts SET status = 'FAILED' WHERE id = $1`,
        [failedAttempt],
      );
      const retryAttempt = await createAttempt(
        documentId,
        'PENDING',
        collaboratorId,
      );
      await expect(
        reserveBiometric.execute({
          biometricSignatureAttemptId: retryAttempt,
          documentId,
        }),
      ).resolves.toMatchObject({
        id: reservation.id,
        biometricSignatureAttemptId: retryAttempt,
      });
      expect(await lot(bioLot)).toEqual({ remaining: 1, reserved: 1 });
    });
  });

  describe('reserva biométrica por colaborador (sin sesión de Didit)', () => {
    /** Documento con su reserva documental y tres firmantes biométricos. */
    async function threeSignerDocument(bioCredits: number, docCredits = 1) {
      await issueLot(ids.personalProfile, DOC, docCredits);
      const bioLot = await issueLot(ids.personalProfile, BIO, bioCredits);
      const documentId = await reservedDocument(ids.personalAccount);
      const collaboratorIds = [
        await createBiometricSigner(documentId),
        await createBiometricSigner(documentId),
        await createBiometricSigner(documentId),
      ];
      return { bioLot, documentId, collaboratorIds };
    }

    it('un documento con tres colaboradores biométricos queda con tres reservas, sin intento', async () => {
      const { bioLot, documentId, collaboratorIds } =
        await threeSignerDocument(3);

      const reservations = await reserveBiometric.reserveForCollaborators({
        documentId,
        collaboratorIds,
      });

      expect(reservations).toHaveLength(3);
      reservations.forEach((reservation, index) => {
        expect(reservation).toMatchObject({
          billingProfileId: ids.personalProfile,
          creditLotId: bioLot,
          creditType: BIO,
          documentId,
          collaboratorId: collaboratorIds[index],
          biometricSignatureAttemptId: null,
          quantity: 1,
          status: 'ACTIVE',
          expiresAt: null,
        });
      });
      expect(await lot(bioLot)).toEqual({ remaining: 3, reserved: 3 });
      const entries = await dataSource.query(
        `SELECT metadata->>'collaboratorId' AS collaborator FROM credit_ledger_entries WHERE document_id = $1 AND credit_type = $2 AND movement_type = 'RESERVE' ORDER BY created_at`,
        [documentId, BIO],
      );
      expect(
        entries.map((e: { collaborator: string }) => e.collaborator),
      ).toEqual(collaboratorIds);
    });

    it('reintento de creación no duplica las reservas, también en paralelo', async () => {
      const { bioLot, documentId, collaboratorIds } =
        await threeSignerDocument(5);
      const first = await reserveBiometric.reserveForCollaborators({
        documentId,
        collaboratorIds,
      });
      const ledgerBefore = await ledgerCount();

      const retries = await Promise.all([
        reserveBiometric.reserveForCollaborators({
          documentId,
          collaboratorIds,
        }),
        reserveBiometric.reserveForCollaborators({
          documentId,
          collaboratorIds: [...collaboratorIds].reverse(),
        }),
      ]);

      const firstIds = new Set(first.map(({ id }) => id));
      for (const retry of retries) {
        expect(new Set(retry.map(({ id }) => id))).toEqual(firstIds);
      }
      expect(await lot(bioLot)).toEqual({ remaining: 5, reserved: 3 });
      expect(await ledgerCount()).toBe(ledgerBefore);
    });

    it('sin saldo para todos no reserva a ninguno (402)', async () => {
      const { bioLot, documentId, collaboratorIds } =
        await threeSignerDocument(2);

      await expect(
        reserveBiometric.reserveForCollaborators({
          documentId,
          collaboratorIds,
        }),
      ).rejects.toBeInstanceOf(InsufficientBiometricCreditsException);
      expect(await lot(bioLot)).toEqual({ remaining: 2, reserved: 0 });
      expect(await credits.findActiveByDocument(documentId)).toHaveLength(1);
    });

    it('rechaza colaboradores que no son firmantes biométricos del documento', async () => {
      const { documentId } = await threeSignerDocument(3, 2);
      const otherDocument = await reservedDocument(ids.personalAccount);
      const foreign = await createBiometricSigner(otherDocument);
      const simpleSigner = await insertReturningId(
        `INSERT INTO collaborators (document_id, ip_address, colaborator_type, signature_type) VALUES ($1, '127.0.0.1', 'SIGNER', 'SIMPLE')`,
        [documentId],
      );

      for (const collaboratorId of [foreign, simpleSigner]) {
        await expect(
          reserveBiometric.reserveForCollaborators({
            documentId,
            collaboratorIds: [collaboratorId],
          }),
        ).rejects.toThrow(/no son firmantes biométricos/);
      }
    });

    it('al abrir la sesión, el intento se asocia a la reserva del colaborador y no bloquea otro crédito', async () => {
      const { bioLot, documentId, collaboratorIds } =
        await threeSignerDocument(3);
      const [reservation] = await reserveBiometric.reserveForCollaborators({
        documentId,
        collaboratorIds,
      });
      const attemptId = await createAttempt(
        documentId,
        'PENDING',
        collaboratorIds[0],
      );

      const [a, b] = await Promise.all([
        reserveBiometric.execute({
          biometricSignatureAttemptId: attemptId,
          documentId,
        }),
        reserveBiometric.execute({
          biometricSignatureAttemptId: attemptId,
          documentId,
        }),
      ]);

      expect(a.id).toBe(reservation.id);
      expect(b.id).toBe(reservation.id);
      expect(a.biometricSignatureAttemptId).toBe(attemptId);
      expect(await credits.findByAttempt(attemptId)).toMatchObject({
        id: reservation.id,
        collaboratorId: collaboratorIds[0],
      });
      expect(await lot(bioLot)).toEqual({ remaining: 3, reserved: 3 });

      // Firmar consume la reserva apartada al crear el documento.
      await dataSource.query(
        `UPDATE biometric_signature_attempts SET status = 'APPROVED' WHERE id = $1`,
        [attemptId],
      );
      await expect(
        finalize.onSignatureSucceeded({
          biometricSignatureAttemptId: attemptId,
          documentId,
          documentCompleted: false,
        }),
      ).resolves.toEqual({ biometricConsumed: true, documentConsumed: false });
      expect(await lot(bioLot)).toEqual({ remaining: 2, reserved: 2 });
    });

    it('un colaborador sin crédito apartado reserva el suyo al abrir la sesión', async () => {
      await issueLot(ids.personalProfile, DOC, 1);
      const bioLot = await issueLot(ids.personalProfile, BIO, 1);
      const documentId = await reservedDocument(ids.personalAccount);
      const collaboratorId = await createBiometricSigner(documentId);
      const attemptId = await createAttempt(
        documentId,
        'PENDING',
        collaboratorId,
      );

      const reservation = await reserveBiometric.execute({
        biometricSignatureAttemptId: attemptId,
        documentId,
      });

      expect(reservation).toMatchObject({
        documentId,
        collaboratorId,
        biometricSignatureAttemptId: attemptId,
      });
      // Ya tiene su reserva activa: apartar al colaborador devuelve esa misma.
      await expect(
        reserveBiometric.reserveForCollaborators({
          documentId,
          collaboratorIds: [collaboratorId],
        }),
      ).resolves.toEqual([expect.objectContaining({ id: reservation.id })]);
      expect(await lot(bioLot)).toEqual({ remaining: 1, reserved: 1 });
    });

    it('la base impide dos reservas activas del mismo colaborador y exige documento, colaborador y 1 crédito', async () => {
      const { bioLot, documentId, collaboratorIds } = await threeSignerDocument(
        3,
        2,
      );
      await reserveBiometric.reserveForCollaborators({
        documentId,
        collaboratorIds: [collaboratorIds[0]],
      });
      const insert = (collaboratorId: string | null, quantity = 1) =>
        dataSource.query(
          `INSERT INTO credit_reservations (billing_profile_id, credit_lot_id, credit_type, document_id, collaborator_id, quantity) VALUES ($1, $2, 'BIOMETRIC_SIGNATURE', $3, $4, $5)`,
          [ids.personalProfile, bioLot, documentId, collaboratorId, quantity],
        );

      await expect(insert(collaboratorIds[0])).rejects.toThrow(
        /UQ_credit_reservations_active_biometric_collaborator/,
      );
      await expect(insert(null)).rejects.toThrow(
        /CHK_credit_reservations_subject/,
      );
      await expect(insert(collaboratorIds[1], 2)).rejects.toThrow(
        /CHK_credit_reservations_biometric_quantity/,
      );

      const otherDocument = await reservedDocument(ids.personalAccount);
      const foreign = await createBiometricSigner(otherDocument);
      await expect(insert(foreign)).rejects.toThrow(
        /FK_credit_reservations_collaborator/,
      );
    });

    it('liberada la reserva del colaborador, puede volver a tener una activa', async () => {
      const { bioLot, documentId, collaboratorIds } =
        await threeSignerDocument(3);
      const [reservation] = await reserveBiometric.reserveForCollaborators({
        documentId,
        collaboratorIds: [collaboratorIds[0]],
      });
      await credits.release({
        reservationId: reservation.id,
        reason: 'TEST',
      });
      const attemptId = await createAttempt(
        documentId,
        'PENDING',
        collaboratorIds[0],
      );

      const next = await reserveBiometric.execute({
        biometricSignatureAttemptId: attemptId,
        documentId,
      });

      expect(next.id).not.toBe(reservation.id);
      expect(next).toMatchObject({
        collaboratorId: collaboratorIds[0],
        status: 'ACTIVE',
      });
      expect(await lot(bioLot)).toEqual({ remaining: 3, reserved: 1 });
    });
  });

  describe('resultado de Didit', () => {
    async function signingScenario() {
      const docLot = await issueLot(ids.personalProfile, DOC, 1);
      const bioLot = await issueLot(ids.personalProfile, BIO, 1);
      const documentId = await reservedDocument(ids.personalAccount);
      const attemptId = await createAttempt(documentId, 'APPROVED');
      await reserveBiometric.execute({
        biometricSignatureAttemptId: attemptId,
        documentId,
      });
      return { docLot, bioLot, documentId, attemptId };
    }

    it('firma biométrica exitosa: consume el crédito biométrico y deja el documental reservado', async () => {
      const { docLot, bioLot, documentId, attemptId } = await signingScenario();

      await expect(
        finalize.onSignatureSucceeded({
          biometricSignatureAttemptId: attemptId,
          documentId,
          documentCompleted: false,
        }),
      ).resolves.toEqual({ biometricConsumed: true, documentConsumed: false });

      expect(await lot(bioLot)).toEqual({ remaining: 0, reserved: 0 });
      expect(await lot(docLot)).toEqual({ remaining: 1, reserved: 1 });
    });

    it('webhook de aprobación repetido: no consume dos veces ni duplica movimientos', async () => {
      const { bioLot, documentId, attemptId } = await signingScenario();
      const input = {
        biometricSignatureAttemptId: attemptId,
        documentId,
        documentCompleted: true,
      };

      await finalize.onSignatureSucceeded(input);
      const movements = await ledgerCount();
      const [second, third] = await Promise.all([
        finalize.onSignatureSucceeded(input),
        finalize.onSignatureSucceeded(input),
      ]);

      expect(second).toEqual({
        biometricConsumed: false,
        documentConsumed: false,
      });
      expect(third).toEqual({
        biometricConsumed: false,
        documentConsumed: false,
      });
      expect(await ledgerCount()).toBe(movements);
      expect(await lot(bioLot)).toEqual({ remaining: 0, reserved: 0 });
    });

    it('documento biométrico completado: consume el crédito documental una sola vez y deja su recibo', async () => {
      const { docLot, documentId, attemptId } = await signingScenario();

      await finalize.onSignatureSucceeded({
        biometricSignatureAttemptId: attemptId,
        documentId,
        documentCompleted: true,
      });

      expect(await lot(docLot)).toEqual({ remaining: 0, reserved: 0 });
      const receipts = await dataSource.query(
        `SELECT credit_lot_id, signature_type, credits_consumed FROM document_credit_consumptions WHERE document_id = $1`,
        [documentId],
      );
      expect(receipts).toEqual([
        {
          credit_lot_id: docLot,
          signature_type: 'BIOMETRIC',
          credits_consumed: 1,
        },
      ]);

      // Ni el consumo inmediato puede volver a cobrar ese documento.
      const consumes = await dataSource.query(
        `SELECT count(*)::int AS n FROM credit_ledger_entries WHERE idempotency_key = $1`,
        [`consume:document:${documentId}`],
      );
      expect(consumes[0].n).toBe(1);
    });

    it('webhook de rechazo repetido: no libera ni mueve nada', async () => {
      const { bioLot, attemptId } = await signingScenario();
      const input = {
        biometricSignatureAttemptId: attemptId,
        reason: 'DIDIT_DECLINED',
      };
      const ledgerBefore = await ledgerCount();

      const results = await Promise.all([
        finalize.onAttemptFailed(input),
        finalize.onAttemptFailed(input),
      ]);

      expect(results).toEqual([false, false]);
      expect(await lot(bioLot)).toEqual({ remaining: 1, reserved: 1 });
      expect(await ledgerCount()).toBe(ledgerBefore);
    });

    it('documento rechazado con reservas activas: libera la documental y CONSUME la biométrica', async () => {
      const { docLot, bioLot, documentId } = await signingScenario();

      await expect(
        finalize.onDocumentClosed({
          documentId,
          closureReason: DOCUMENT_CLOSURE_REASON_ENUM.DOCUMENT_REJECTED,
        }),
      ).resolves.toBe(2);
      await expect(
        finalize.onDocumentClosed({
          documentId,
          closureReason: DOCUMENT_CLOSURE_REASON_ENUM.DOCUMENT_REJECTED,
        }),
      ).resolves.toBe(0);

      expect(await lot(docLot)).toEqual({ remaining: 1, reserved: 0 });
      expect(await lot(bioLot)).toEqual({ remaining: 0, reserved: 0 });
    });
  });

  describe('cierre del documento: las biométricas se consumen, nunca se liberan', () => {
    /** Documento con su reserva documental y tres colaboradores biométricos con su crédito. */
    async function documentWithThreeSigners(account = ids.organizationAccount) {
      const profile =
        account === ids.organizationAccount
          ? ids.organizationProfile
          : ids.personalProfile;
      const docLot = await issueLot(profile, DOC, 1);
      const bioLot = await issueLot(profile, BIO, 3);
      const documentId = await reservedDocument(account);
      const collaboratorIds = [
        await createBiometricSigner(documentId),
        await createBiometricSigner(documentId),
        await createBiometricSigner(documentId),
      ];
      await reserveBiometric.reserveForCollaborators({
        documentId,
        collaboratorIds,
      });
      return { docLot, bioLot, documentId, collaboratorIds };
    }

    async function biometricStatuses(documentId: string): Promise<string[]> {
      const rows = await dataSource.query(
        `SELECT status FROM credit_reservations WHERE document_id = $1 AND credit_type = $2 ORDER BY created_at`,
        [documentId, BIO],
      );
      return rows.map((r: { status: string }) => r.status);
    }

    async function closureEntries(documentId: string) {
      return dataSource.query(
        `SELECT movement_type, quantity, credit_reservation_id, document_id,
                metadata->>'closureReason' AS closure_reason,
                metadata->>'collaboratorId' AS collaborator_id,
                metadata->>'organizationId' AS organization_id
           FROM credit_ledger_entries
          WHERE document_id = $1 AND credit_type = $2 AND movement_type <> 'RESERVE'
          ORDER BY created_at`,
        [documentId, BIO],
      );
    }

    it.each([
      [DOCUMENT_CLOSURE_REASON_ENUM.DOCUMENT_SIGNED, 'SIGNED'],
      [DOCUMENT_CLOSURE_REASON_ENUM.DOCUMENT_REJECTED, 'REJECTED'],
      [DOCUMENT_CLOSURE_REASON_ENUM.DOCUMENT_CANCELLED, 'CANCELLED'],
      [DOCUMENT_CLOSURE_REASON_ENUM.DOCUMENT_EXPIRED, 'EXPIRED'],
    ])(
      '%s: consume las tres reservas aunque nadie haya abierto sesión, y lo registra en el ledger',
      async (closureReason, documentStatus) => {
        const { bioLot, documentId, collaboratorIds } =
          await documentWithThreeSigners();

        // Cambio de estado y cierre en la misma transacción, como en la aplicación.
        const result = await dataSource.transaction(async (manager) => {
          await manager.query(
            `UPDATE documents SET status = $2 WHERE id = $1`,
            [documentId, documentStatus],
          );
          return closeBiometric.execute({ documentId, closureReason }, manager);
        });

        expect(result).toEqual({ consumed: 3 });
        expect(await biometricStatuses(documentId)).toEqual([
          'CONSUMED',
          'CONSUMED',
          'CONSUMED',
        ]);
        expect(await lot(bioLot)).toEqual({ remaining: 0, reserved: 0 });

        const reservations = await dataSource.query(
          `SELECT id, consumed_at, released_at FROM credit_reservations WHERE document_id = $1 AND credit_type = $2 ORDER BY created_at`,
          [documentId, BIO],
        );
        reservations.forEach(
          (r: { consumed_at: Date | null; released_at: Date | null }) => {
            expect(r.consumed_at).toBeInstanceOf(Date);
            expect(r.released_at).toBeNull();
          },
        );
        expect(await closureEntries(documentId)).toEqual(
          reservations.map((r: { id: string }, index: number) => ({
            movement_type: 'CONSUME',
            quantity: 1,
            credit_reservation_id: r.id,
            document_id: documentId,
            closure_reason: closureReason,
            collaborator_id: collaboratorIds[index],
            organization_id: null,
          })),
        );
      },
    );

    it('guarda la organización del documento en el ledger', async () => {
      const { documentId } = await documentWithThreeSigners();
      await dataSource.query(
        `UPDATE documents SET organization_id = $2 WHERE id = $1`,
        [documentId, ids.organization],
      );

      await closeBiometric.execute({
        documentId,
        closureReason: DOCUMENT_CLOSURE_REASON_ENUM.DOCUMENT_SIGNED,
      });

      const entries = await closureEntries(documentId);
      expect(entries).toHaveLength(3);
      expect(
        entries.every(
          (e: { organization_id: string }) =>
            e.organization_id === ids.organization,
        ),
      ).toBe(true);
    });

    it('procesar el mismo cierre dos veces (también en paralelo) no duplica consumos', async () => {
      const { bioLot, documentId } = await documentWithThreeSigners();
      const input = {
        documentId,
        closureReason: DOCUMENT_CLOSURE_REASON_ENUM.DOCUMENT_REJECTED,
      };

      const results = await Promise.all([
        closeBiometric.execute(input),
        closeBiometric.execute(input),
      ]);
      const late = await closeBiometric.execute(input);

      expect(results.reduce((sum, r) => sum + r.consumed, 0)).toBe(3);
      expect(late).toEqual({ consumed: 0 });
      expect(await closureEntries(documentId)).toHaveLength(3);
      expect(await lot(bioLot)).toEqual({ remaining: 0, reserved: 0 });
    });

    it('una reserva ya consumida al firmar se ignora sin error al cerrar el documento', async () => {
      const { bioLot, documentId, collaboratorIds } =
        await documentWithThreeSigners();
      const attemptId = await createAttempt(
        documentId,
        'APPROVED',
        collaboratorIds[0],
      );
      await reserveBiometric.execute({
        biometricSignatureAttemptId: attemptId,
        documentId,
      });
      await finalize.onSignatureSucceeded({
        biometricSignatureAttemptId: attemptId,
        documentId,
        documentCompleted: false,
      });

      await expect(
        closeBiometric.execute({
          documentId,
          closureReason: DOCUMENT_CLOSURE_REASON_ENUM.DOCUMENT_REJECTED,
        }),
      ).resolves.toEqual({ consumed: 2 });
      expect(await biometricStatuses(documentId)).toEqual([
        'CONSUMED',
        'CONSUMED',
        'CONSUMED',
      ]);
      expect(await lot(bioLot)).toEqual({ remaining: 0, reserved: 0 });
    });

    it('si el consumo falla, el cambio de estado del documento se deshace con él', async () => {
      const { bioLot, documentId } = await documentWithThreeSigners();
      // Inconsistencia: el lote ya no tiene bloqueado lo que las reservas dicen.
      await dataSource.query(
        `UPDATE credit_lots SET reserved = 0 WHERE id = $1`,
        [bioLot],
      );

      await expect(
        dataSource.transaction(async (manager) => {
          await manager.query(
            `UPDATE documents SET status = 'REJECTED' WHERE id = $1`,
            [documentId],
          );
          await finalize.onDocumentClosed(
            {
              documentId,
              closureReason: DOCUMENT_CLOSURE_REASON_ENUM.DOCUMENT_REJECTED,
            },
            manager,
          );
        }),
      ).rejects.toThrow(/no tiene bloqueados/);

      const [document] = await dataSource.query(
        `SELECT status FROM documents WHERE id = $1`,
        [documentId],
      );
      expect(document.status).toBe('PENDING_SIGNATURE');
      expect(await biometricStatuses(documentId)).toEqual([
        'ACTIVE',
        'ACTIVE',
        'ACTIVE',
      ]);
    });

    it('el job consume las biométricas de un documento vencido o firmado que nadie cerró, y libera sólo la documental', async () => {
      const expired = await documentWithThreeSigners(ids.personalAccount);
      await dataSource.query(
        `UPDATE documents SET status = 'EXPIRED' WHERE id = $1`,
        [expired.documentId],
      );

      const first = await releaseExpired.execute();
      const second = await releaseExpired.execute();

      // El job barre toda la base; se comprueba sólo lo de este documento.
      expect(first.failed).toBe(0);
      expect(first.consumed).toBeGreaterThanOrEqual(3);
      expect(second).toMatchObject({ orphaned: 0, consumed: 0 });
      expect(await biometricStatuses(expired.documentId)).toEqual([
        'CONSUMED',
        'CONSUMED',
        'CONSUMED',
      ]);
      expect(
        (await closureEntries(expired.documentId)).map(
          (e: { closure_reason: string }) => e.closure_reason,
        ),
      ).toEqual(Array(3).fill(DOCUMENT_CLOSURE_REASON_ENUM.DOCUMENT_EXPIRED));
      expect(await lot(expired.docLot)).toEqual({ remaining: 1, reserved: 0 });
      expect(await lot(expired.bioLot)).toEqual({ remaining: 0, reserved: 0 });
    });

    it('ningún movimiento RELEASE de créditos biométricos en todo el cierre', async () => {
      const { documentId } = await documentWithThreeSigners();
      await finalize.onDocumentClosed({
        documentId,
        closureReason: DOCUMENT_CLOSURE_REASON_ENUM.DOCUMENT_CANCELLED,
      });
      await releaseExpired.execute();

      const [row] = await dataSource.query(
        `SELECT count(*)::int AS n FROM credit_ledger_entries WHERE document_id = $1 AND credit_type = $2 AND movement_type = 'RELEASE'`,
        [documentId, BIO],
      );
      expect(row.n).toBe(0);
    });
  });

  describe('expiración', () => {
    it('no libera biométricas vencidas (ni de intentos fallidos) y las de documentos cerrados se recogen', async () => {
      await issueLot(ids.organizationProfile, DOC, 2);
      const bioLot = await issueLot(ids.organizationProfile, BIO, 2);

      const documentId = await reservedDocument(ids.organizationAccount);
      const failedAttempt = await createAttempt(documentId, 'PENDING');
      const openAttempt = await createAttempt(documentId, 'PENDING');
      await reserveBiometric.execute({
        biometricSignatureAttemptId: failedAttempt,
        documentId,
      });
      await reserveBiometric.execute({
        biometricSignatureAttemptId: openAttempt,
        documentId,
      });
      await dataSource.query(
        `UPDATE biometric_signature_attempts SET status = 'FAILED' WHERE id = $1`,
        [failedAttempt],
      );
      await dataSource.query(
        `UPDATE credit_reservations SET expires_at = now() - interval '1 minute' WHERE biometric_signature_attempt_id IN ($1, $2)`,
        [failedAttempt, openAttempt],
      );

      const rejectedDocument = await reservedDocument(ids.organizationAccount);
      await dataSource.query(
        `UPDATE documents SET status = 'REJECTED' WHERE id = $1`,
        [rejectedDocument],
      );

      const first = await releaseExpired.execute();
      const second = await releaseExpired.execute();

      expect(first).toEqual({
        expired: 0,
        orphaned: 1,
        consumed: 0,
        failed: 0,
      });
      expect(second).toEqual({
        expired: 0,
        orphaned: 0,
        consumed: 0,
        failed: 0,
      });
      expect((await credits.findByAttempt(failedAttempt))?.status).toBe(
        'ACTIVE',
      );
      expect((await credits.findByAttempt(openAttempt))?.status).toBe('ACTIVE');
      expect(
        (await credits.findDocumentReservation(rejectedDocument))?.status,
      ).toBe('RELEASED');
      expect(await lot(bioLot)).toEqual({ remaining: 2, reserved: 2 });
    });
  });

  describe('saldos negativos', () => {
    it('la base rechaza reservar más de lo que queda o dejar remaining negativo', async () => {
      const lotId = await issueLot(ids.personalProfile, BIO, 1);

      await expect(
        dataSource.query(`UPDATE credit_lots SET reserved = 2 WHERE id = $1`, [
          lotId,
        ]),
      ).rejects.toThrow(/CHK_credit_lots_reserved/);
      await expect(
        dataSource.query(
          `UPDATE credit_lots SET remaining = -1 WHERE id = $1`,
          [lotId],
        ),
      ).rejects.toThrow(/CHK_credit_lots_(remaining|reserved)/);
    });

    it('si el lote no tiene bloqueado lo que la reserva dice, consumir falla y no cambia nada', async () => {
      await issueLot(ids.personalProfile, DOC, 1);
      const bioLot = await issueLot(ids.personalProfile, BIO, 1);
      const documentId = await reservedDocument(ids.personalAccount);
      const attemptId = await createAttempt(documentId, 'APPROVED');
      const reservation = await reserveBiometric.execute({
        biometricSignatureAttemptId: attemptId,
        documentId,
      });
      await dataSource.query(
        `UPDATE credit_lots SET reserved = 0 WHERE id = $1`,
        [bioLot],
      );

      await expect(
        credits.consume({ reservationId: reservation.id }),
      ).rejects.toThrow(/no tiene bloqueados/);
      expect((await credits.findByAttempt(attemptId))?.status).toBe('ACTIVE');
      expect(await lot(bioLot)).toEqual({ remaining: 1, reserved: 0 });
    });

    it('una reserva no puede apuntar a un lote de otro perfil (FK compuesta)', async () => {
      const otherLot = await issueLot(ids.organizationProfile, DOC, 1);
      const documentId = await createDocument(ids.personalAccount);

      await expect(
        dataSource.query(
          `INSERT INTO credit_reservations (billing_profile_id, credit_lot_id, credit_type, document_id, quantity) VALUES ($1, $2, 'DOCUMENT_SIGNATURE', $3, 1)`,
          [ids.personalProfile, otherLot, documentId],
        ),
      ).rejects.toThrow(/FK_credit_reservations_credit_lot/);
    });
  });

  it('el saldo de cada lote se reconstruye desde credit_ledger_entries', async () => {
    // Un poco de todo: consumo inmediato, reservas consumidas, liberadas y activas.
    await issueLot(ids.personalProfile, DOC, 3);
    await issueLot(ids.personalProfile, BIO, 2);
    const immediate = await createDocument(ids.personalAccount);
    await consumeDocument.execute({
      documentId: immediate,
      accountId: ids.personalAccount,
      userId: ids.user,
    });
    const signed = await reservedDocument(ids.personalAccount);
    const signedAttempt = await createAttempt(signed, 'APPROVED');
    await reserveBiometric.execute({
      biometricSignatureAttemptId: signedAttempt,
      documentId: signed,
    });
    await finalize.onSignatureSucceeded({
      biometricSignatureAttemptId: signedAttempt,
      documentId: signed,
      documentCompleted: true,
    });
    const pending = await reservedDocument(ids.personalAccount);
    const declined = await createAttempt(pending);
    await reserveBiometric.execute({
      biometricSignatureAttemptId: declined,
      documentId: pending,
    });
    await finalize.onAttemptFailed({
      biometricSignatureAttemptId: declined,
      reason: 'DIDIT_DECLINED',
    });

    const lotsReplayed = await dataSource.query(
      `SELECT count(*)::int AS n FROM credit_lots WHERE billing_profile_id = $1`,
      [ids.personalProfile],
    );
    expect(lotsReplayed[0].n).toBe(2);

    const mismatches = await dataSource.query(
      `
      WITH replay AS (
        SELECT credit_lot_id,
          SUM(CASE
                WHEN movement_type IN ('PURCHASE', 'GRANT', 'REFUND') THEN quantity
                WHEN movement_type = 'CONSUME' THEN -quantity
                ELSE 0 END) AS remaining,
          SUM(CASE
                WHEN movement_type = 'RESERVE' THEN quantity
                WHEN movement_type = 'RELEASE' THEN -quantity
                WHEN movement_type = 'CONSUME' AND credit_reservation_id IS NOT NULL THEN -quantity
                ELSE 0 END) AS reserved
        FROM credit_ledger_entries
        GROUP BY credit_lot_id
      )
      SELECT l.id, l.remaining, l.reserved, r.remaining AS replay_remaining, r.reserved AS replay_reserved
        FROM credit_lots l
        LEFT JOIN replay r ON r.credit_lot_id = l.id
       WHERE l.billing_profile_id = $1
         AND (r.credit_lot_id IS NULL OR l.remaining <> r.remaining OR l.reserved <> r.reserved)
    `,
      [ids.personalProfile],
    );

    expect(mismatches).toEqual([]);
    // Y el estado final es el esperado: 3 − 1 inmediato − 1 completado, con 1 aún reservado.
    expect(
      await countAvailableCredits(dataSource.manager, ids.personalProfile, DOC),
    ).toBe(0);
    // Biométricos: 2 − 1 consumido al firmar − 1 que sigue comprometido aunque Didit rechazó.
    expect(
      await countAvailableCredits(dataSource.manager, ids.personalProfile, BIO),
    ).toBe(0);
  });
});
