import {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as request from 'supertest';

import { applyGlobalApiPrefix } from './../src/shared/constants/api-prefix.constants';
import { PaymentsController } from './../src/payments/payments.controller';
import { GetPublicStripePlansUseCase } from './../src/payments/applications/get-public-stripe-plans.use-case';
import { GetSubscriptionStateUseCase } from './../src/payments/applications/get-subscription-state.use-case';
import { CreateSubscriptionCheckoutUseCase } from './../src/billing/checkout/create-subscription-checkout.use-case';
import { GetBillingAccessUseCase } from './../src/billing/entitlements/get-billing-access.use-case';
import { BillingOwnerService } from './../src/billing/profiles/billing-owner.service';
import { CancelSubscriptionUseCase } from './../src/billing/subscriptions/cancel-subscription.use-case';
import { ResumeSubscriptionUseCase } from './../src/billing/subscriptions/resume-subscription.use-case';
import { BillingProfileEntity } from './../src/billing/profiles/billing-profile.entity';
import { CreditLotEntity } from './../src/billing/credits/credit-lot.entity';
import { SubscriptionBillingHistoryEntity } from './../src/billing/subscriptions/subscription-billing-history.entity';
import { AccountEntity } from './../src/account/entities/account.entity';
import { ACCOUNT_TYPE_ENUM } from './../src/account/enums/account-type.enum';
import { BILLING_PROFILE_STATUS_ENUM } from './../src/billing/enums/billing-profile-status.enum';
import { BILLING_SOURCE_ENUM } from './../src/billing/enums/billing-source.enum';
import { CREDIT_LOT_ORIGIN_ENUM } from './../src/billing/enums/credit-lot-origin.enum';
import { PLAN_ENTITLEMENTS } from './../src/billing/entitlements/plan-entitlements.config';
import {
  createInMemoryRepository,
  InMemoryRepository,
} from './billing-e2e-fixtures';

const BILLING_STATE_ENDPOINT = '/api/v1/payments/billing-state';

const USER_ID = 'usuario-1';
const USER_EMAIL = 'firmante@ejemplo.com';
const PERSONAL_ACCOUNT_ID = 'cuenta-personal-1';
const ORGANIZATION_ACCOUNT_ID = 'cuenta-org-1';
const ORGANIZATION_ID = 'organizacion-1';
const AJENA_ACCOUNT_ID = 'cuenta-de-otro';

/** Sustituye al `JwtAuthGuard` global, que vive en `AuthModule` y no se importa acá. */
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest().user = {
      sub: USER_ID,
      email: USER_EMAIL,
    };
    return true;
  }
}

/**
 * Estado comercial visto desde fuera: `GET /api/v1/payments/billing-state`.
 *
 * Lo que sólo se comprueba por HTTP y no en la prueba unitaria es que la cuenta consultada sale
 * del header `X-Account-Id` y se traduce al propietario con el `BillingOwnerService` real contra
 * `accounts` — es decir, que una cuenta personal lee `personal_account_id` y una de organización
 * lee `organization_id`, que es toda la regla del endpoint.
 *
 * Se comprueba además que la respuesta llega ENTERA al cliente: los beneficios se resuelven en el
 * servidor, y un campo que se perdiera al serializar dejaría al frontend leyendo `undefined` —que
 * en un booleano se interpreta como "no puede" y esconde el fallo detrás de un bloqueo plausible.
 */
