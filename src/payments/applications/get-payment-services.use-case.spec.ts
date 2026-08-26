import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { StripePaymentGatewayService } from '../stripe/stripe-payment-gateway.service';
import { GetPaymentServicesUseCase } from './get-payment-services.use-case';

const SERVICIO = {
  priceId: 'price_mensual',
  productId: 'prod_1',
  name: 'Plan Pro',
  description: 'Firma ilimitada',
  unitAmount: 49900,
  currency: 'mxn',
  interval: 'month',
  intervalCount: 1,
  imageUrl: 'https://files.stripe.com/plan-pro.png',
};

describe('GetPaymentServicesUseCase', () => {
  let useCase: GetPaymentServicesUseCase;
  let paymentGateway: { listActiveServices: jest.Mock };

  beforeEach(async () => {
    paymentGateway = {
      listActiveServices: jest.fn().mockResolvedValue([SERVICIO]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetPaymentServicesUseCase,
        { provide: StripePaymentGatewayService, useValue: paymentGateway },
      ],
    }).compile();

    useCase = module.get(GetPaymentServicesUseCase);
  });

  it('devuelve lo que necesitan las tarjetas', async () => {
    const [servicio] = await useCase.execute();

    expect(servicio).toEqual({
      priceId: 'price_mensual',
      name: 'Plan Pro',
      description: 'Firma ilimitada',
      unitAmount: 49900,
      currency: 'mxn',
      interval: 'month',
      intervalCount: 1,
      imageUrl: 'https://files.stripe.com/plan-pro.png',
    });
  });

  it('no filtra identificadores internos del proveedor', async () => {
    const [servicio] = await useCase.execute();

    expect(servicio).not.toHaveProperty('productId');
  });

  /**
   * La regla del ticket: el catálogo no abre sesiones de pago. Si alguna vez alguien las
   * agregara aquí, se estarían creando tantas URLs temporales como tarjetas se muestran.
   */
  it('no devuelve ninguna URL de pago', async () => {
    const [servicio] = await useCase.execute();

    expect(JSON.stringify(servicio)).not.toContain('checkout.stripe.com');
    expect(servicio).not.toHaveProperty('checkoutUrl');
  });

  it('un catálogo vacío es una lista vacía, no un error', async () => {
    paymentGateway.listActiveServices.mockResolvedValue([]);

    await expect(useCase.execute()).resolves.toEqual([]);
  });

  /**
   * Es la única forma en que la pantalla se queda sin tarjetas **sin que nada falle**: 200, lista
   * vacía y ni una línea en los logs. Desde afuera se reporta igual que un error ("no cargan los
   * planes"), así que sin este aviso hay que reproducirlo para distinguir los dos casos.
   */
  it('deja constancia en el log cuando el catálogo viene vacío', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    paymentGateway.listActiveServices.mockResolvedValue([]);

    await useCase.execute();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no devolvió ningún servicio vendible'),
    );

    warn.mockRestore();
  });

  it('no avisa de nada cuando el catálogo sí trae servicios', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await useCase.execute();

    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
  });
});
