import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';
import { AccountService } from 'src/account/account.service';
import { AccountEntity } from 'src/account/entities/account.entity';
import { OrganizationEntity } from 'src/account/entities/organization.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { RolesService } from 'src/roles/roles.service';
import { SYSTEM_ROLE_NAME_ENUM } from 'src/roles/enums/system-role-name.enum';
import { RedisService } from 'src/shared/redis/redis.service';
import { StripePaymentService } from 'src/payments/stripe/stripe-payment.service';
import { BillingProfileProvisioningService } from './billing-profile-provisioning.service';
import { BillingProfileEntity } from './billing-profile.entity';
import { PlanEntity } from '../catalog/plan.entity';
import { CheckoutOrderEntity } from '../checkout/checkout-order.entity';
import { CreditLotEntity } from '../credits/credit-lot.entity';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import { FREE_PLAN_TYPE } from '../catalog/free-plan.constants';

const ADMIN_ROLE = { id: 'rol-admin', name: SYSTEM_ROLE_NAME_ENUM.ADMIN };
const USER = {
  id: 'usuario-1',
  email: 'usuario@empresa.com',
  password: 'hash',
} as UserEntity;

interface Fila {
  id?: string;
  [key: string]: unknown;
}

/**
 * `EntityManager` en memoria: guarda por entidad para poder afirmar qué tablas se tocaron y
 * cuáles NO. Es justo lo que esta prueba necesita comprobar — que el alta escribe en
 * `billing_profiles` y en ninguna otra tabla de facturación.
 */
function createInMemoryManager() {
  const tablas = new Map<unknown, Fila[]>();
  let secuencia = 0;

  const filasDe = (entidad: unknown): Fila[] => {
    if (!tablas.has(entidad)) {
      tablas.set(entidad, []);
    }
    return tablas.get(entidad) as Fila[];
  };

  const coincide = (fila: Fila, where: Record<string, unknown>) =>
    Object.entries(where).every(([campo, valor]) => fila[campo] === valor);

  const manager = {
    tablas,
    filasDe,
    /**
     * `create` marca la fila con su entidad en una propiedad NO enumerable. Es lo que permite
     * que `save(fila)` —la forma de un solo argumento, que es la que usan tanto `AccountService`
     * como el aprovisionamiento— sepa a qué tabla va sin que la marca acabe guardada: el spread
     * de abajo no copia propiedades no enumerables.
     */
    create: jest.fn((entidad: unknown, data: Fila) => {
      const fila: Fila = { ...data };
      Object.defineProperty(fila, '__entity', {
        value: entidad,
        enumerable: false,
      });
      return fila;
    }),
    save: jest.fn(async (entidad: unknown, data?: Fila) => {
      const [target, fila] =
        data === undefined
          ? [(entidad as Fila).__entity, entidad as Fila]
          : [entidad, data];

      if (!target) {
        throw new Error(
          'save() recibió una fila que no salió de create(): la prueba no sabe a qué tabla va.',
        );
      }

      const guardada = { id: `generado-${++secuencia}`, ...fila };
      filasDe(target).push(guardada);
      return guardada;
    }),
    findOne: jest.fn(
      async (entidad: unknown, options: { where: Record<string, unknown> }) =>
        filasDe(entidad).find((fila) => coincide(fila, options.where)) ?? null,
    ),
    createQueryBuilder: jest.fn(() => {
      let destino: unknown = null;
      let valores: Fila = {};
      const qb = {
        insert: () => qb,
        into: (entidad: unknown) => {
          destino = entidad;
          return qb;
        },
        values: (data: Fila) => {
          valores = data;
          return qb;
        },
        orIgnore: () => qb,
        execute: async () => {
          const filas = filasDe(destino);
          // `ON CONFLICT DO NOTHING` sobre la clave natural del plan.
          if (!filas.some((f) => f.planType === valores.planType)) {
            filas.push({ ...valores });
          }
          return { identifiers: [] };
        },
      };
      return qb;
    }),
  };

  return manager;
}

/**
 * El alta de un propietario, de punta a punta y con el aprovisionamiento REAL: `AccountService`
 * → `BillingProfileProvisioningService` → escritura.
 *
 * Lo que un spec por unidad no puede afirmar y éste sí: qué acaba realmente en la base después
 * de crear una cuenta, y —sobre todo— qué NO. El criterio central de esta historia es negativo
 * (el plan Free no toca Stripe, ni deja orden de compra, ni lote de créditos), y sólo se puede
 * comprobar mirando el resultado completo del alta en vez de una llamada aislada.
 */
