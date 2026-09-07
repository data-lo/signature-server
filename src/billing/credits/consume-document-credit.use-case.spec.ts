import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { ConsumeDocumentCreditUseCase } from './consume-document-credit.use-case';
import { CreditLotEntity } from './credit-lot.entity';
import { DocumentCreditConsumptionEntity } from './document-credit-consumption.entity';
import { BillingOwnerService } from '../profiles/billing-owner.service';
import { InsufficientDocumentCreditsException } from '../exceptions/billing.exceptions';

const PERSONAL_OWNER = {
  personalAccountId: 'account-1',
  organizationId: null,
};
const ORGANIZATION_OWNER = {
  personalAccountId: null,
  organizationId: 'org-1',
};

/**
 * Lotes en memoria con la MISMA regla de carrera que Postgres: el descuento sólo prospera si la
 * fila todavía tiene saldo, y el `affected` que devuelve es lo que el caso de uso interpreta.
 *
 * Sin esta parte del doble, la prueba de concurrencia no probaría nada: dos llamadas seguidas
 * sobre un mock que siempre responde `affected: 1` pasarían aunque el código leyera el saldo y
 * decidiera después, que es justo el error que se quiere impedir.
 */
function createManager(lots: { id: string; remaining: number }[]) {
  const consumptions: Record<string, unknown>[] = [];

  const consumptionRepository = {
    findOne: jest.fn(
      async ({ where }: { where: { documentId: string } }) =>
        consumptions.find((row) => row.documentId === where.documentId) ?? null,
    ),
    create: jest.fn((data: Record<string, unknown>) => ({ ...data })),
    save: jest.fn(async (data: Record<string, unknown>) => {
      const saved = { id: `consumo-${consumptions.length + 1}`, ...data };
      consumptions.push(saved);
      return saved;
    }),
  };

  /** El `SELECT` de candidatos, con el orden ya aplicado por el caso de uso. */
  const selectBuilder = {
    select: jest.fn(() => selectBuilder),
    where: jest.fn(() => selectBuilder),
    andWhere: jest.fn(() => selectBuilder),
    orderBy: jest.fn(() => selectBuilder),
    addOrderBy: jest.fn(() => selectBuilder),
    getRawMany: jest.fn(async () =>
      lots.filter((lot) => lot.remaining > 0).map(({ id }) => ({ id })),
    ),
  };

  const updateCalls: string[] = [];
  const updateBuilder = {
    update: jest.fn(() => updateBuilder),
    set: jest.fn(() => updateBuilder),
    where: jest.fn((_sql: string, params: { id: string }) => {
      updateBuilder.targetId = params.id;
      return updateBuilder;
    }),
    andWhere: jest.fn(() => updateBuilder),
    execute: jest.fn(async () => {
      const id = updateBuilder.targetId as string;
      updateCalls.push(id);
      const lot = lots.find((candidate) => candidate.id === id);

      // La condición `remaining > 0` del WHERE, que es lo que hace atómico el descuento.
      if (!lot || lot.remaining <= 0) {
        return { affected: 0 };
      }

      lot.remaining -= 1;
      return { affected: 1 };
    }),
    targetId: '' as string,
  };

  return {
    lots,
    consumptions,
    updateCalls,
    consumptionRepository,
    selectBuilder,
    manager: {
      getRepository: jest.fn(() => consumptionRepository),
      createQueryBuilder: jest.fn((...args: unknown[]) =>
        args.length > 0 ? selectBuilder : updateBuilder,
      ),
    },
  };
}

