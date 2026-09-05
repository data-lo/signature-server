import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as request from 'supertest';

import { applyGlobalApiPrefix } from './../src/shared/constants/api-prefix.constants';
import { PaymentsController } from './../src/payments/payments.controller';
import { GetPublicStripePlansUseCase } from './../src/payments/applications/get-public-stripe-plans.use-case';
import { GetSubscriptionStateUseCase } from './../src/payments/applications/get-subscription-state.use-case';
import { StripePaymentService } from './../src/payments/stripe/stripe-payment.service';
import { CreateSubscriptionCheckoutUseCase } from './../src/billing/checkout/create-subscription-checkout.use-case';
import { GetBillingStateUseCase } from './../src/billing/profiles/get-billing-state.use-case';
import { BillingOwnerService } from './../src/billing/profiles/billing-owner.service';
import { BillingCatalogService } from './../src/billing/catalog/billing-catalog.service';
import { CheckoutOrderService } from './../src/billing/checkout/checkout-order.service';
import { BillingProfileEntity } from './../src/billing/profiles/billing-profile.entity';
import { CheckoutOrderEntity } from './../src/billing/checkout/checkout-order.entity';
import { CatalogPriceEntity } from './../src/billing/catalog/catalog-price.entity';
import { AccountEntity } from './../src/account/entities/account.entity';
import { ACCOUNT_TYPE_ENUM } from './../src/account/enums/account-type.enum';
import { BILLING_INTERVAL_ENUM } from './../src/billing/enums/billing-interval.enum';
import { BILLING_PROFILE_STATUS_ENUM } from './../src/billing/enums/billing-profile-status.enum';
import { CHECKOUT_KIND_ENUM } from './../src/billing/enums/checkout-kind.enum';
import { CHECKOUT_ORDER_STATUS_ENUM } from './../src/billing/enums/checkout-order-status.enum';
import { CATALOG_PRICE_BILLING_MODE_ENUM } from './../src/billing/enums/catalog-price-billing-mode.enum';
import {
  createInMemoryRepository,
  InMemoryRepository,
} from './billing-e2e-fixtures';

const CHECKOUT_ENDPOINT = '/api/v1/payments/checkout-sessions';

const USER_ID = 'usuario-1';
const USER_EMAIL = 'firmante@ejemplo.com';
const PERSONAL_ACCOUNT_ID = 'cuenta-personal-1';
const ORGANIZATION_ACCOUNT_ID = 'cuenta-org-1';
const ORGANIZATION_ID = 'organizacion-1';
const AJENA_ACCOUNT_ID = 'cuenta-de-otro';

const PRICE_ID = 'price_planPro';
const CATALOG_PRICE_ID = 'precio-1';
const PLAN_TYPE = 'pro';
const CHECKOUT_URL = 'https://checkout.stripe.com/c/pay/cs_e2e';
const SESSION_ID = 'cs_e2e';

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
 * Apertura de una suscripción vista desde fuera: `POST /api/v1/payments/checkout-sessions`.
 *
 * Lo único sustituido además de la base de datos es la llamada saliente a Stripe — el resto
 * (controlador, `ValidationPipe` con la misma configuración de `main.ts`, resolución del
 * propietario facturable, catálogo local y registro de la orden) es el código real.
 *
 * Las tres reglas que sostienen el flujo y que sólo se ven completas por HTTP: quién paga sale
 * del header `X-Account-Id` y se verifica contra `accounts`; el precio se valida contra el
 * catálogo LOCAL y no contra Stripe; y la orden PENDING se registra con el `cs_...` que después
 * usará el webhook para reconciliar.
 */