describe('Alta del perfil Free (integración)', () => {
  let accountService: AccountService;
  let manager: ReturnType<typeof createInMemoryManager>;
  let stripe: Record<string, jest.Mock>;
  let accountRepository: { findOne: jest.Mock };

  const perfiles = () => manager.filasDe(BillingProfileEntity);

  beforeEach(async () => {
    manager = createInMemoryManager();

    /**
     * Todos los métodos que el adaptador de Stripe expone hacia el dominio. Se registran para
     * poder afirmar que NINGUNO se llamó: si mañana alguien mete una llamada al proveedor en el
     * alta, esta prueba lo caza en vez de dejarlo pasar en silencio.
     */
    stripe = {
      createCustomer: jest.fn(),
      createCheckoutSession: jest.fn(),
      listPublicPlans: jest.fn(),
      retrieveProduct: jest.fn(),
    };

    accountRepository = {
      findOne: jest.fn(async () => ({
        id: 'cuenta-admin',
        organization: null,
      })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountService,
        // El aprovisionamiento va REAL: es lo que esta prueba mide.
        BillingProfileProvisioningService,
        {
          provide: getRepositoryToken(AccountEntity),
          useValue: accountRepository,
        },
        { provide: getRepositoryToken(OrganizationEntity), useValue: {} },
        {
          provide: getRepositoryToken(UserEntity),
          useValue: { findOne: jest.fn(async () => USER) },
        },
        {
          provide: getDataSourceToken(),
          useValue: {
            transaction: jest.fn(
              async (run: (m: EntityManager) => Promise<unknown>) =>
                run(manager as unknown as EntityManager),
            ),
            createQueryRunner: jest.fn(() => ({
              connect: jest.fn(),
              startTransaction: jest.fn(),
              commitTransaction: jest.fn(),
              rollbackTransaction: jest.fn(),
              release: jest.fn(),
              manager,
            })),
          },
        },
        { provide: RedisService, useValue: { get: jest.fn(), set: jest.fn() } },
        {
          provide: RolesService,
          useValue: {
            findSystemRoleByName: jest.fn().mockResolvedValue(ADMIN_ROLE),
          },
        },
        { provide: StripePaymentService, useValue: stripe },
      ],
    }).compile();

    accountService = module.get(AccountService);
  });

  async function altaDeCuentaPersonal() {
    return accountService.createDefaultPersonalAccount(
      manager as unknown as EntityManager,
      USER.id,
      USER.email,
      USER.password,
    );
  }

  async function altaDeOrganizacion() {
    return accountService.saveOrganizationWithAdminAccount(USER, {
      organizationName: 'Acme',
    } as never);
  }

  describe('alta de cuenta personal', () => {
    it('deja un perfil atado a personal_account_id con el plan Free', async () => {
      const { account } = await altaDeCuentaPersonal();

      expect(perfiles()).toHaveLength(1);
      expect(perfiles()[0]).toMatchObject({
        personalAccountId: account.id,
        organizationId: null,
        currentPlanType: FREE_PLAN_TYPE,
        status: BILLING_PROFILE_STATUS_ENUM.FREE,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
      });
    });

    it('siembra el plan free al que apunta el perfil', async () => {
      await altaDeCuentaPersonal();

      expect(manager.filasDe(PlanEntity)).toHaveLength(1);
      expect(manager.filasDe(PlanEntity)[0]).toMatchObject({
        planType: FREE_PLAN_TYPE,
        stripeProductId: null,
      });
    });
  });

  describe('alta de organización', () => {
    it('deja un perfil atado a organization_id, no a la membresía de quien la creó', async () => {
      await altaDeOrganizacion();

      const organizacion = manager.filasDe(OrganizationEntity)[0];
      expect(perfiles()).toHaveLength(1);
      expect(perfiles()[0]).toMatchObject({
        personalAccountId: null,
        organizationId: organizacion.id,
        currentPlanType: FREE_PLAN_TYPE,
        status: BILLING_PROFILE_STATUS_ENUM.FREE,
      });
    });
  });

  describe('idempotencia', () => {
    /**
     * El alta corre en cada registro; un propietario que ya tenga perfil debe conservar EL SUYO.
     * Sin esto, un reintento pondría en FREE a quien ya está pagando.
     */
    it('no duplica el perfil si el propietario ya tiene uno', async () => {
      const { account } = await altaDeCuentaPersonal();
      const primero = perfiles()[0];

      await accountService.createDefaultPersonalAccount(
        manager as unknown as EntityManager,
        USER.id,
        USER.email,
        USER.password,
      );

      // La segunda alta creó otra fila de `accounts`, pero el perfil sigue siendo uno solo:
      // se busca por el propietario, no por la cuenta.
      const perfilesDeEsePropietario = perfiles().filter(
        (p) => p.personalAccountId === account.id,
      );
      expect(perfilesDeEsePropietario).toHaveLength(1);
      expect(perfilesDeEsePropietario[0]).toBe(primero);
    });

    it('no pisa el perfil de quien ya está pagando', async () => {
      manager.filasDe(BillingProfileEntity).push({
        id: 'perfil-de-pago',
        personalAccountId: 'generado-1',
        organizationId: null,
        currentPlanType: 'premium',
        status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
      });

      await altaDeCuentaPersonal();

      expect(perfiles()).toHaveLength(1);
      expect(perfiles()[0]).toMatchObject({
        status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
        currentPlanType: 'premium',
        stripeCustomerId: 'cus_1',
      });
    });
  });

  /** El criterio central: el plan Free se administra sólo acá. */
  describe('el plan Free no toca Stripe', () => {
    it('no llama a ningún método del proveedor de pagos', async () => {
      await altaDeCuentaPersonal();
      await altaDeOrganizacion();

      Object.entries(stripe).forEach(([metodo, mock]) => {
        expect({ metodo, llamadas: mock.mock.calls.length }).toEqual({
          metodo,
          llamadas: 0,
        });
      });
    });

    it('no escribe ninguna orden de compra ni lote de créditos', async () => {
      await altaDeCuentaPersonal();
      await altaDeOrganizacion();

      // No hubo compra que registrar…
      expect(manager.filasDe(CheckoutOrderEntity)).toHaveLength(0);
      // …y los créditos del plan gratuito son de su propio flujo de asignación.
      expect(manager.filasDe(CreditLotEntity)).toHaveLength(0);
    });

    it('deja los identificadores de Stripe en null', async () => {
      await altaDeCuentaPersonal();

      expect(perfiles()[0].stripeCustomerId).toBeNull();
      expect(perfiles()[0].stripeSubscriptionId).toBeNull();
    });
  });
});