describe('ConsumeDocumentCreditUseCase', () => {
  let useCase: ConsumeDocumentCreditUseCase;
  let billingOwnerService: {
    resolveOwner: jest.Mock;
    findProfileByOwner: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };
  let doble: ReturnType<typeof createManager>;

  const buildUseCase = async (
    lots: { id: string; remaining: number }[] = [
      { id: 'lote-1', remaining: 3 },
    ],
  ) => {
    doble = createManager(lots);
    dataSource = {
      transaction: jest.fn(async (cb: (manager: unknown) => Promise<unknown>) =>
        cb(doble.manager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConsumeDocumentCreditUseCase,
        { provide: DataSource, useValue: dataSource },
        { provide: BillingOwnerService, useValue: billingOwnerService },
      ],
    }).compile();

    useCase = module.get(ConsumeDocumentCreditUseCase);
  };

  beforeEach(async () => {
    billingOwnerService = {
      resolveOwner: jest.fn().mockResolvedValue(PERSONAL_OWNER),
      findProfileByOwner: jest.fn().mockResolvedValue({ id: 'perfil-1' }),
    };
    await buildUseCase();
  });

  const consume = (documentId = 'documento-1') =>
    useCase.execute({
      documentId,
      accountId: 'account-1',
      userId: 'user-1',
    });

  describe('consumo exitoso', () => {
    it('descuenta un crédito del lote y deja el recibo del documento', async () => {
      const consumption = await consume();

      expect(doble.lots[0].remaining).toBe(2);
      expect(consumption).toMatchObject({
        documentId: 'documento-1',
        billingProfileId: 'perfil-1',
        creditLotId: 'lote-1',
        creditsConsumed: 1,
      });
    });

    it('registra el momento del consumo', async () => {
      const consumption = await consume();

      expect(consumption.consumedAt).toBeInstanceOf(Date);
    });

    /** Un documento cuesta exactamente uno: ni cero (sería gratis) ni dos. */
    it('gasta exactamente un crédito por documento', async () => {
      await consume('documento-1');
      await consume('documento-2');

      expect(doble.lots[0].remaining).toBe(1);
      expect(doble.consumptions).toHaveLength(2);
    });
  });

  describe('a quién se le cobra', () => {
    /**
     * `resolveOwner` comprueba de paso la membresía: sin eso, un `X-Account-Id` ajeno cargaría el
     * documento al saldo de otra organización.
     */
    it('resuelve el propietario a partir del usuario y la cuenta activa', async () => {
      await consume();

      expect(billingOwnerService.resolveOwner).toHaveBeenCalledWith(
        'user-1',
        'account-1',
      );
    });

    it('cobra al perfil de la organización cuando la cuenta activa es una organización', async () => {
      billingOwnerService.resolveOwner.mockResolvedValue(ORGANIZATION_OWNER);
      billingOwnerService.findProfileByOwner.mockResolvedValue({
        id: 'perfil-org',
      });

      const consumption = await consume();

      expect(billingOwnerService.findProfileByOwner).toHaveBeenCalledWith(
        ORGANIZATION_OWNER,
      );
      expect(consumption.billingProfileId).toBe('perfil-org');
    });

    it('propaga el 403 de una cuenta que no es del usuario, sin gastar nada', async () => {
      billingOwnerService.resolveOwner.mockRejectedValue(
        new ForbiddenException('No perteneces a esta cuenta'),
      );

      await expect(consume()).rejects.toThrow(ForbiddenException);
      expect(doble.lots[0].remaining).toBe(3);
      expect(doble.consumptions).toHaveLength(0);
    });
  });

  describe('sin créditos disponibles', () => {
    it('rechaza con 409 cuando todos los lotes están agotados', async () => {
      await buildUseCase([{ id: 'lote-vacio', remaining: 0 }]);

      await expect(consume()).rejects.toThrow(
        InsufficientDocumentCreditsException,
      );
      expect(doble.consumptions).toHaveLength(0);
    });

    it('rechaza con 409 cuando el propietario no tiene ningún lote', async () => {
      await buildUseCase([]);

      await expect(consume()).rejects.toThrow(
        InsufficientDocumentCreditsException,
      );
    });

    /**
     * Sin perfil no hay saldo, y se responde lo mismo que si estuviera agotado: para quien crea
     * el documento las dos situaciones son "consigue documentos".
     */
    it('rechaza con 409 cuando la cuenta no tiene perfil de facturación', async () => {
      billingOwnerService.findProfileByOwner.mockResolvedValue(null);

      await expect(consume()).rejects.toThrow(
        InsufficientDocumentCreditsException,
      );
    });

    it('el mensaje ofrece las dos salidas: comprar documentos o contratar', async () => {
      await buildUseCase([]);

      await expect(consume()).rejects.toThrow(
        'No tienes créditos de documentos disponibles. Compra documentos adicionales o contrata un plan.',
      );
    });
  });

  describe('plan Free', () => {
    /**
     * El recorrido completo de una cuenta nueva: su lote de bienvenida da para tres documentos y
     * el cuarto se rechaza. Es la regla que hace que el plan gratuito no sea ilimitado.
     */
    it('los 3 créditos de bienvenida alcanzan para 3 documentos, y el cuarto se rechaza', async () => {
      await buildUseCase([{ id: 'lote-bienvenida', remaining: 3 }]);

      await consume('documento-1');
      await consume('documento-2');
      await consume('documento-3');

      expect(doble.lots[0].remaining).toBe(0);
      expect(doble.consumptions).toHaveLength(3);

      await expect(consume('documento-4')).rejects.toThrow(
        InsufficientDocumentCreditsException,
      );
      expect(doble.consumptions).toHaveLength(3);
    });
  });

  describe('reintento del mismo documento', () => {
    /**
     * El flujo de creación es largo (MinIO, hash, páginas) y reintentarlo es lo natural cuando
     * algo falla a mitad. Cobrar dos veces por el mismo documento es peor que fallar, porque
     * nadie lo nota.
     */
    it('devuelve el consumo existente sin descontar un segundo crédito', async () => {
      const primero = await consume('documento-1');
      expect(doble.lots[0].remaining).toBe(2);

      const segundo = await consume('documento-1');

      expect(segundo).toBe(primero);
      expect(doble.lots[0].remaining).toBe(2);
      expect(doble.consumptions).toHaveLength(1);
    });

    /** Ni siquiera resuelve al propietario: sale antes de tocar nada. */
    it('no vuelve a resolver ni a tocar los lotes en el reintento', async () => {
      await consume('documento-1');
      billingOwnerService.resolveOwner.mockClear();
      doble.updateCalls.length = 0;

      await consume('documento-1');

      expect(billingOwnerService.resolveOwner).not.toHaveBeenCalled();
      expect(doble.updateCalls).toHaveLength(0);
    });
  });

  describe('concurrencia', () => {
    /**
     * El caso que motiva el descuento condicional: dos peticiones sobre el ÚLTIMO crédito. El
     * doble replica la regla de Postgres —el `UPDATE` sólo prospera con `remaining > 0`—, así que
     * la segunda ve `affected: 0`, se queda sin lotes y recibe su 409. Con un `SELECT` previo y
     * un `save`, las dos habrían leído `remaining: 1` y descontado las dos.
     */
    it('dos documentos no pueden gastar el mismo último crédito', async () => {
      await buildUseCase([{ id: 'ultimo', remaining: 1 }]);

      const primero = await consume('documento-1');
      const segundo = await consume('documento-2').catch(
        (error: Error) => error,
      );

      expect(primero.creditLotId).toBe('ultimo');
      expect(segundo).toBeInstanceOf(InsufficientDocumentCreditsException);
      expect(doble.lots[0].remaining).toBe(0);
      expect(doble.consumptions).toHaveLength(1);
    });

    /**
     * Que otro haya vaciado un lote entre la lectura y el descuento no es un error: el candidato
     * siguiente sigue siendo una respuesta válida, y por eso se recorren en vez de quedarse con
     * el primero.
     */
    it('pasa al lote siguiente cuando el primero se vació entre la lectura y el descuento', async () => {
      await buildUseCase([
        { id: 'lote-vaciado', remaining: 1 },
        { id: 'lote-con-saldo', remaining: 5 },
      ]);

      /**
       * La carrera exacta: el lote entra en la lista de candidatos con saldo y otra transacción
       * se lo lleva ANTES de que este caso de uso llegue a descontarlo. Vaciarlo antes de la
       * consulta no probaría nada — saldría filtrado y nunca se intentaría.
       */
      doble.selectBuilder.getRawMany.mockImplementationOnce(async () => {
        const candidatos = doble.lots.map(({ id }) => ({ id }));
        doble.lots[0].remaining = 0;
        return candidatos;
      });

      const consumption = await consume();

      expect(doble.updateCalls).toEqual(['lote-vaciado', 'lote-con-saldo']);
      expect(consumption.creditLotId).toBe('lote-con-saldo');
      expect(doble.lots[1].remaining).toBe(4);
    });
  });

  describe('transacción', () => {
    /**
     * Con `manager` no abre transacción propia: el consumo tiene que vivir o morir con la del
     * documento. Si abriera la suya, un fallo posterior del alta dejaría el crédito gastado y el
     * documento inexistente.
     */
    it('usa el manager del llamador sin abrir otra transacción', async () => {
      await useCase.execute(
        { documentId: 'documento-1', accountId: 'account-1', userId: 'user-1' },
        doble.manager as never,
      );

      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(doble.consumptions).toHaveLength(1);
    });

    /** Sin `manager` sí abre la suya, para poder usarse suelto. */
    it('abre su propia transacción cuando no recibe manager', async () => {
      await consume();

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    /**
     * Lo que garantiza la reversión: el fallo SALE del caso de uso en vez de tragarse. Quien lo
     * llama dentro de una transacción la ve fallar y el documento se deshace con ella.
     */
    it('deja escapar el fallo para que el llamador revierta', async () => {
      await buildUseCase([]);

      await expect(
        useCase.execute(
          {
            documentId: 'documento-1',
            accountId: 'account-1',
            userId: 'user-1',
          },
          doble.manager as never,
        ),
      ).rejects.toThrow(InsufficientDocumentCreditsException);
    });
  });

  describe('orden de gasto', () => {
    /**
     * Se gasta primero lo que antes se pierde: prioridad descendente (los créditos del periodo
     * facturado van por delante de los comprados y de los de bienvenida), luego la caducidad más
     * próxima y, a igualdad, el lote más viejo.
     */
    it('pide los lotes con saldo, sin caducar, en el orden de la política de gasto', async () => {
      await consume();

      const builder = doble.manager.createQueryBuilder.mock.results[0]
        .value as Record<string, jest.Mock>;

      expect(builder.andWhere).toHaveBeenCalledWith('lot.remaining > 0');
      expect(builder.andWhere).toHaveBeenCalledWith(
        '(lot.expires_at IS NULL OR lot.expires_at > now())',
      );
      expect(builder.orderBy).toHaveBeenCalledWith('lot.priority', 'DESC');
      expect(builder.addOrderBy).toHaveBeenCalledWith(
        'lot.expires_at',
        'ASC',
        'NULLS LAST',
      );
      expect(builder.addOrderBy).toHaveBeenCalledWith('lot.created_at', 'ASC');
    });

    it('consulta los lotes del perfil resuelto, no de la cuenta', async () => {
      await consume();

      const builder = doble.manager.createQueryBuilder.mock.results[0]
        .value as Record<string, jest.Mock>;

      expect(builder.where).toHaveBeenCalledWith(
        'lot.billing_profile_id = :billingProfileId',
        { billingProfileId: 'perfil-1' },
      );
    });
  });

  it('pide el repositorio de consumos al manager de la transacción', async () => {
    await consume();

    expect(doble.manager.getRepository).toHaveBeenCalledWith(
      DocumentCreditConsumptionEntity,
    );
    expect(doble.manager.createQueryBuilder).toHaveBeenCalledWith(
      CreditLotEntity,
      'lot',
    );
  });
});
