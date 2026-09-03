import { Test, TestingModule } from '@nestjs/testing';
import { BadGatewayException, Logger } from '@nestjs/common';
import { RedisService } from 'src/shared/redis/redis.service';
import { StripePaymentService } from '../stripe/stripe-payment.service';
import {
  GetPublicStripePlansUseCase,
  PUBLIC_STRIPE_PLANS_CACHE_KEY,
  PUBLIC_STRIPE_PLANS_CACHE_TTL_SECONDS,
} from './get-public-stripe-plans.use-case';

/** Un plan público ya normalizado por el adaptador de Stripe. */
const PLAN = {
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

/** Lo mismo, recortado a lo que viaja al navegador: sin `productId`. */
const RESPUESTA = {
  priceId: 'price_mensual',
  name: 'Plan Pro',
  description: 'Firma ilimitada',
  unitAmount: 49900,
  currency: 'mxn',
  interval: 'month',
  intervalCount: 1,
  imageUrl: 'https://files.stripe.com/plan-pro.png',
};

describe('GetPublicStripePlansUseCase', () => {
  let useCase: GetPublicStripePlansUseCase;
  let paymentService: { listPublicPlans: jest.Mock };
  let redisService: { get: jest.Mock; set: jest.Mock };

  beforeEach(async () => {
    paymentService = { listPublicPlans: jest.fn().mockResolvedValue([PLAN]) };
    // Redis vacío por defecto: el caso base de cada test es el cache miss.
    redisService = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetPublicStripePlansUseCase,
        { provide: StripePaymentService, useValue: paymentService },
        { provide: RedisService, useValue: redisService },
      ],
    }).compile();

    useCase = module.get(GetPublicStripePlansUseCase);
  });

  describe('cache miss: la primera solicitud', () => {
    it('consulta Stripe y devuelve el catálogo recortado para el frontend', async () => {
      const plans = await useCase.execute();

      expect(redisService.get).toHaveBeenCalledWith(
        PUBLIC_STRIPE_PLANS_CACHE_KEY,
      );
      expect(paymentService.listPublicPlans).toHaveBeenCalledTimes(1);
      expect(plans).toEqual([RESPUESTA]);
      // El `productId` es interno del proveedor: no sale hacia el navegador.
      expect(plans[0]).not.toHaveProperty('productId');
    });

    it('guarda el resultado en Redis con un TTL de 10 minutos', async () => {
      await useCase.execute();

      expect(redisService.set).toHaveBeenCalledWith(
        PUBLIC_STRIPE_PLANS_CACHE_KEY,
        JSON.stringify([RESPUESTA]),
        600,
      );
      expect(PUBLIC_STRIPE_PLANS_CACHE_TTL_SECONDS).toBe(600);
    });

    /** Se cachea ya normalizado: un cache hit no vuelve a mapear nada. */
    it('cachea exactamente lo que respondió', async () => {
      const plans = await useCase.execute();

      const [, cached] = redisService.set.mock.calls[0];
      expect(JSON.parse(cached)).toEqual(plans);
    });
  });

  describe('cache hit: dentro del TTL', () => {
    beforeEach(() => {
      redisService.get.mockResolvedValue(JSON.stringify([RESPUESTA]));
    });

    it('responde desde Redis sin llamar a Stripe', async () => {
      const plans = await useCase.execute();

      expect(plans).toEqual([RESPUESTA]);
      expect(paymentService.listPublicPlans).not.toHaveBeenCalled();
    });

    it('no reescribe la clave: el TTL corre desde que se guardó, no desde la última lectura', async () => {
      await useCase.execute();

      expect(redisService.set).not.toHaveBeenCalled();
    });
  });

  /**
   * Redis no avisa de la expiración: al vencer el TTL la clave simplemente deja de estar, y eso
   * se ve como el `get` devolviendo `null` otra vez.
   */
  it('al expirar el TTL vuelve a consultar Stripe y renueva el caché', async () => {
    redisService.get
      .mockResolvedValueOnce(null) // primera solicitud: caché frío
      .mockResolvedValueOnce(JSON.stringify([RESPUESTA])) // dentro del TTL
      .mockResolvedValueOnce(null); // TTL vencido: la clave ya no está

    await useCase.execute();
    await useCase.execute();
    await useCase.execute();

    expect(paymentService.listPublicPlans).toHaveBeenCalledTimes(2);
    expect(redisService.set).toHaveBeenCalledTimes(2);
    expect(redisService.set).toHaveBeenLastCalledWith(
      PUBLIC_STRIPE_PLANS_CACHE_KEY,
      JSON.stringify([RESPUESTA]),
      600,
    );
  });

  describe('errores', () => {
    /** Criterio "ante un error de Stripe se conserva el manejo de errores actual". */
    it('deja pasar el error del proveedor tal como lo traduce el adaptador', async () => {
      paymentService.listPublicPlans.mockRejectedValue(
        new BadGatewayException(),
      );

      await expect(useCase.execute()).rejects.toBeInstanceOf(
        BadGatewayException,
      );
      expect(redisService.set).not.toHaveBeenCalled();
    });

    /**
     * El caché es una optimización, no la fuente de verdad: una caída de Redis no puede
     * convertirse en una caída del catálogo, que es peor que no tener caché.
     */
    it('si Redis no responde a la lectura, sigue con Stripe', async () => {
      redisService.get.mockRejectedValue(new Error('Redis caído'));

      await expect(useCase.execute()).resolves.toEqual([RESPUESTA]);
      expect(paymentService.listPublicPlans).toHaveBeenCalledTimes(1);
    });

    it('si no puede guardar en Redis, responde igual', async () => {
      redisService.set.mockRejectedValue(new Error('Redis caído'));

      await expect(useCase.execute()).resolves.toEqual([RESPUESTA]);
    });

    /** Claves viejas de un despliegue anterior no deben tumbar la pantalla. */
    it('ignora un caché ilegible y vuelve a Stripe', async () => {
      redisService.get.mockResolvedValue('{no es json');

      await expect(useCase.execute()).resolves.toEqual([RESPUESTA]);
      expect(paymentService.listPublicPlans).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * Un catálogo vacío responde 200 y sin tarjetas: desde afuera se reporta igual que un error,
   * así que queda constancia en el log para poder distinguirlos sin reproducirlo.
   */
  it('avisa en el log cuando Stripe no devuelve ningún plan público', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    paymentService.listPublicPlans.mockResolvedValue([]);

    await expect(useCase.execute()).resolves.toEqual([]);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no devolvió ningún plan público'),
    );
    warn.mockRestore();
  });
});
