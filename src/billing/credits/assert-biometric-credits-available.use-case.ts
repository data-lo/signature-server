import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { countAvailableCredits } from './count-available-credits.util';
import { CREDIT_TYPE_ENUM } from '../enums/credit-type.enum';
import {
  INSUFFICIENT_BIOMETRIC_CREDITS_ON_CREATE_MESSAGE,
  InsufficientBiometricCreditsException,
} from '../exceptions/billing.exceptions';
import { BillingOwnerService } from '../profiles/billing-owner.service';

/** Un firmante biométrico cuesta un crédito biométrico. */
const CREDITS_PER_BIOMETRIC_SIGNER = 1;

/** Quién crea el documento y cuántos firmantes biométricos pide. */
export interface AssertBiometricCreditsAvailableInput {
  /** Cuenta activa con la que se crea (y paga) el documento. */
  accountId: string;
  /** Usuario que crea el documento; debe pertenecer a la cuenta. */
  userId: string;
  /** Firmantes con firma biométrica del documento. */
  biometricSigners: number;
}

/**
 * Comprueba, ANTES de crear un documento, que la cuenta que paga tiene un crédito biométrico
 * disponible por cada firmante biométrico.
 *
 * Es una lectura: no reserva ni bloquea saldo. Sirve para rechazar pronto —antes de subir el PDF y
 * de abrir la transacción del alta— con un 402 que dice cuánto hace falta y cuánto hay. El
 * disponible es `remaining - reserved` de los lotes vigentes, la misma regla que la reserva.
 */
@Injectable()
export class AssertBiometricCreditsAvailableUseCase {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly billingOwnerService: BillingOwnerService,
  ) {}

  /**
   * Ejecuta el caso de uso.
   *
   * @param input - Cuenta, usuario y firmantes biométricos solicitados.
   * @param manager - Transacción en curso, si la hay.
   * @returns Los créditos biométricos disponibles (al menos los requeridos).
   *
   * @throws {InsufficientBiometricCreditsException} (402, `INSUFFICIENT_BIOMETRIC_CREDITS`) Si la
   *   cuenta no tiene perfil de facturación o le faltan créditos biométricos.
   * @throws {ForbiddenException} (403) Si el usuario no pertenece a la cuenta.
   *
   * @example
   * ```ts
   * await assertBiometricCredits.execute({ accountId: 'acc-1', userId: 'u-1', biometricSigners: 3 });
   * // 402 { code: 'INSUFFICIENT_BIOMETRIC_CREDITS', details: { required: 3, available: 2, biometricSigners: 3 } }
   * ```
   */
  async execute(
    input: AssertBiometricCreditsAvailableInput,
    manager?: EntityManager,
  ): Promise<number> {
    const required = input.biometricSigners * CREDITS_PER_BIOMETRIC_SIGNER;
    if (required <= 0) {
      return 0;
    }

    const owner = await this.billingOwnerService.resolveOwner(
      input.userId,
      input.accountId,
    );
    const profile = await this.billingOwnerService.findProfileByOwner(owner);
    const available = profile
      ? await countAvailableCredits(
          manager ?? this.dataSource.manager,
          profile.id,
          CREDIT_TYPE_ENUM.BIOMETRIC_SIGNATURE,
        )
      : 0;

    if (available < required) {
      throw new InsufficientBiometricCreditsException(
        required,
        available,
        profile
          ? `Perfil ${profile.id} al crear un documento.`
          : 'La cuenta activa no tiene perfil de facturación.',
        {
          message: INSUFFICIENT_BIOMETRIC_CREDITS_ON_CREATE_MESSAGE,
          biometricSigners: input.biometricSigners,
        },
      );
    }

    return available;
  }
}
