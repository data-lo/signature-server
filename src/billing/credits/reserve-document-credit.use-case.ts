import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { CreditReservationEntity } from './credit-reservation.entity';
import { CreditReservationService } from './credit-reservation.service';
import { BillingOwnerService } from '../profiles/billing-owner.service';
import { CREDIT_TYPE_ENUM } from '../enums/credit-type.enum';
import { BILLING_SIGNATURE_TYPE_ENUM } from '../enums/billing-signature-type.enum';
import { InsufficientDocumentCreditsException } from '../exceptions/billing.exceptions';

/** Lo que cuesta un documento, igual que en el consumo inmediato. */
const CREDITS_PER_DOCUMENT = 1;

export interface ReserveDocumentCreditInput {
  /** Documento que se paga. Es la llave de idempotencia. */
  documentId: string;
  /** Cuenta activa (`X-Account-Id`): decide a qué propietario se le reserva. */
  accountId: string;
  userId: string;
  /** Tipo de firma del documento ya guardado; sólo se anota en el ledger. */
  signatureType?: BILLING_SIGNATURE_TYPE_ENUM | null;
}

/**
 * Clave del movimiento `RESERVE` del crédito documental de un documento.
 *
 * @param documentId - Documento.
 * @returns La clave `reserve:DOCUMENT_SIGNATURE:<id>`.
 *
 * @example
 * ```ts
 * documentReservationKey('doc-1'); // 'reserve:DOCUMENT_SIGNATURE:doc-1'
 * ```
 */
export function documentReservationKey(documentId: string): string {
  return `reserve:${CREDIT_TYPE_ENUM.DOCUMENT_SIGNATURE}:${documentId}`;
}

/**
 * Reserva el crédito documental de un documento biométrico al crearlo.
 *
 * Un documento biométrico no se cobra al crearse sino al completarse: si se rechaza o se cancela
 * antes, el crédito vuelve al saldo (ver `FinalizeBiometricSignatureCreditsUseCase`). Mientras
 * tanto queda bloqueado para que ninguna otra alta lo gaste.
 *
 * - Resuelve el perfil con `BillingOwnerService`, comprobando que el usuario pertenezca a la cuenta
 *   activa (sin eso, un `X-Account-Id` ajeno reservaría saldo de otra organización).
 * - **Corre dentro de la transacción del alta** cuando recibe `manager`: si no hay saldo, el
 *   documento se deshace con ella.
 * - **Idempotente por documento**: un reintento devuelve la reserva ya hecha.
 * - La reserva documental no vence sola (`expires_at` nulo): un documento puede tardar lo que
 *   tarden sus firmantes.
 */
@Injectable()
export class ReserveDocumentCreditUseCase {
  constructor(
    private readonly billingOwnerService: BillingOwnerService,
    private readonly credits: CreditReservationService,
  ) {}

  /**
   * Ejecuta el caso de uso.
   *
   * @param input - Documento, cuenta activa y usuario que lo crea.
   * @param manager - Transacción del alta; sin ella la reserva se confirma por su cuenta.
   * @returns La reserva documental del documento.
   *
   * @throws {InsufficientDocumentCreditsException} (402) Si la cuenta no tiene perfil de
   *   facturación o saldo documental disponible.
   * @throws {ForbiddenException} (403) Si el usuario no pertenece a la cuenta activa.
   *
   * @example
   * ```ts
   * await reserveDocumentCredit.execute({ documentId: 'doc-1', accountId: 'acc-1', userId: 'u-1' }, manager);
   * ```
   */
  async execute(
    input: ReserveDocumentCreditInput,
    manager?: EntityManager,
  ): Promise<CreditReservationEntity> {
    const owner = await this.billingOwnerService.resolveOwner(
      input.userId,
      input.accountId,
    );
    const profile = await this.billingOwnerService.findProfileByOwner(owner);

    if (!profile) {
      throw new InsufficientDocumentCreditsException(
        CREDITS_PER_DOCUMENT,
        0,
        'La cuenta activa no tiene perfil de facturación, así que tampoco lotes de crédito.',
      );
    }

    const { reservation } = await this.credits.reserve(
      {
        billingProfileId: profile.id,
        creditType: CREDIT_TYPE_ENUM.DOCUMENT_SIGNATURE,
        quantity: CREDITS_PER_DOCUMENT,
        documentId: input.documentId,
        biometricSignatureAttemptId: null,
        expiresAt: null,
        idempotencyKey: documentReservationKey(input.documentId),
        metadata: {
          signatureType: input.signatureType ?? null,
          userId: input.userId,
        },
      },
      manager,
    );

    return reservation;
  }
}