describe('Estado de facturación (e2e)', () => {
  let app: INestApplication;
  let accounts: InMemoryRepository<never>;
  let billingProfiles: InMemoryRepository<never>;
  let creditLots: InMemoryRepository<never>;
  let billingHistory: InMemoryRepository<never>;

  function consultarEstado(accountId?: string | null) {
    const pending = request(app.getHttpServer()).get(BILLING_STATE_ENDPOINT);
    const header = accountId === undefined ? PERSONAL_ACCOUNT_ID : accountId;

    if (header !== null) {
      pending.set('X-Account-Id', header);
    }

    return pending.send();
  }

  async function darDeAltaPerfil(perfil: {
    id: string;
    personalAccountId?: string | null;
    organizationId?: string | null;
    status: BILLING_PROFILE_STATUS_ENUM;
    currentPlanType: string | null;
    cancelAtPeriodEnd?: boolean;
    currentPeriodStart?: Date | null;
    currentPeriodEnd?: Date | null;
  }) {
    await billingProfiles.save({
      personalAccountId: null,
      organizationId: null,
      cancelAtPeriodEnd: false,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      ...perfil,
    } as never);
  }

  async function darDeAltaLote(lote: {
    id: string;
    billingProfileId: string;
    remaining: number;
    origin?: CREDIT_LOT_ORIGIN_ENUM;
    expiresAt?: Date | null;
  }) {
    await creditLots.save({
      origin: CREDIT_LOT_ORIGIN_ENUM.CURRENT_PERIOD,
      issued: lote.remaining,
      expiresAt: null,
      ...lote,
    } as never);
  }

  beforeEach(async () => {
    accounts = createInMemoryRepository([
      {
        id: PERSONAL_ACCOUNT_ID,
        userId: USER_ID,
        accountType: ACCOUNT_TYPE_ENUM.PERSONAL,
        organizationId: null,
        isActive: true,
      },
      {
        id: ORGANIZATION_ACCOUNT_ID,
        userId: USER_ID,
        accountType: ACCOUNT_TYPE_ENUM.ORGANIZATION,
        organizationId: ORGANIZATION_ID,
        isActive: true,
      },
      {
        id: AJENA_ACCOUNT_ID,
        userId: 'otro-usuario',
        accountType: ACCOUNT_TYPE_ENUM.PERSONAL,
        organizationId: null,
        isActive: true,
      },
    ] as never[]);

    billingProfiles = createInMemoryRepository();
    creditLots = createInMemoryRepository();
    billingHistory = createInMemoryRepository();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [PaymentsController],
      providers: [
        /**
         * Los pide el controller para `POST /subscription/cancel` y `/resume`, que tienen su
         * propia cobertura: acá van simulados para no arrastrar el adaptador de Stripe a una
         * prueba que no los ejercita.
         */
        {
          provide: CancelSubscriptionUseCase,
          useValue: { execute: jest.fn() },
        },
        {
          provide: ResumeSubscriptionUseCase,
          useValue: { execute: jest.fn() },
        },
        GetBillingAccessUseCase,
        BillingOwnerService,
        { provide: APP_GUARD, useClass: FakeAuthGuard },
        {
          provide: GetPublicStripePlansUseCase,
          useValue: { execute: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: GetSubscriptionStateUseCase,
          useValue: { execute: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: CreateSubscriptionCheckoutUseCase,
          useValue: { execute: jest.fn() },
        },
        { provide: getRepositoryToken(AccountEntity), useValue: accounts },
        {
          provide: getRepositoryToken(BillingProfileEntity),
          useValue: billingProfiles,
        },
        { provide: getRepositoryToken(CreditLotEntity), useValue: creditLots },
        {
          provide: getRepositoryToken(SubscriptionBillingHistoryEntity),
          useValue: billingHistory,
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    applyGlobalApiPrefix(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('cuenta personal', () => {
    it('lee el perfil por personal_account_id y responde el estado completo', async () => {
      await darDeAltaPerfil({
        id: 'perfil-personal',
        personalAccountId: PERSONAL_ACCOUNT_ID,
        status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
        currentPlanType: 'plus',
        currentPeriodStart: new Date('2026-09-04T00:00:00.000Z'),
        currentPeriodEnd: new Date('2026-10-04T00:00:00.000Z'),
      });
      await darDeAltaLote({
        id: 'lote-1',
        billingProfileId: 'perfil-personal',
        remaining: 18,
      });
      await billingHistory.save({
        id: 'historia-1',
        billingProfileId: 'perfil-personal',
        source: BILLING_SOURCE_ENUM.STRIPE,
        periodStart: new Date('2026-09-04T00:00:00.000Z'),
      } as never);

      const response = await consultarEstado();

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({
        billingProfileId: 'perfil-personal',
        hasActiveSubscription: true,
        currentPlanType: 'plus',
        status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
        billingSource: BILLING_SOURCE_ENUM.STRIPE,
        cancelAtPeriodEnd: false,
        currentPeriodStart: '2026-09-04T00:00:00.000Z',
        currentPeriodEnd: '2026-10-04T00:00:00.000Z',
        creditsAvailable: 18,
        actions: PLAN_ENTITLEMENTS.plus.actions,
        limits: PLAN_ENTITLEMENTS.plus.limits,
      });
    });
  });

  describe('organización', () => {
    it('lee el perfil por organization_id', async () => {
      await darDeAltaPerfil({
        id: 'perfil-organizacion',
        organizationId: ORGANIZATION_ID,
        status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
        currentPlanType: 'premium',
      });

      const response = await consultarEstado(ORGANIZATION_ACCOUNT_ID);

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        billingProfileId: 'perfil-organizacion',
        hasActiveSubscription: true,
        currentPlanType: 'premium',
        actions: PLAN_ENTITLEMENTS.premium.actions,
        limits: PLAN_ENTITLEMENTS.premium.limits,
      });
    });

    /**
     * El caso que justifica el header: el MISMO usuario tiene dos estados de facturación a la
     * vez —y ahora también dos juegos de beneficios y dos saldos— y la respuesta depende de en
     * cuál esté trabajando. Es lo que el endpoint anterior, que resolvía la cuenta por la primera
     * membresía activa, no podía distinguir.
     */
    it('devuelve estados, saldos y beneficios distintos para la cuenta personal y la organización del mismo usuario', async () => {
      await darDeAltaPerfil({
        id: 'perfil-personal',
        personalAccountId: PERSONAL_ACCOUNT_ID,
        status: BILLING_PROFILE_STATUS_ENUM.FREE,
        currentPlanType: 'free',
      });
      await darDeAltaPerfil({
        id: 'perfil-organizacion',
        organizationId: ORGANIZATION_ID,
        status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
        currentPlanType: 'enterprise',
      });
      await darDeAltaLote({
        id: 'lote-org',
        billingProfileId: 'perfil-organizacion',
        remaining: 40,
      });

      const personal = await consultarEstado();
      const organizacion = await consultarEstado(ORGANIZATION_ACCOUNT_ID);

      expect(personal.body.data).toMatchObject({
        billingProfileId: 'perfil-personal',
        hasActiveSubscription: false,
        creditsAvailable: 0,
        actions: PLAN_ENTITLEMENTS.free.actions,
      });
      expect(organizacion.body.data).toMatchObject({
        billingProfileId: 'perfil-organizacion',
        hasActiveSubscription: true,
        creditsAvailable: 40,
        actions: PLAN_ENTITLEMENTS.enterprise.actions,
      });
    });
  });

  describe('perfil inexistente', () => {
    it('responde 200 con el estado Free seguro y sin crear el perfil', async () => {
      const response = await consultarEstado();

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({
        billingProfileId: null,
        hasActiveSubscription: false,
        currentPlanType: null,
        status: null,
        billingSource: null,
        cancelAtPeriodEnd: false,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        creditsAvailable: 0,
        actions: PLAN_ENTITLEMENTS.free.actions,
        limits: PLAN_ENTITLEMENTS.free.limits,
      });
      // Consultar no da de alta: la tabla sigue vacía después de la petición.
      expect(billingProfiles.rows).toHaveLength(0);
    });
  });

  describe('estado del perfil', () => {
    it.each([
      BILLING_PROFILE_STATUS_ENUM.INCOMPLETE,
      BILLING_PROFILE_STATUS_ENUM.PAST_DUE,
      BILLING_PROFILE_STATUS_ENUM.CANCELED,
    ])(
      'responde hasActiveSubscription=false con el perfil %s',
      async (status) => {
        await darDeAltaPerfil({
          id: 'perfil-personal',
          personalAccountId: PERSONAL_ACCOUNT_ID,
          status,
          currentPlanType: 'plus',
        });

        const response = await consultarEstado();

        expect(response.status).toBe(200);
        expect(response.body.data).toMatchObject({
          billingProfileId: 'perfil-personal',
          hasActiveSubscription: false,
          // El plan se conserva: sigue siendo el último contratado.
          currentPlanType: 'plus',
          status,
        });
      },
    );
  });

  describe('quién consulta', () => {
    it('responde 400 si falta el header X-Account-Id', async () => {
      const response = await consultarEstado(null);

      expect(response.status).toBe(400);
      expect(response.body.message).toContain('X-Account-Id');
    });

    /** Sin esto, cambiar el header dejaría leer el plan, el saldo y los beneficios ajenos. */
    it('responde 403 si el usuario no pertenece a la cuenta del header', async () => {
      const response = await consultarEstado(AJENA_ACCOUNT_ID);

      expect(response.status).toBe(403);
    });

    it('responde 403 si la membresía está dada de baja', async () => {
      Object.assign(accounts.rows[0], { isActive: false });

      const response = await consultarEstado();

      expect(response.status).toBe(403);
    });
  });
});
