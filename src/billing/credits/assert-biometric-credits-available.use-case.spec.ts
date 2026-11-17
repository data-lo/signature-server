import { HttpStatus } from '@nestjs/common';

import { AssertBiometricCreditsAvailableUseCase } from './assert-biometric-credits-available.use-case';
import { countAvailableCredits } from './count-available-credits.util';
import { CREDIT_TYPE_ENUM } from '../enums/credit-type.enum';
import { InsufficientBiometricCreditsException } from '../exceptions/billing.exceptions';

jest.mock('./count-available-credits.util', () => ({
  countAvailableCredits: jest.fn(),
}));

const countAvailable = countAvailableCredits as jest.MockedFunction<
  typeof countAvailableCredits
>;

describe('AssertBiometricCreditsAvailableUseCase', () => {
  const defaultManager = { name: 'default-manager' };
  const owner = { kind: 'PERSONAL', accountId: 'acc-1' };
  let billingOwnerService: {
    resolveOwner: jest.Mock;
    findProfileByOwner: jest.Mock;
  };
  let useCase: AssertBiometricCreditsAvailableUseCase;

  beforeEach(() => {
    countAvailable.mockReset();
    billingOwnerService = {
      resolveOwner: jest.fn().mockResolvedValue(owner),
      findProfileByOwner: jest.fn().mockResolvedValue({ id: 'bp-1' }),
    };
    useCase = new AssertBiometricCreditsAvailableUseCase(
      { manager: defaultManager } as never,
      billingOwnerService as never,
    );
  });

  /** Lanza el caso de uso y devuelve el error, para revisar su cuerpo. */
  async function failure(
    biometricSigners: number,
  ): Promise<InsufficientBiometricCreditsException> {
    const error = await useCase
      .execute({ accountId: 'acc-1', userId: 'u-1', biometricSigners })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InsufficientBiometricCreditsException);
    return error as InsufficientBiometricCreditsException;
  }

  it('con saldo suficiente devuelve el disponible del perfil que paga', async () => {
    countAvailable.mockResolvedValue(3);

    await expect(
      useCase.execute({
        accountId: 'acc-1',
        userId: 'u-1',
        biometricSigners: 3,
      }),
    ).resolves.toBe(3);
    expect(billingOwnerService.resolveOwner).toHaveBeenCalledWith(
      'u-1',
      'acc-1',
    );
    expect(countAvailable).toHaveBeenCalledWith(
      defaultManager,
      'bp-1',
      CREDIT_TYPE_ENUM.BIOMETRIC_SIGNATURE,
    );
  });

  it('cuenta dentro de la transacción del llamador si la recibe', async () => {
    countAvailable.mockResolvedValue(1);
    const manager = { name: 'tx' };

    await useCase.execute(
      { accountId: 'acc-1', userId: 'u-1', biometricSigners: 1 },
      manager as never,
    );

    expect(countAvailable).toHaveBeenCalledWith(
      manager,
      'bp-1',
      CREDIT_TYPE_ENUM.BIOMETRIC_SIGNATURE,
    );
  });

  it('con menos créditos que firmantes biométricos responde 402 INSUFFICIENT_BIOMETRIC_CREDITS', async () => {
    countAvailable.mockResolvedValue(2);

    const error = await failure(3);

    expect(error.getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
    expect(error.getResponse()).toEqual({
      statusCode: 402,
      success: false,
      message: 'Saldo insuficiente para firmas biométricas.',
      code: 'INSUFFICIENT_BIOMETRIC_CREDITS',
      details: { required: 3, available: 2, biometricSigners: 3 },
      error: {
        code: 'INSUFFICIENT_BIOMETRIC_CREDITS',
        details: { required: 3, available: 2, biometricSigners: 3 },
      },
    });
  });

  it('un solo firmante biométrico sin saldo también se rechaza', async () => {
    countAvailable.mockResolvedValue(0);

    const error = await failure(1);

    expect(error.details).toEqual({
      required: 1,
      available: 0,
      biometricSigners: 1,
    });
  });

  it('sin perfil de facturación el disponible es 0', async () => {
    billingOwnerService.findProfileByOwner.mockResolvedValue(null);

    const error = await failure(2);

    expect(error.details).toMatchObject({ required: 2, available: 0 });
    expect(countAvailable).not.toHaveBeenCalled();
  });

  it('sin firmantes biométricos no consulta nada', async () => {
    await expect(
      useCase.execute({
        accountId: 'acc-1',
        userId: 'u-1',
        biometricSigners: 0,
      }),
    ).resolves.toBe(0);
    expect(billingOwnerService.resolveOwner).not.toHaveBeenCalled();
  });
});
