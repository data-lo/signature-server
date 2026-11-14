import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';

import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { COLABORATOR_TYPE_ENUM } from 'src/document/enum/colaborator-type.enum';
import { SIGNATURE_TYPE_ENUM } from 'src/document/enum/signature-type.enum';

import { CreditReservationEntity } from './credit-reservation.entity';
import { CreditReservationService } from './credit-reservation.service';
import { DocumentCreditConsumptionEntity } from './document-credit-consumption.entity';
import { CREDIT_RESERVATION_STATUS_ENUM } from '../enums/credit-reservation-status.enum';
import { CREDIT_TYPE_ENUM } from '../enums/credit-type.enum';
import { InsufficientBiometricCreditsException } from '../exceptions/billing.exceptions';

/** Un colaborador biométrico (y el intento de Didit que abra) cuesta un crédito biométrico. */
const CREDITS_PER_BIOMETRIC_SIGNER = 1;

/**
 * Vigencia de una reserva biométrica creada por un intento. Holgada a propósito: el job de
 * expiración NO libera la reserva de un intento que sigue abierto o aprobado (ver
 * `ReleaseExpiredCreditReservationsUseCase`), así que este plazo sólo marca desde cuándo puede
 * recogerse una reserva cuyo intento ya terminó sin que nadie la liberara. Las apartadas al crear
 * el documento no vencen solas.
 */
export const BIOMETRIC_RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;

export interface ReserveBiometricSignatureCreditsInput {
  biometricSignatureAttemptId: string;
  documentId: string;
}

/** Colaboradores biométricos de un documento a los que se aparta un crédito antes de Didit. */
export interface ReserveCollaboratorBiometricCreditsInput {
  documentId: string;
  /** Colaboradores firmantes biométricos del documento; uno o más. */
  collaboratorIds: string[];
  /**
   * Perfil que paga. Si se omite, el de la reserva documental del documento (o su recibo de
   * consumo); pasarlo sirve cuando la reserva documental se crea en la misma transacción.
   */
  billingProfileId?: string;
}

/**
 * Clave del movimiento `RESERVE` del crédito biométrico de un intento.
 *
 * @param biometricSignatureAttemptId - Intento.
 * @returns La clave `reserve:BIOMETRIC_SIGNATURE:<id>`.
 *
 * @example
 * ```ts
 * biometricReservationKey('att-1'); // 'reserve:BIOMETRIC_SIGNATURE:att-1'
 * ```
 */
export function biometricReservationKey(
  biometricSignatureAttemptId: string,
): string {
  return `reserve:${CREDIT_TYPE_ENUM.BIOMETRIC_SIGNATURE}:${biometricSignatureAttemptId}`;
}

/**
 * Clave del movimiento `RESERVE` del crédito biométrico apartado a un colaborador de un documento.
 *
 * @param documentId - Documento.
 * @param collaboratorId - Colaborador biométrico.
 * @returns La clave `reserve:BIOMETRIC_SIGNATURE:document:<doc>:collaborator:<col>`.
 *
 * @example
 * ```ts
 * collaboratorBiometricReservationKey('doc-1', 'col-1');
 * // 'reserve:BIOMETRIC_SIGNATURE:document:doc-1:collaborator:col-1'
 * ```
 */
export function collaboratorBiometricReservationKey(
  documentId: string,
  collaboratorId: string,
): string {
  return `reserve:${CREDIT_TYPE_ENUM.BIOMETRIC_SIGNATURE}:document:${documentId}:collaborator:${collaboratorId}`;
}

/**
 * Llave del advisory lock que serializa todo lo que reserva o asocia el crédito de un colaborador:
 * la reserva al crear el documento y la de cada intento comparten esta cola.
 *
 * @param documentId - Documento.
 * @param collaboratorId - Colaborador.
 * @returns La llave del lock.
 *
 * @example
 * ```ts
 * collaboratorReservationLock('doc-1', 'col-1'); // 'credit-reservation:biometric:doc-1:col-1'
 * ```
 */
function collaboratorReservationLock(
  documentId: string,
  collaboratorId: string,
): string {
  return `credit-reservation:biometric:${documentId}:${collaboratorId}`;
}