describe('Checkout de suscripción (e2e)', () => {
  let app: INestApplication;
  let accounts: InMemoryRepository<never>;
  let billingProfiles: InMemoryRepository<never>;
  let checkoutOrders: InMemoryRepository<never>;
  let createCheckoutSession: jest.Mock;
  let createCustomer: jest.Mock;

  function openCheckout(options?: {
    accountId?: string | null;
    priceId?: string;
  }) {
    const pending = request(app.getHttpServer()).post(CHECKOUT_ENDPOINT);
    const accountId =
      options?.accountId === undefined
        ? PERSONAL_ACCOUNT_ID
        : options.accountId;

    if (accountId !== null) {
      pending.set('X-Account-Id', accountId);
    }

    return pending.send({ priceId: options?.priceId ?? PRICE_ID });
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
    checkoutOrders = createInMemoryRepository();

    const plan = {
      planType: PLAN_TYPE,
      name: 'Plan Pro',
      isActive: true,
      documentsIncluded: 50,
    };

    const catalogPrices = createInMemoryRepository([
      {
        id: CATALOG_PRICE_ID,
        stripePriceId: PRICE_ID,
        amount: 49900,
        currency: 'mxn',
        billingMode: CATALOG_PRICE_BILLING_MODE_ENUM.RECURRING,
        interval: BILLING_INTERVAL_ENUM.MONTH,
        intervalCount: 1,
        isActive: true,
        effectiveFrom: null,
        effectiveTo: null,
        catalogItem: { isActive: true, plan, scopes: [] },
      },
      {
        id: 'precio-archivado',
        stripePriceId: 'price_archivado',
        amount: 39900,
        currency: 'mxn',
        billingMode: CATALOG_PRICE_BILLING_MODE_ENUM.RECURRING,
        interval: BILLING_INTERVAL_ENUM.MONTH,
        intervalCount: 1,
        isActive: false,
        effectiveFrom: null,
        effectiveTo: null,
        catalogItem: { isActive: true, plan, scopes: [] },
      },
    ] as never[]);

    createCheckoutSession = jest.fn().mockResolvedValue({
      sessionId: SESSION_ID,
      checkoutUrl: CHECKOUT_URL,
    });
    createCustomer = jest.fn().mockResolvedValue('cus_e2e');

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [PaymentsController],
      providers: [
        CreateSubscriptionCheckoutUseCase,
        // Lo pide el controller para `GET /billing-state`, que tiene su propia prueba e2e.
        GetBillingStateUseCase,
        BillingOwnerService,
        BillingCatalogService,
        CheckoutOrderService,
        { provide: APP_GUARD, useClass: FakeAuthGuard },
        {
          provide: StripePaymentService,
          useValue: { createCheckoutSession, createCustomer },
        },
        {
          provide: GetPublicStripePlansUseCase,
          useValue: { execute: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: GetSubscriptionStateUseCase,
          useValue: { execute: jest.fn().mockResolvedValue(null) },
        },
        { provide: getRepositoryToken(AccountEntity), useValue: accounts },
        {
          provide: getRepositoryToken(BillingProfileEntity),
          useValue: billingProfiles,
        },
        {
          provide: getRepositoryToken(CheckoutOrderEntity),
          useValue: checkoutOrders,
        },
        { provide: getRepositoryToken(CatalogPriceEntity), useValue: catalogPrices },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    // Mismos pipes y mismo prefijo que monta `main.ts`: sin esto la prueba validaría un ruteo
    // y un saneado de entrada que no son los de producción.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    applyGlobalApiPrefix(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('camino feliz', () => {
    it('devuelve la URL de Checkout y registra la orden PENDING', async () => {
      const response = await openCheckout();

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        success: true,
        data: { checkoutUrl: CHECKOUT_URL },
      });

      expect(checkoutOrders.rows).toHaveLength(1);
      expect(checkoutOrders.rows[0]).toMatchObject({
        catalogPriceId: CATALOG_PRICE_ID,
        kind: CHECKOUT_KIND_ENUM.SUBSCRIPTION,
        stripeCheckoutSessionId: SESSION_ID,
        status: CHECKOUT_ORDER_STATUS_ENUM.PENDING,
        amount: 49900,
        currency: 'mxn',
      });
    });

    /**
     * Desde que toda cuenta nace con su `billing_profile` en plan Free, ÉSTE es el camino normal
     * de una primera contratación: quien pulsa "Contratar" ya tiene perfil, y viene en FREE.
     *
     * Antes el perfil se creaba aquí mismo, así que la prueba de arriba —que parte de una tabla
     * vacía— era el caso real. Ahora es el excepcional (una cuenta anterior al plan gratuito),
     * y hace falta cubrir el que de verdad va a ocurrir: el plan gratuito NO puede estorbar la
     * compra, ni reutilizando su perfil ni bloqueando la sesión.
     */
    it('un perfil en plan Free puede contratar, reutilizando su perfil', async () => {
      await billingProfiles.save({
        id: 'perfil-free',
        personalAccountId: PERSONAL_ACCOUNT_ID,
        organizationId: null,
        currentPlanType: 'free',
        status: BILLING_PROFILE_STATUS_ENUM.FREE,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
      } as never);

      const response = await openCheckout();

      expect(response.status).toBe(201);
      expect(billingProfiles.rows).toHaveLength(1);
      expect(createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            billingProfileId: 'perfil-free',
          }),
        }),
      );
      expect(checkoutOrders.rows).toHaveLength(1);
    });

    /**
     * La metadata es el único hilo que une esta sesión con el webhook posterior: sin
     * `billingProfileId` el cobro llegaría sin saber a qué perfil abonar los documentos.
     */
    it('manda a Stripe la metadata con la que el webhook reconcilia después', async () => {
      await openCheckout();

      const perfil = billingProfiles.rows[0] as { id: string };

      expect(createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'subscription',
          priceId: PRICE_ID,
          customerId: 'cus_e2e',
          metadata: {
            billingProfileId: perfil.id,
            planType: PLAN_TYPE,
            catalogPriceId: CATALOG_PRICE_ID,
            accountId: PERSONAL_ACCOUNT_ID,
          },
        }),
      );
    });

    it('crea el perfil de facturación la primera vez y reutiliza el cliente de Stripe después', async () => {
      await openCheckout();
      await openCheckout();

      expect(billingProfiles.rows).toHaveLength(1);
      expect(billingProfiles.rows[0]).toMatchObject({
        personalAccountId: PERSONAL_ACCOUNT_ID,
        organizationId: null,
        stripeCustomerId: 'cus_e2e',
      });
      // El cliente se crea UNA sola vez: si se creara por sesión, el historial de facturación
      // del mismo propietario quedaría repartido entre clientes distintos.
      expect(createCustomer).toHaveBeenCalledTimes(1);
    });

    /**
     * En una organización el propietario del dinero es la organización, no la fila de membresía
     * del empleado. Si esto se rompiera, cada empleado tendría su propio saldo en vez del que
     * comparte la organización — y sólo se nota facturando.
     */
    it('en una cuenta de organización factura a la organización, no a la membresía', async () => {
      const response = await openCheckout({
        accountId: ORGANIZATION_ACCOUNT_ID,
      });

      expect(response.status).toBe(201);
      expect(billingProfiles.rows[0]).toMatchObject({
        personalAccountId: null,
        organizationId: ORGANIZATION_ID,
      });
    });

    it('reutiliza el perfil ya existente del propietario', async () => {
      await billingProfiles.save({
        id: 'perfil-existente',
        personalAccountId: PERSONAL_ACCOUNT_ID,
        organizationId: null,
        stripeCustomerId: 'cus_anterior',
        status: BILLING_PROFILE_STATUS_ENUM.INCOMPLETE,
      } as never);

      await openCheckout();

      expect(billingProfiles.rows).toHaveLength(1);
      expect(createCustomer).not.toHaveBeenCalled();
      expect(createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({ customerId: 'cus_anterior' }),
      );
    });
  });

  /**
   * Una suscripción vigente por propietario. Lo que se comprueba acá y no en la prueba unitaria
   * es el código HTTP que ve el frontend y —lo importante— que ni Stripe ni `checkout_orders`
   * se tocan: una orden PENDING de más nunca se reconcilia, y una sesión de más es una segunda
   * suscripción cobrándose en paralelo esperando a que el usuario la complete.
   */
  describe('suscripción ya activa', () => {
    async function darDeAltaPerfil(
      owner: {
        personalAccountId: string | null;
        organizationId: string | null;
      },
      status: BILLING_PROFILE_STATUS_ENUM,
    ) {
      await billingProfiles.save({
        id: `perfil-${status}`,
        ...owner,
        stripeCustomerId: 'cus_anterior',
        stripeSubscriptionId: 'sub_anterior',
        status,
      } as never);
    }

    const PERSONAL = {
      personalAccountId: PERSONAL_ACCOUNT_ID,
      organizationId: null,
    };
    const ORGANIZACION = {
      personalAccountId: null,
      organizationId: ORGANIZATION_ID,
    };

    it('responde 409 en una cuenta personal con el perfil ACTIVE', async () => {
      await darDeAltaPerfil(PERSONAL, BILLING_PROFILE_STATUS_ENUM.ACTIVE);

      const response = await openCheckout();

      expect(response.status).toBe(409);
      expect(response.body.message).toMatch(/suscripción activa/i);
      expect(createCheckoutSession).not.toHaveBeenCalled();
      expect(checkoutOrders.rows).toHaveLength(0);
    });

    /**
     * El caso que sólo existe en organizaciones: el perfil es compartido, así que un segundo
     * miembro que abra "Contratar" sin saber que la organización ya paga tiene que chocar con
     * el mismo 409 aunque su fila de `accounts` sea distinta.
     */
    it('responde 409 en una cuenta de organización con el perfil ACTIVE', async () => {
      await darDeAltaPerfil(ORGANIZACION, BILLING_PROFILE_STATUS_ENUM.ACTIVE);

      const response = await openCheckout({
        accountId: ORGANIZATION_ACCOUNT_ID,
      });

      expect(response.status).toBe(409);
      expect(createCheckoutSession).not.toHaveBeenCalled();
      expect(checkoutOrders.rows).toHaveLength(0);
    });

    it('no confunde propietarios: la cuenta personal puede contratar aunque la organización esté ACTIVE', async () => {
      await darDeAltaPerfil(ORGANIZACION, BILLING_PROFILE_STATUS_ENUM.ACTIVE);

      const response = await openCheckout();

      expect(response.status).toBe(201);
      expect(createCheckoutSession).toHaveBeenCalledTimes(1);
    });

    it.each([
      BILLING_PROFILE_STATUS_ENUM.INCOMPLETE,
      BILLING_PROFILE_STATUS_ENUM.PAST_DUE,
      BILLING_PROFILE_STATUS_ENUM.CANCELED,
    ])('deja abrir un Checkout nuevo si el perfil está %s', async (status) => {
      await darDeAltaPerfil(PERSONAL, status);

      const response = await openCheckout();

      expect(response.status).toBe(201);
      expect(createCheckoutSession).toHaveBeenCalledTimes(1);
      expect(checkoutOrders.rows).toHaveLength(1);
    });
  });

  describe('quién paga', () => {
    it('responde 400 si falta el header X-Account-Id', async () => {
      const response = await openCheckout({ accountId: null });

      expect(response.status).toBe(400);
      expect(response.body.message).toContain('X-Account-Id');
      expect(createCheckoutSession).not.toHaveBeenCalled();
    });

    /**
     * El header lo elige el cliente: sin esta comprobación cualquiera podría contratar —y cargar
     * el saldo— en nombre de una cuenta que no es suya con sólo cambiar un valor de la petición.
     */
    it('responde 403 si el usuario no pertenece a la cuenta del header', async () => {
      const response = await openCheckout({ accountId: AJENA_ACCOUNT_ID });

      expect(response.status).toBe(403);
      expect(createCheckoutSession).not.toHaveBeenCalled();
      expect(checkoutOrders.rows).toHaveLength(0);
    });

    it('responde 403 si la membresía está dada de baja', async () => {
      Object.assign(accounts.rows[0], { isActive: false });

      const response = await openCheckout();

      expect(response.status).toBe(403);
      expect(createCheckoutSession).not.toHaveBeenCalled();
    });
  });

  describe('validación del precio', () => {
    it('responde 404 si el precio no está en el catálogo local', async () => {
      const response = await openCheckout({ priceId: 'price_inexistente' });

      expect(response.status).toBe(404);
      expect(createCheckoutSession).not.toHaveBeenCalled();
      expect(checkoutOrders.rows).toHaveLength(0);
    });

    /** Mismo 404 que un precio inexistente: responder distinto permitiría sondear el catálogo. */
    it('responde 404 si el precio está archivado', async () => {
      const response = await openCheckout({ priceId: 'price_archivado' });

      expect(response.status).toBe(404);
      expect(createCheckoutSession).not.toHaveBeenCalled();
    });

    it('responde 400 si el priceId no tiene forma de precio de Stripe', async () => {
      const response = await openCheckout({ priceId: 'no-es-un-precio' });

      expect(response.status).toBe(400);
      expect(createCheckoutSession).not.toHaveBeenCalled();
    });

    it('descarta los campos no declarados en el DTO', async () => {
      const response = await request(app.getHttpServer())
        .post(CHECKOUT_ENDPOINT)
        .set('X-Account-Id', PERSONAL_ACCOUNT_ID)
        .send({ priceId: PRICE_ID, amount: 1 });

      expect(response.status).toBe(201);
      expect(checkoutOrders.rows[0]).toMatchObject({ amount: 49900 });
    });
  });

  describe('prefijo global', () => {
    it('no responde en la ruta sin el prefijo /api/v1', async () => {
      const response = await request(app.getHttpServer())
        .post('/payments/checkout-sessions')
        .set('X-Account-Id', PERSONAL_ACCOUNT_ID)
        .send({ priceId: PRICE_ID });

      expect(response.status).toBe(404);
    });
  });
});
