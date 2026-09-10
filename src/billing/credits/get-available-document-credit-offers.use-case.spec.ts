import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { GetAvailableDocumentCreditOffersUseCase } from './get-available-document-credit-offers.use-case';
import { BillingOwnerService } from '../profiles/billing-owner.service';
import { BillingCatalogService } from '../catalog/billing-catalog.service';

const PERSONAL_OWNER = {
  personalAccountId: 'account-1',
  organizationId: null,
};

/** Un precio del catálogo local, tal como lo devuelve `findAvailableDocumentCreditPrices`. */
function precio(overrides: Record<string, unknown> = {}) {
  return {
    id: 'catalog-price-1',
    stripePriceId: 'price_extra_doc',
    amount: 3900,
    currency: 'mxn',
    catalogItemId: 'catalog-item-1',
    catalogItem: {
      name: 'Documento adicional',
      documentCreditPack: { documentsGranted: 1 },
    },
    ...overrides,
  };
}

describe('GetAvailableDocumentCreditOffersUseCase', () => {
  let useCase: GetAvailableDocumentCreditOffersUseCase;
  let billingOwnerService: {
    resolveOwner: jest.Mock;
    findProfileByOwner: jest.Mock;
  };
  let billingCatalogService: { findAvailableDocumentCreditPrices: jest.Mock };

  beforeEach(async () => {
    billingOwnerService = {
      resolveOwner: jest.fn().mockResolvedValue(PERSONAL_OWNER),
      findProfileByOwner: jest
        .fn()
        .mockResolvedValue({ id: 'perfil-1', currentPlanType: 'free' }),
    };
    billingCatalogService = {
      findAvailableDocumentCreditPrices: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetAvailableDocumentCreditOffersUseCase,
        { provide: BillingOwnerService, useValue: billingOwnerService },
        { provide: BillingCatalogService, useValue: billingCatalogService },
      ],
    }).compile();

    useCase = module.get(GetAvailableDocumentCreditOffersUseCase);
  });

  const consultar = () =>
    useCase.execute({ userId: 'user-1', accountId: 'account-1' });

  describe('plan gratuito', () => {
    /** El ejemplo de la historia: Free → 1 documento por $39 MXN. */
    it('devuelve el paquete configurado para Free, con todo lo que la tarjeta necesita', async () => {
      billingCatalogService.findAvailableDocumentCreditPrices.mockResolvedValue([
        precio(),
      ]);

      await expect(consultar()).resolves.toEqual([
        {
          catalogPriceId: 'catalog-price-1',
          name: 'Documento adicional',
          documentsGranted: 1,
          amount: 3900,
          currency: 'mxn',
          stripePriceId: 'price_extra_doc',
        },
      ]);
    });

    /**
     * El plan sale del perfil resuelto en el servidor, nunca de la petición: es lo que impide
     * que alguien pida las tarifas de Premium desde una cuenta Free.
     */
    it('consulta el catálogo con el plan del perfil, no con nada de la petición', async () => {
      await consultar();

      expect(
        billingCatalogService.findAvailableDocumentCreditPrices,
      ).toHaveBeenCalledWith('free', PERSONAL_OWNER);
    });
  });

  describe('plan de pago', () => {
    it('consulta con el plan contratado y devuelve sus paquetes', async () => {
      billingOwnerService.findProfileByOwner.mockResolvedValue({
        id: 'perfil-1',
        currentPlanType: 'premium',
      });
      billingCatalogService.findAvailableDocumentCreditPrices.mockResolvedValue([
        precio({
          id: 'catalog-price-premium',
          amount: 9900,
          catalogItem: {
            name: 'Paquete de 10 documentos',
            documentCreditPack: { documentsGranted: 10 },
          },
        }),
      ]);

      const ofertas = await consultar();

      expect(
        billingCatalogService.findAvailableDocumentCreditPrices,
      ).toHaveBeenCalledWith('premium', PERSONAL_OWNER);
      expect(ofertas).toEqual([
        expect.objectContaining({
          catalogPriceId: 'catalog-price-premium',
          documentsGranted: 10,
          amount: 9900,
        }),
      ]);
    });

    /**
     * Una baja programada no cambia el plan vigente: sigue ACTIVE hasta el fin del periodo y sus
     * tarifas siguen siendo las suyas.
     */
    it('sigue ofreciendo los paquetes de su plan con la baja programada', async () => {
      billingOwnerService.findProfileByOwner.mockResolvedValue({
        id: 'perfil-1',
        currentPlanType: 'premium',
        cancelAtPeriodEnd: true,
      });
      billingCatalogService.findAvailableDocumentCreditPrices.mockResolvedValue([
        precio(),
      ]);

      await expect(consultar()).resolves.toHaveLength(1);
      expect(
        billingCatalogService.findAvailableDocumentCreditPrices,
      ).toHaveBeenCalledWith('premium', PERSONAL_OWNER);
    });
  });

  describe('sin ofertas que mostrar', () => {
    /** Es un estado normal del catálogo, y la pantalla lo dibuja como tal. */
    it('un plan sin paquetes configurados devuelve una lista vacía', async () => {
      await expect(consultar()).resolves.toEqual([]);
    });

    /**
     * No se cae a `free` por defecto: inventar un plan ofrecería las tarifas de Free a una cuenta
     * cuyo estado real es "todavía no lo sé".
     */
    it('una cuenta sin perfil no tiene ofertas y no consulta el catálogo', async () => {
      billingOwnerService.findProfileByOwner.mockResolvedValue(null);

      await expect(consultar()).resolves.toEqual([]);
      expect(
        billingCatalogService.findAvailableDocumentCreditPrices,
      ).not.toHaveBeenCalled();
    });

    it('un perfil sin plan vigente tampoco tiene ofertas', async () => {
      billingOwnerService.findProfileByOwner.mockResolvedValue({
        id: 'perfil-1',
        currentPlanType: null,
      });

      await expect(consultar()).resolves.toEqual([]);
      expect(
        billingCatalogService.findAvailableDocumentCreditPrices,
      ).not.toHaveBeenCalled();
    });

    /**
     * Una oferta sin precio publicado en Stripe no se puede llevar a Checkout: listarla sería
     * pintar un botón que revienta al pulsarlo.
     */
    it('descarta los paquetes que no tienen precio publicado en Stripe', async () => {
      billingCatalogService.findAvailableDocumentCreditPrices.mockResolvedValue([
        precio({ id: 'sin-stripe', stripePriceId: null }),
        precio(),
      ]);

      const ofertas = await consultar();

      expect(ofertas).toHaveLength(1);
      expect(ofertas[0].catalogPriceId).toBe('catalog-price-1');
    });
  });

  /** `resolveOwner` comprueba de paso la membresía: un `X-Account-Id` ajeno no ve nada. */
  it('propaga el 403 de una cuenta que no es del usuario', async () => {
    billingOwnerService.resolveOwner.mockRejectedValue(
      new ForbiddenException('No perteneces a esta cuenta'),
    );

    await expect(consultar()).rejects.toThrow(ForbiddenException);
  });

  /** Es una consulta: mirar la pantalla no debe crear filas. */
  it('no crea perfil al consultar', async () => {
    await consultar();

    expect(billingOwnerService.findProfileByOwner).toHaveBeenCalledWith(
      PERSONAL_OWNER,
    );
    expect(
      (billingOwnerService as Record<string, unknown>).getOrCreateProfile,
    ).toBeUndefined();
  });
});
