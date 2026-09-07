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
import { GetBillingStateUseCase } from './../src/billing/profiles/get-billing-state.use-case';
import { BillingOwnerService } from './../src/billing/profiles/billing-owner.service';
import { BillingProfileEntity } from './../src/billing/profiles/billing-profile.entity';
import { AccountEntity } from './../src/account/entities/account.entity';
import { AccountSubscriptionEntity } from './../src/payments/entities/account-subscription.entity';
import { ACCOUNT_TYPE_ENUM } from './../src/account/enums/account-type.enum';
import { BILLING_PROFILE_STATUS_ENUM } from './../src/billing/enums/billing-profile-status.enum';
import {
  createInMemoryRepository,
  InMemoryRepository,
} from './billing-e2e-fixtures';

const SUBSCRIPTION_ENDPOINT = '/api/v1/payments/subscription';

const USER_ID = 'usuario-1';
const USER_EMAIL = 'firmante@ejemplo.com';
const PERSONAL_ACCOUNT_ID = 'cuenta-personal-1';
const ORGANIZATION_ACCOUNT_ID = 'cuenta-org-1';
const ORGANIZATION_ID = 'organizacion-1';
const AJENA_ACCOUNT_ID = 'cuenta-de-otro';

const PERIODO_INICIO = '2030-01-01T00:00:00.000Z';
const PERIODO_FIN = '2030-02-01T00:00:00.000Z';

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
 * Estado de suscripción visto desde fuera: `GET /api/v1/payments/subscription`.
 *
 * Lo que sólo se ve por HTTP: que la cuenta consultada sale del header `X-Account-Id` y se
 * traduce al propietario con el `BillingOwnerService` real contra `accounts` —personal por
 * `personal_account_id`, organización por `organization_id`— y que la respuesta sale de
 * `billing_profiles`.
 *
 * Se registra a propósito un repositorio de `account_subscriptions` con filas dentro: si alguien
 * volviera a leer de ahí, las pruebas de abajo lo cazarían, porque esas filas dicen lo contrario
 * que los perfiles.
 */