/**
 * Reserva créditos biométricos: uno por colaborador biométrico del documento.
 *
 * - **Por colaborador, desde la creación** (`reserveForCollaborators`): aparta el crédito de cada
 *   colaborador sin que exista sesión en Didit. Idempotente por documento y colaborador.
 * - **Por intento, antes de abrir la sesión** (`execute`): si el colaborador ya tiene su crédito
 *   apartado, el intento se asocia a esa reserva y no se bloquea otro. Si no lo tiene (documentos
 *   creados sin reservar), se reserva uno para el colaborador con el intento ya asociado.
 * - **Quién paga** lo decide el documento, no el firmante: el perfil es el de la reserva documental
 *   del documento (el creador lo pagó con su cuenta activa). Un documento biométrico creado antes
 *   de las reservas no tiene una, y entonces se usa el perfil del recibo de su consumo
 *   (`document_credit_consumptions`). El firmante —con cuenta o invitado— nunca paga.
 * - **Sin saldo, no hay sesión**: lanza 402 y el lanzador no llama a Didit.
 */
@Injectable()
export class ReserveBiometricSignatureCreditsUseCase {
  private readonly logger = new Logger(
    ReserveBiometricSignatureCreditsUseCase.name,
  );

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly credits: CreditReservationService,
  ) {}

  /**
   * Garantiza el crédito biométrico de un intento ANTES de abrir la sesión de Didit.
   *
   * Orden de búsqueda, serializado por colaborador:
   * 1. La reserva que ya tiene el intento (reintento, recarga, doble clic), en cualquier estado.
   * 2. La reserva activa del colaborador, a la que se asocia el intento.
   * 3. Una reserva nueva del colaborador con el intento asociado.
   *
   * @param input - Intento biométrico y su documento.
   * @param now - Instante de referencia para la vigencia; por defecto, el actual.
   * @returns La reserva biométrica del intento.
   *
   * @throws {InsufficientBiometricCreditsException} (402) Si no se puede saber qué perfil paga el
   *   documento o si ese perfil no tiene saldo biométrico disponible.
   * @throws {Error} Si el intento no existe o es de otro documento.
   *
   * @example
   * ```ts
   * await reserveBiometricCredits.execute({ biometricSignatureAttemptId: 'att-1', documentId: 'doc-1' });
   * ```
   */
  execute(
    input: ReserveBiometricSignatureCreditsInput,
    now: Date = new Date(),
  ): Promise<CreditReservationEntity> {
    return this.dataSource.transaction(async (tx) => {
      const collaboratorId = await this.resolveAttemptCollaborator(tx, input);
      await this.lockCollaborator(tx, input.documentId, collaboratorId);

      // Una reserva liberada no se vuelve a reservar con el mismo intento.
      const ofAttempt = await this.credits.findByAttempt(
        input.biometricSignatureAttemptId,
        tx,
      );
      if (ofAttempt) {
        if (ofAttempt.status !== CREDIT_RESERVATION_STATUS_ENUM.ACTIVE) {
          this.logger.warn(
            `El intento ${input.biometricSignatureAttemptId} ya tenía la reserva ${ofAttempt.id} en ${ofAttempt.status}; no se reserva otra.`,
          );
        }
        return ofAttempt;
      }

      const ofCollaborator =
        await this.credits.findActiveBiometricByCollaborator(
          { documentId: input.documentId, collaboratorId },
          tx,
        );
      if (ofCollaborator) {
        const attached = await this.credits.attachAttempt(
          {
            reservationId: ofCollaborator.id,
            biometricSignatureAttemptId: input.biometricSignatureAttemptId,
          },
          tx,
        );
        if (attached) {
          return attached;
        }
      }

      const billingProfileId = await this.requirePayingProfile(
        input.documentId,
        tx,
      );
      const { reservation } = await this.credits.reserve(
        {
          billingProfileId,
          creditType: CREDIT_TYPE_ENUM.BIOMETRIC_SIGNATURE,
          quantity: CREDITS_PER_BIOMETRIC_SIGNER,
          documentId: input.documentId,
          collaboratorId,
          biometricSignatureAttemptId: input.biometricSignatureAttemptId,
          expiresAt: new Date(now.getTime() + BIOMETRIC_RESERVATION_TTL_MS),
          idempotencyKey: biometricReservationKey(
            input.biometricSignatureAttemptId,
          ),
        },
        tx,
      );
      return reservation;
    });
  }

  /**
   * Aparta un crédito biométrico por cada colaborador indicado, sin intento de Didit. Pensado para
   * la creación del documento: un documento con tres firmantes biométricos queda con tres reservas.
   *
   * - **Idempotente**: un colaborador que ya tiene su reserva activa (o que ya reservó con esta
   *   misma clave) la devuelve sin bloquear otro crédito.
   * - **Todo o nada**: si falta saldo para uno, no queda reservado ninguno (una sola transacción).
   * - Las reservas no vencen solas (`expires_at = null`): viven lo que el documento; si se cierra
   *   sin completarse, las recoge el cierre o el job de expiración.
   *
   * @param input - Documento, colaboradores y, opcionalmente, el perfil que paga.
   * @param manager - Transacción del llamador (p. ej. la de creación del documento); sin ella abre
   *   una propia.
   * @returns Una reserva por colaborador, en el orden pedido y sin repetidos.
   *
   * @throws {Error} Si la lista está vacía, o algún colaborador no es firmante biométrico del
   *   documento.
   * @throws {InsufficientBiometricCreditsException} (402) Si no hay perfil que pague o le falta
   *   saldo biométrico para todos.
   *
   * @example
   * ```ts
   * const reservations = await reserveBiometricCredits.reserveForCollaborators({
   *   documentId: 'doc-1',
   *   collaboratorIds: ['col-a', 'col-b', 'col-c'],
   * });
   * reservations.length; // 3
   * ```
   */
  reserveForCollaborators(
    input: ReserveCollaboratorBiometricCreditsInput,
    manager?: EntityManager,
  ): Promise<CreditReservationEntity[]> {
    const run = async (
      tx: EntityManager,
    ): Promise<CreditReservationEntity[]> => {
      const collaboratorIds = [...new Set(input.collaboratorIds)];
      if (collaboratorIds.length === 0) {
        throw new Error(
          `No hay colaboradores biométricos que reservar en el documento ${input.documentId}.`,
        );
      }
      await this.assertBiometricSigners(tx, input.documentId, collaboratorIds);

      // Siempre en el mismo orden: dos llamadas con los colaboradores en otro orden se forman en vez
      // de bloquearse una a la otra (deadlock).
      for (const collaboratorId of [...collaboratorIds].sort()) {
        await this.lockCollaborator(tx, input.documentId, collaboratorId);
      }

      const billingProfileId =
        input.billingProfileId ??
        (await this.requirePayingProfile(input.documentId, tx));

      const reservations: CreditReservationEntity[] = [];
      for (const collaboratorId of collaboratorIds) {
        reservations.push(
          await this.reserveForCollaborator(tx, {
            documentId: input.documentId,
            collaboratorId,
            billingProfileId,
          }),
        );
      }
      return reservations;
    };

    return manager ? run(manager) : this.dataSource.transaction(run);
  }

  /**
   * Reserva —o devuelve la que ya tiene— el crédito de un colaborador. El llamador ya tomó el lock
   * del colaborador en esta transacción.
   *
   * @param tx - Transacción.
   * @param input - Documento, colaborador y perfil que paga.
   * @returns La reserva del colaborador.
   *
   * @throws {InsufficientBiometricCreditsException} (402) Sin saldo biométrico.
   *
   * @example
   * ```ts
   * await this.reserveForCollaborator(tx, { documentId: 'doc-1', collaboratorId: 'col-1', billingProfileId: 'bp-1' });
   * ```
   */
  private async reserveForCollaborator(
    tx: EntityManager,
    input: {
      documentId: string;
      collaboratorId: string;
      billingProfileId: string;
    },
  ): Promise<CreditReservationEntity> {
    const active = await this.credits.findActiveBiometricByCollaborator(
      { documentId: input.documentId, collaboratorId: input.collaboratorId },
      tx,
    );
    if (active) {
      return active;
    }

    const { reservation, created } = await this.credits.reserve(
      {
        billingProfileId: input.billingProfileId,
        creditType: CREDIT_TYPE_ENUM.BIOMETRIC_SIGNATURE,
        quantity: CREDITS_PER_BIOMETRIC_SIGNER,
        documentId: input.documentId,
        collaboratorId: input.collaboratorId,
        biometricSignatureAttemptId: null,
        expiresAt: null,
        idempotencyKey: collaboratorBiometricReservationKey(
          input.documentId,
          input.collaboratorId,
        ),
      },
      tx,
    );
    if (
      !created &&
      reservation.status !== CREDIT_RESERVATION_STATUS_ENUM.ACTIVE
    ) {
      this.logger.warn(
        `El colaborador ${input.collaboratorId} ya tuvo la reserva ${reservation.id} (${reservation.status}) en el documento ${input.documentId}; no se reserva otra.`,
      );
    }
    return reservation;
  }

  /**
   * Colaborador del intento, comprobando que el intento es del documento indicado.
   *
   * @param tx - Transacción.
   * @param input - Intento y documento.
   * @returns El `collaborator_id` del intento.
   *
   * @throws {Error} Si el intento no existe o es de otro documento.
   *
   * @example
   * ```ts
   * await this.resolveAttemptCollaborator(tx, { biometricSignatureAttemptId: 'att-1', documentId: 'doc-1' }); // 'col-1'
   * ```
   */
  private async resolveAttemptCollaborator(
    tx: EntityManager,
    input: ReserveBiometricSignatureCreditsInput,
  ): Promise<string> {
    const [attempt] = (await tx.query(
      `SELECT "collaborator_id", "document_id" FROM "biometric_signature_attempts" WHERE "id" = $1`,
      [input.biometricSignatureAttemptId],
    )) as { collaborator_id: string; document_id: string }[];
    if (!attempt || attempt.document_id !== input.documentId) {
      throw new Error(
        `El intento biométrico ${input.biometricSignatureAttemptId} no existe o no es del documento ${input.documentId}.`,
      );
    }
    return attempt.collaborator_id;
  }

  /**
   * Comprueba que todos los colaboradores son firmantes biométricos del documento.
   *
   * @param tx - Transacción.
   * @param documentId - Documento.
   * @param collaboratorIds - Colaboradores, sin repetidos.
   * @returns Nada.
   *
   * @throws {Error} Si alguno no existe, es de otro documento, no firma o no firma con biometría.
   *
   * @example
   * ```ts
   * await this.assertBiometricSigners(tx, 'doc-1', ['col-a', 'col-b']);
   * ```
   */
  private async assertBiometricSigners(
    tx: EntityManager,
    documentId: string,
    collaboratorIds: string[],
  ): Promise<void> {
    const found = await tx.getRepository(CollaboratorEntity).find({
      where: {
        id: In(collaboratorIds),
        documentId,
        colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
        signatureType: SIGNATURE_TYPE_ENUM.BIOMETRIC,
      },
      select: { id: true },
    });
    if (found.length !== collaboratorIds.length) {
      const valid = new Set(found.map(({ id }) => id));
      const invalid = collaboratorIds.filter((id) => !valid.has(id));
      throw new Error(
        `Los colaboradores ${invalid.join(', ')} no son firmantes biométricos del documento ${documentId}.`,
      );
    }
  }

  /**
   * Serializa, dentro de la transacción, todo lo que reserva o asocia el crédito del colaborador.
   *
   * @param tx - Transacción.
   * @param documentId - Documento.
   * @param collaboratorId - Colaborador.
   * @returns Nada.
   *
   * @example
   * ```ts
   * await this.lockCollaborator(tx, 'doc-1', 'col-1');
   * ```
   */
  private async lockCollaborator(
    tx: EntityManager,
    documentId: string,
    collaboratorId: string,
  ): Promise<void> {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      collaboratorReservationLock(documentId, collaboratorId),
    ]);
  }

  /**
   * Perfil que paga las firmas de un documento, o 402 si no hay ninguno.
   *
   * @param documentId - Documento.
   * @param manager - Transacción en curso.
   * @returns El `billing_profile_id`.
   *
   * @throws {InsufficientBiometricCreditsException} (402) Si el documento no tiene reserva ni
   *   consumo documental.
   *
   * @example
   * ```ts
   * await this.requirePayingProfile('doc-1', tx); // 'bp-1'
   * ```
   */
  private async requirePayingProfile(
    documentId: string,
    manager: EntityManager,
  ): Promise<string> {
    const billingProfileId = await this.resolvePayingProfile(
      documentId,
      manager,
    );
    if (!billingProfileId) {
      throw new InsufficientBiometricCreditsException(
        CREDITS_PER_BIOMETRIC_SIGNER,
        0,
        `El documento ${documentId} no tiene reserva ni consumo documental: no hay perfil que pague.`,
      );
    }
    return billingProfileId;
  }

  /**
   * Perfil que paga las firmas de un documento.
   *
   * @param documentId - Documento.
   * @param manager - Transacción en curso.
   * @returns El `billing_profile_id`, o `null` si el documento no tiene reserva ni consumo.
   *
   * @example
   * ```ts
   * await this.resolvePayingProfile('doc-1', tx); // 'bp-1'
   * ```
   */
  private async resolvePayingProfile(
    documentId: string,
    manager: EntityManager,
  ): Promise<string | null> {
    const documentReservation = await this.credits.findDocumentReservation(
      documentId,
      manager,
    );
    if (documentReservation) {
      return documentReservation.billingProfileId;
    }

    const consumption = await manager
      .getRepository(DocumentCreditConsumptionEntity)
      .findOne({ where: { documentId }, select: { billingProfileId: true } });

    return consumption?.billingProfileId ?? null;
  }
}
