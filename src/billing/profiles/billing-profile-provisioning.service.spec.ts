import { Test, TestingModule } from '@nestjs/testing';
import { EntityManager } from 'typeorm';
import { BillingProfileProvisioningService } from './billing-profile-provisioning.service';
import { BillingProfileEntity } from './billing-profile.entity';
import { PlanEntity } from '../catalog/plan.entity';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import { BILLING_PROFILE_SOURCE_ENUM } from '../enums/billing-profile-source.enum';
import { PLAN_CREATION_SOURCE_ENUM } from '../enums/plan-creation-source.enum';
import {
  FREE_PLAN_DOCUMENTS_INCLUDED,
  FREE_PLAN_TYPE,
  FREE_WELCOME_DOCUMENT_CREDITS,
} from '../catalog/free-plan.constants';
import { CreditLotEntity } from '../credits/credit-lot.entity';
import { CREDIT_LOT_ORIGIN_ENUM } from '../enums/credit-lot-origin.enum';

const PERSONAL_OWNER = {
  personalAccountId: 'cuenta-personal-1',
  organizationId: null,
};
const ORGANIZATION_OWNER = {
  personalAccountId: null,
  organizationId: 'organizacion-1',
};

describe('BillingProfileProvisioningService', () => {
  let service: BillingProfileProvisioningService;
  let manager: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let insertValues: jest.Mock;
  let insertExecute: jest.Mock;

  beforeEach(async () => {
    insertValues = jest.fn();
    insertExecute = jest.fn().mockResolvedValue({ identifiers: [] });

    const queryBuilder = {
      insert: jest.fn(() => queryBuilder),
      into: jest.fn(() => queryBuilder),
      values: jest.fn((...args: unknown[]) => {
        insertValues(...args);
        return queryBuilder;
      }),
      orIgnore: jest.fn(() => queryBuilder),
      execute: insertExecute,
    };

    manager = {
      findOne: jest.fn().mockResolvedValue(null),
      // Refleja a TypeORM: `create` devuelve la instancia que después recibe `save`.
      create: jest.fn((_entity: unknown, data: object) => ({ ...data })),
      save: jest.fn(async (entity: object) => ({
        id: 'perfil-nuevo',
        ...entity,
      })),
      createQueryBuilder: jest.fn(() => queryBuilder),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [BillingProfileProvisioningService],
    }).compile();

    service = module.get(BillingProfileProvisioningService);
  });

  const provision = (owner = PERSONAL_OWNER) =>
    service.provisionFreeProfile(manager as unknown as EntityManager, owner);

  describe('cuenta personal', () => {
    it('crea el perfil atado a personal_account_id', async () => {
      await provision(PERSONAL_OWNER);

      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          personalAccountId: 'cuenta-personal-1',
          organizationId: null,
        }),
      );
    });
  });

  describe('organización', () => {
    /**
     * El propietario es la organización, no la membresía de quien la creó: atarlo a la cuenta
     * daría un perfil (y un saldo) por empleado en vez del único que comparte la organización.
     */
    it('crea el perfil atado a organization_id', async () => {
      await provision(ORGANIZATION_OWNER);

      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          personalAccountId: null,
          organizationId: 'organizacion-1',
        }),
      );
    });
  });

  describe('perfil inicial', () => {
    it('nace en plan free, estado FREE y sin nada de Stripe', async () => {
      await provision();

      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          currentPlanType: FREE_PLAN_TYPE,
          status: BILLING_PROFILE_STATUS_ENUM.FREE,
          // Los tres campos que definen el plan gratuito, juntos: plan, estado y quién factura.
          billingSource: BILLING_PROFILE_SOURCE_ENUM.FREE,
          stripeCustomerId: null,
          stripeSubscriptionId: null,
        }),
      );
    });

    it('escribe el perfil y su lote de bienvenida, y nada más', async () => {
      await provision();

      expect(manager.create).toHaveBeenCalledWith(
        BillingProfileEntity,
        expect.any(Object),
      );
      expect(manager.create).toHaveBeenCalledWith(
        CreditLotEntity,
        expect.any(Object),
      );
      // Dos filas y no tres: no se escribe ninguna orden de compra, porque no hubo compra.
      expect(manager.create).toHaveBeenCalledTimes(2);
      expect(manager.save).toHaveBeenCalledTimes(2);
    });

    /**
     * La regla del plan gratuito: 3 documentos, una sola vez. Sin caducidad y con la prioridad
     * por omisión, para que se gasten DESPUÉS de los créditos de un periodo facturado, que sí se
     * pierden al cerrarse (ver `ConsumeDocumentCreditUseCase`).
     */
    it('concede 3 documentos de bienvenida, sin caducidad ni factura', async () => {
      await provision();

      expect(manager.create).toHaveBeenCalledWith(CreditLotEntity, {
        billingProfileId: 'perfil-nuevo',
        origin: CREDIT_LOT_ORIGIN_ENUM.FREE_GRANT,
        issued: FREE_WELCOME_DOCUMENT_CREDITS,
        remaining: FREE_WELCOME_DOCUMENT_CREDITS,
      });
      expect(FREE_WELCOME_DOCUMENT_CREDITS).toBe(3);
    });

    /**
     * El lote se ata al perfil recién guardado, no al `owner`: un lote colgado de la cuenta
     * dejaría a los miembros de una organización con saldos separados en vez del único que
     * comparten.
     */
    it('ata el lote al perfil que acaba de crear', async () => {
      await provision(ORGANIZATION_OWNER);

      expect(manager.create).toHaveBeenCalledWith(
        CreditLotEntity,
        expect.objectContaining({ billingProfileId: 'perfil-nuevo' }),
      );
    });

    /**
     * `current_plan_type` es FK a `plans.plan_type`: sin la fila del plan, el alta de cualquier
     * cuenta moriría con una violación de constraint.
     */
    it('siembra el plan free si no existe, sin pisarlo si ya está', async () => {
      await provision();

      expect(manager.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          planType: FREE_PLAN_TYPE,
          isActive: true,
          creationSource: PLAN_CREATION_SOURCE_ENUM.MANUAL,
          stripeProductId: null,
          documentsIncluded: FREE_PLAN_DOCUMENTS_INCLUDED,
        }),
      );
      expect(insertExecute).toHaveBeenCalledTimes(1);
    });

    it('usa la tabla de planes para esa siembra', async () => {
      await provision();

      const queryBuilder = manager.createQueryBuilder.mock.results[0].value as {
        into: jest.Mock;
      };
      expect(queryBuilder.into).toHaveBeenCalledWith(PlanEntity);
    });
  });

  describe('idempotencia', () => {
    it('devuelve el perfil existente sin crear otro', async () => {
      const existente = {
        id: 'perfil-existente',
        status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
      };
      manager.findOne.mockResolvedValue(existente);

      await expect(provision()).resolves.toBe(existente);
      expect(manager.save).not.toHaveBeenCalled();
      expect(manager.create).not.toHaveBeenCalled();
    });

    /**
     * La bienvenida es "una sola vez", y esto es lo que lo garantiza: un reintento del registro
     * sale por el perfil que ya existe, antes de conceder nada. Sin esta salida temprana, cada
     * reintento regalaría otros 3 documentos.
     */
    it('no vuelve a conceder los créditos de bienvenida a un perfil que ya existe', async () => {
      manager.findOne.mockResolvedValue({ id: 'perfil-existente' });

      await provision();

      expect(manager.create).not.toHaveBeenCalledWith(
        CreditLotEntity,
        expect.anything(),
      );
    });

    /**
     * Lo importante del caso anterior: un propietario que YA está pagando no puede acabar en
     * FREE porque su alta se reintentara. Se conserva el suyo, tal cual.
     */
    it('no degrada a FREE un perfil que ya está pagando', async () => {
      manager.findOne.mockResolvedValue({
        id: 'perfil-existente',
        status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
        currentPlanType: 'premium',
      });

      const perfil = await provision();

      expect(perfil.status).toBe(BILLING_PROFILE_STATUS_ENUM.ACTIVE);
      expect(perfil.currentPlanType).toBe('premium');
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('busca por la columna del propietario, no por la cuenta', async () => {
      await provision(ORGANIZATION_OWNER);

      expect(manager.findOne).toHaveBeenCalledWith(BillingProfileEntity, {
        where: { organizationId: 'organizacion-1' },
      });
    });

    it('busca por personal_account_id cuando el propietario es personal', async () => {
      await provision(PERSONAL_OWNER);

      expect(manager.findOne).toHaveBeenCalledWith(BillingProfileEntity, {
        where: { personalAccountId: 'cuenta-personal-1' },
      });
    });
  });

  describe('transacción del llamador', () => {
    /**
     * Todo pasa por el `EntityManager` recibido. Si el servicio abriera su propia transacción,
     * un rollback del alta de la cuenta dejaría el perfil huérfano — el estado que esta historia
     * viene a eliminar.
     */
    it('no escribe por ningún camino que no sea el manager recibido', async () => {
      await provision();

      expect(manager.save).toHaveBeenCalled();
      expect(manager.createQueryBuilder).toHaveBeenCalled();
      // El servicio no inyecta nada: no hay repositorio ni DataSource por donde escapar.
      expect(Object.keys(service)).toEqual(['logger']);
    });
  });
});