describe('Estado de suscripción (e2e)', () => {
  let app: INestApplication;
  let accounts: InMemoryRepository<never>;
  let billingProfiles: InMemoryRepository<never>;
  let accountSubscriptions: InMemoryRepository<never>;

  function consultar(accountId?: string | null) {
    const pending = request(app.getHttpServer()).get(SUBSCRIPTION_ENDPOINT);
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
    currentPeriodStart?: string | null;
    currentPeriodEnd?: string | null;
  }) {
    await billingProfiles.save({
      personalAccountId: null,
      organizationId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      ...perfil,
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

    /**
     * El modelo heredado, poblado con lo CONTRARIO de lo que dirán los perfiles: sin suscripción
     * y sin firma habilitada. Es la trampa — si el endpoint volviera a leer de acá, ninguna de
     * las pruebas de "activa" pasaría.
     */
    accountSubscriptions = createInMemoryRepository([
      {
        id: 'suscripcion-heredada',
        accountId: PERSONAL_ACCOUNT_ID,
        planId: null,
        status: 'canceled',
        signingEnabled: false,
        currentPeriodEnd: null,
      },
    ] as never[]);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [PaymentsController],
      providers: [
        GetSubscriptionStateUseCase,
        BillingOwnerService,
        { provide: APP_GUARD, useClass: FakeAuthGuard },
        {
          provide: GetPublicStripePlansUseCase,
          useValue: { execute: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: CreateSubscriptionCheckoutUseCase,
          useValue: { execute: jest.fn() },
        },
        // Lo pide el controller para `GET /billing-state`, que tiene su propia prueba e2e.
        GetBillingStateUseCase,
        { provide: getRepositoryToken(AccountEntity), useValue: accounts },
        {
          provide: getRepositoryToken(BillingProfileEntity),
          useValue: billingProfiles,
        },
        {
          provide: getRepositoryToken(AccountSubscriptionEntity),
          useValue: accountSubscriptions,
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
    it('lee el perfil por personal_account_id', async () => {
      await darDeAltaPerfil({
        id: 'perfil-personal',
        personalAccountId: PERSONAL_ACCOUNT_ID,
        status: BILLING_PROFILE_STATUS_ENUM.PAST_DUE,
        currentPlanType: 'basic',
      });

      const response = await consultar();

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        hasActiveSubscription: false,
        planType: 'basic',
        status: BILLING_PROFILE_STATUS_ENUM.PAST_DUE,
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
        currentPeriodStart: PERIODO_INICIO,
        currentPeriodEnd: PERIODO_FIN,
      });

      const response = await consultar(ORGANIZATION_ACCOUNT_ID);

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({
        hasActiveSubscription: true,
        planType: 'premium',
        status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
        currentPeriodStart: PERIODO_INICIO,
        currentPeriodEnd: PERIODO_FIN,
      });
    });

    /**
     * El motivo del header: el MISMO usuario tiene dos suscripciones a la vez y la respuesta
     * depende de en cuál esté trabajando. Es lo que la versión anterior no podía distinguir.
     */
    it('responde distinto para la cuenta personal y la organización del mismo usuario', async () => {
      await darDeAltaPerfil({
        id: 'perfil-personal',
        personalAccountId: PERSONAL_ACCOUNT_ID,
        status: BILLING_PROFILE_STATUS_ENUM.CANCELED,
        currentPlanType: 'basic',
      });
      await darDeAltaPerfil({
        id: 'perfil-organizacion',
        organizationId: ORGANIZATION_ID,
        status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
        currentPlanType: 'premium',
      });

      const personal = await consultar();
      const organizacion = await consultar(ORGANIZATION_ACCOUNT_ID);

      expect(personal.body.data.hasActiveSubscription).toBe(false);
      expect(personal.body.data.planType).toBe('basic');
      expect(organizacion.body.data.hasActiveSubscription).toBe(true);
      expect(organizacion.body.data.planType).toBe('premium');
    });
  });

  describe('perfil inexistente', () => {
    it('responde 200 con el estado vacío, no un error', async () => {
      const response = await consultar();

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({
        hasActiveSubscription: false,
        planType: null,
        status: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
      });
      // Consultar no da de alta: la tabla sigue vacía después de la petición.
      expect(billingProfiles.rows).toHaveLength(0);
    });
  });

  describe('perfil ACTIVE', () => {
    /**
     * El caso que motiva la historia: tras `invoice.paid` el perfil queda ACTIVE, y la pantalla
     * tiene que verlo como activa aunque `account_subscriptions` —poblada arriba con
     * `signingEnabled: false` y `status: canceled`— siga diciendo lo contrario.
     */
    it('reporta la suscripción como activa pese a lo que diga el modelo heredado', async () => {
      await darDeAltaPerfil({
        id: 'perfil-personal',
        personalAccountId: PERSONAL_ACCOUNT_ID,
        status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
        currentPlanType: 'plus',
        currentPeriodStart: PERIODO_INICIO,
        currentPeriodEnd: PERIODO_FIN,
      });

      const response = await consultar();

      expect(response.body.data).toEqual({
        hasActiveSubscription: true,
        planType: 'plus',
        status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
        currentPeriodStart: PERIODO_INICIO,
        currentPeriodEnd: PERIODO_FIN,
      });
    });

    it('no toca account_subscriptions para responder', async () => {
      await darDeAltaPerfil({
        id: 'perfil-personal',
        personalAccountId: PERSONAL_ACCOUNT_ID,
        status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
        currentPlanType: 'plus',
      });

      await consultar();

      expect(accountSubscriptions.findOne).not.toHaveBeenCalled();
      expect(accountSubscriptions.find).not.toHaveBeenCalled();
      expect(accountSubscriptions.findOneBy).not.toHaveBeenCalled();
    });
  });

  describe('plan gratuito', () => {
    it('responde el plan Free sin marcarlo como suscripción activa', async () => {
      await darDeAltaPerfil({
        id: 'perfil-free',
        personalAccountId: PERSONAL_ACCOUNT_ID,
        status: BILLING_PROFILE_STATUS_ENUM.FREE,
        currentPlanType: 'free',
      });

      const response = await consultar();

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({
        hasActiveSubscription: false,
        planType: 'free',
        status: BILLING_PROFILE_STATUS_ENUM.FREE,
        currentPeriodStart: null,
        currentPeriodEnd: null,
      });
    });
  });

  describe('quién consulta', () => {
    it('responde 400 si falta el header X-Account-Id', async () => {
      const response = await consultar(null);

      expect(response.status).toBe(400);
      expect(response.body.message).toContain('X-Account-Id');
    });

    /** Sin esto, cambiar el header dejaría leer la suscripción de una cuenta ajena. */
    it('responde 403 si el usuario no pertenece a la cuenta del header', async () => {
      const response = await consultar(AJENA_ACCOUNT_ID);

      expect(response.status).toBe(403);
    });

    it('responde 403 si la membresía está dada de baja', async () => {
      Object.assign(accounts.rows[0], { isActive: false });

      const response = await consultar();

      expect(response.status).toBe(403);
    });
  });
});
