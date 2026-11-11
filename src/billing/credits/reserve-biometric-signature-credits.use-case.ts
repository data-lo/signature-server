import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { CreditReservationEntity } from './credit-reservation.entity';
import { CreditReservationService } from './credit-reservation.service';
import { DocumentCreditConsumptionEntity } from './document-credit-consumption.entity';
import { CREDIT_RESERVATION_STATUS_ENUM } from '../enums/credit-reservation-status.enum';
import { CREDIT_TYPE_ENUM } from '../enums/credit-type.enum';
import { InsufficientBiometricCreditsException } from '../exceptions/billing.exceptions';

/** Un intento de Didit cuesta un crédito biométrico. */
const CREDITS_PER_BIOMETRIC_ATTEMPT = 1;

/**
 * Vigencia de una reserva biométrica. Holgada a propósito: el job de expiración NO libera la
 * reserva de un intento que sigue abierto o aprobado (ver
 * `ReleaseExpiredCreditReservationsUseCase`), así que este plazo sólo marca desde cuándo puede
 * recogerse una reserva cuyo intento ya terminó sin que nadie la liberara.
 */
export const BIOMETRIC_RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;

export interface ReserveBiometricSignatureCreditsInput {
  biometricSignatureAttemptId: string;
  documentId: string;
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
 * Reserva el crédito biométrico de un intento ANTES de abrir la sesión de Didit.
 *
 * - **Quién paga** lo decide el documento, no el firmante: el perfil es el de la reserva documental
 *   del documento (el creador lo pagó con su cuenta activa). Un documento biométrico creado antes
 *   de las reservas no tiene una, y entonces se usa el perfil del recibo de su consumo
 *   (`document_credit_consumptions`). El firmante —con cuenta o invitado— nunca paga.
 * - **Un crédito por intento, una sola vez**: un reintento (recarga, doble clic, intento ya abierto
 *   que se reutiliza) devuelve la reserva que ya existe.
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
   * Ejecuta el caso de uso.
   *
   * @param input - Intento biométrico y su documento.
   * @param now - Instante de referencia para la vigencia; por defecto, el actual.
   * @returns La reserva biométrica del intento (nueva o la que ya tenía).
   *
   * @throws {InsufficientBiometricCreditsException} (402) Si no se puede saber qué perfil paga el
   *   documento o si ese perfil no tiene saldo biométrico disponible.
   *
   * @example
   * ```ts
   * await reserveBiometricCredits.execute({ biometricSignatureAttemptId: 'att-1', documentId: 'doc-1' });
   * ```
   */
  async execute(
    input: ReserveBiometricSignatureCreditsInput,
    now: Date = new Date(),
  ): Promise<CreditReservationEntity> {
    const billingProfileId = await this.resolvePayingProfile(input.documentId);
    if (!billingProfileId) {
      throw new InsufficientBiometricCreditsException(
        CREDITS_PER_BIOMETRIC_ATTEMPT,
        0,
        `El documento ${input.documentId} no tiene reserva ni consumo documental: no hay perfil que pague.`,
      );
    }

    const { reservation, created } = await this.credits.reserve({
      billingProfileId,
      creditType: CREDIT_TYPE_ENUM.BIOMETRIC_SIGNATURE,
      quantity: CREDITS_PER_BIOMETRIC_ATTEMPT,
      documentId: input.documentId,
      biometricSignatureAttemptId: input.biometricSignatureAttemptId,
      expiresAt: new Date(now.getTime() + BIOMETRIC_RESERVATION_TTL_MS),
      idempotencyKey: biometricReservationKey(
        input.biometricSignatureAttemptId,
      ),
    });

    if (
      !created &&
      reservation.status !== CREDIT_RESERVATION_STATUS_ENUM.ACTIVE
    ) {
      this.logger.warn(
        `El intento ${input.biometricSignatureAttemptId} ya tenía la reserva ${reservation.id} en ${reservation.status}; no se reserva otra.`,
      );
    }

    return reservation;
  }

  /**
   * Perfil que paga las firmas de un documento.
   *
   * @param documentId - Documento.
   * @returns El `billing_profile_id`, o `null` si el documento no tiene reserva ni consumo.
   *
   * @example
   * ```ts
   * await this.resolvePayingProfile('doc-1'); // 'bp-1'
   * ```
   */
  private async resolvePayingProfile(
    documentId: string,
  ): Promise<string | null> {
    const documentReservation =
      await this.credits.findDocumentReservation(documentId);
    if (documentReservation) {
      return documentReservation.billingProfileId;
    }

    const consumption = await this.dataSource
      .getRepository(DocumentCreditConsumptionEntity)
      .findOne({ where: { documentId }, select: { billingProfileId: true } });

    return consumption?.billingProfileId ?? null;
  }
}
