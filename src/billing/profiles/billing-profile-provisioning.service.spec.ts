import { Test, TestingModule } from '@nestjs/testing';
import { EntityManager } from 'typeorm';
import { BillingProfileProvisioningService } from './billing-profile-provisioning.service';
import { BillingProfileEntity } from './billing-profile.entity';
import { PlanEntity } from '../catalog/plan.entity';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import { BILLING_SOURCE_ENUM } from '../enums/billing-source.enum';
import { PLAN_CREATION_SOURCE_ENUM } from '../enums/plan-creation-source.enum';
import {
  FREE_PLAN_DOCUMENTS_INCLUDED,
  FREE_PLAN_TYPE,
} from '../catalog/free-plan.constants';

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
    /**
     * Los tres campos dicen lo mismo desde ángulos distintos —beneficios, situación comercial y
     * quién gobierna el ciclo de vida— y hacen falta los tres. El origen es además lo que
     * mantiene la cuenta fuera del alcance de `ExpireManualSubscriptionsJob`, que sólo mira
     * perfiles `MANUAL`.
     */
    it('nace en plan free, estado FREE, origen FREE y sin nada de Stripe', async () => {
      await provision();

      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          currentPlanType: FREE_PLAN_TYPE,
          status: BILLING_PROFILE_STATUS_ENUM.FREE,
          billingSource: BILLING_SOURCE_ENUM.FREE,
          stripeCustomerId: null,
          stripeSubscriptionId: null,
        }),
      );
    });

    it('escribe en billing_profiles y en nada más', async () => {
      await provision();

      expect(manager.create).toHaveBeenCalledTimes(1);
      expect(manager.create).toHaveBeenCalledWith(
        BillingProfileEntity,
        expect.any(Object),
      );
      // Ni orden de compra ni lote de créditos: no hubo compra, y los créditos gratuitos son
      // de su propio flujo de asignación.
      expect(manager.save).toHaveBeenCalledTimes(1);
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
