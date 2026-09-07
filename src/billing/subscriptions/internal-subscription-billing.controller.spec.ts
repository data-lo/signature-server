import { Test, TestingModule } from '@nestjs/testing';
import { InternalSubscriptionBillingController } from './internal-subscription-billing.controller';
import { RegisterManualSubscriptionBillingUseCase } from './register-manual-subscription-billing.use-case';
import { RegisterManualSubscriptionBillingDto } from './dto/register-manual-subscription-billing.dto';
import { BillingProfileNotFoundForRegistrationException } from '../exceptions/billing.exceptions';

const PERIOD_START = new Date('2030-01-01T00:00:00.000Z');
const PERIOD_END = new Date('2030-02-01T00:00:00.000Z');

function dto(): RegisterManualSubscriptionBillingDto {
  return {
    billingProfileId: 'profile-1',
    planType: 'plus',
    amount: 149900,
    currency: 'mxn',
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    externalReference: 'TRF-4471',
    createdByUserId: 'user-admin',
  };
}

function periodo(overrides: Record<string, unknown> = {}) {
  return {
    id: 'period-1',
    billingProfileId: 'profile-1',
    planType: 'plus',
    creditSlotId: 'lot-1',
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    ...overrides,
  };
}

describe('InternalSubscriptionBillingController', () => {
  let controller: InternalSubscriptionBillingController;
  let registerManual: { execute: jest.Mock };

  beforeEach(async () => {
    registerManual = {
      execute: jest
        .fn()
        .mockResolvedValue({ history: periodo(), alreadyRegistered: false }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [InternalSubscriptionBillingController],
      providers: [
        {
          provide: RegisterManualSubscriptionBillingUseCase,
          useValue: registerManual,
        },
      ],
    }).compile();

    controller = module.get(InternalSubscriptionBillingController);
  });

  it('devuelve el periodo registrado y sus vínculos', async () => {
    const respuesta = await controller.register(dto());

    expect(registerManual.execute).toHaveBeenCalledWith(dto());
    expect(respuesta).toEqual({
      success: true,
      message: 'Periodo facturado registrado correctamente',
      data: {
        historyId: 'period-1',
        billingProfileId: 'profile-1',
        planType: 'plus',
        creditSlotId: 'lot-1',
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        alreadyRegistered: false,
      },
    });
  });

  /**
   * Reenviar el mismo folio no es un error, pero tampoco puede parecer un alta nueva: quien opera
   * el panel tiene que poder distinguir "lo registré" de "ya estaba", o acabará dudando de si el
   * cliente recibió los documentos una vez o dos.
   */
  it('avisa en el mensaje cuando la referencia ya estaba registrada', async () => {
    registerManual.execute.mockResolvedValue({
      history: periodo({ id: 'period-existente' }),
      alreadyRegistered: true,
    });

    const respuesta = await controller.register(dto());

    expect(respuesta.message).toContain('ya estaba registrado');
    expect(respuesta.data?.alreadyRegistered).toBe(true);
    expect(respuesta.data?.historyId).toBe('period-existente');
  });

  /** El 404 del caso de uso sube tal cual: es un error de la petición, no del sistema. */
  it('propaga el perfil inexistente como 404', async () => {
    registerManual.execute.mockRejectedValue(
      new BillingProfileNotFoundForRegistrationException('profile-fantasma'),
    );

    await expect(controller.register(dto())).rejects.toBeInstanceOf(
      BillingProfileNotFoundForRegistrationException,
    );
  });
});
