import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { RegisterManualSubscriptionBillingUseCase } from './register-manual-subscription-billing.use-case';
import { RegisterSubscriptionBillingUseCase } from './register-subscription-billing.use-case';
import { BILLING_SOURCE_ENUM } from '../enums/billing-source.enum';
import { InvalidBillingRegistrationException } from '../exceptions/billing.exceptions';

const PERIOD_START = new Date('2030-01-01T00:00:00.000Z');
const PERIOD_END = new Date('2030-02-01T00:00:00.000Z');

function cobro(overrides: Record<string, unknown> = {}) {
  return {
    billingProfileId: 'profile-1',
    planType: 'plus',
    amount: 149900,
    currency: 'mxn',
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    externalReference: 'TRF-4471',
    createdByUserId: 'user-admin',
    ...overrides,
  };
}

describe('RegisterManualSubscriptionBillingUseCase', () => {
  let useCase: RegisterManualSubscriptionBillingUseCase;
  let registerSubscriptionBilling: { execute: jest.Mock };
  let userRepository: { findOne: jest.Mock };

  beforeEach(async () => {
    registerSubscriptionBilling = {
      execute: jest.fn().mockResolvedValue({
        history: { id: 'period-1' },
        alreadyRegistered: false,
      }),
    };
    userRepository = {
      findOne: jest.fn().mockResolvedValue({ id: 'user-admin' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RegisterManualSubscriptionBillingUseCase,
        {
          provide: RegisterSubscriptionBillingUseCase,
          useValue: registerSubscriptionBilling,
        },
        {
          provide: getRepositoryToken(UserEntity),
          useValue: userRepository,
        },
      ],
    }).compile();

    useCase = module.get(RegisterManualSubscriptionBillingUseCase);
  });

  it('delega en el caso de uso compartido marcando el origen MANUAL', async () => {
    await useCase.execute(cobro());

    expect(registerSubscriptionBilling.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        billingProfileId: 'profile-1',
        source: BILLING_SOURCE_ENUM.MANUAL,
        planType: 'plus',
        amount: 149900,
        currency: 'mxn',
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        externalReference: 'TRF-4471',
        createdByUserId: 'user-admin',
      }),
    );
  });

  /**
   * El requisito explícito de la historia: este camino no crea sesión, cliente, suscripción,
   * factura ni pago en Stripe. Mandar los cuatro ids en `null` es lo que impide que el historial
   * atribuya al proveedor un ingreso que el proveedor nunca vio.
   */
  it('no aporta ningún identificador de Stripe', async () => {
    await useCase.execute(cobro());

    expect(registerSubscriptionBilling.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        stripeInvoiceId: null,
        stripePaymentIntentId: null,
      }),
    );
  });

  it('usa la fecha de pago recibida cuando la captura es posterior al ingreso', async () => {
    const paidAt = new Date('2030-01-02T15:30:00.000Z');

    await useCase.execute(cobro({ paidAt }));

    expect(registerSubscriptionBilling.execute).toHaveBeenCalledWith(
      expect.objectContaining({ paidAt }),
    );
  });

  it('toma "ahora" como fecha de pago si no se indica', async () => {
    const antes = Date.now();

    await useCase.execute(cobro());

    const { paidAt } = registerSubscriptionBilling.execute.mock.calls[0][0];
    expect(paidAt.getTime()).toBeGreaterThanOrEqual(antes);
    expect(paidAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  describe('autor del registro', () => {
    /**
     * `created_by_user_id` es clave foránea a `users`: un id inventado reventaría a mitad del alta
     * con una violación de constraint, un error de Postgres en el log que no dice qué campo venía
     * mal. Y la FK no comprueba lo que de verdad importa —que la cuenta siga vigente—.
     */
    it('rechaza un autor que no existe', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(useCase.execute(cobro())).rejects.toBeInstanceOf(
        InvalidBillingRegistrationException,
      );
      expect(registerSubscriptionBilling.execute).not.toHaveBeenCalled();
    });

    it('exige que el autor esté activo y no dado de baja', async () => {
      await useCase.execute(cobro());

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'user-admin', isActive: true, isDeleted: false },
      });
    });

    /** Con folio, el autor es opcional: el rastro del movimiento ya existe. */
    it('no consulta usuarios si el cobro sólo trae folio', async () => {
      await useCase.execute(cobro({ createdByUserId: null }));

      expect(userRepository.findOne).not.toHaveBeenCalled();
      expect(registerSubscriptionBilling.execute).toHaveBeenCalled();
    });
  });

  /**
   * Reenviar el mismo folio no es un error: se responde con el periodo que ya estaba y sin
   * acreditar de nuevo. El aviso queda en el log para que se note que hubo un reenvío.
   */
  it('propaga sin fallar el caso de una referencia ya registrada', async () => {
    registerSubscriptionBilling.execute.mockResolvedValue({
      history: { id: 'period-existente' },
      alreadyRegistered: true,
    });

    const resultado = await useCase.execute(cobro());

    expect(resultado).toMatchObject({
      alreadyRegistered: true,
      history: { id: 'period-existente' },
    });
  });
});
