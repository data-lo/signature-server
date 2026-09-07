import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { CreditLotEntity } from './credit-lot.entity';
import { DocumentCreditConsumptionEntity } from './document-credit-consumption.entity';
import { BillingOwnerService } from '../profiles/billing-owner.service';
import { InsufficientDocumentCreditsException } from '../exceptions/billing.exceptions';

export interface ConsumeDocumentCreditInput {
  documentId: string;
  /** Cuenta activa (`X-Account-Id`): decide a QUÉ propietario se le cobra. */
  accountId: string;
  userId: string;
}

/** Lo que cuesta crear un documento. Constante y no parámetro: hoy no hay otra tarifa. */
const CREDITS_PER_DOCUMENT = 1;

/**
 * Gasta un crédito de documento y deja constancia de con cuál se pagó.
 *
 * **Corre dentro de la transacción de quien crea el documento**, y por eso recibe un
 * `EntityManager` en vez de abrir el suyo: si el consumo falla —no hay saldo, la fila del recibo
 * choca contra el índice—, el documento tiene que desaparecer con él. Con transacción propia se
 * podría quedar un documento creado y sin pagar, o un crédito gastado sin documento, que son las
 * dos mitades del mismo error. Sin `manager`, abre una por su cuenta para poder usarse suelto.
 *
 * **Cómo se evita que dos peticiones gasten el último crédito.** No se lee el saldo para después
 * decidir: se descuenta con un `UPDATE ... WHERE remaining > 0`, y es el motor quien resuelve la
 * carrera. La condición se evalúa sobre la fila ya bloqueada por la propia escritura, así que de
 * dos transacciones simultáneas sobre el mismo lote una descuenta y la otra ve `affected: 0` y
 * pasa al lote siguiente. Un `SELECT` previo seguido de un `save` —el orden intuitivo— dejaría a
 * las dos leyendo `remaining: 1` y descontando las dos.
 *
 * **El reintento no cobra dos veces.** Antes de tocar nada se busca el consumo del documento, y
 * si existe se devuelve tal cual. La comprobación no basta por sí sola contra dos peticiones a la
 * vez —las dos podrían no encontrarlo— y por eso el respaldo real es el índice único de
 * `document_id`: la segunda revienta al insertar, dentro de la transacción, sin haber descontado
 * nada que quede escrito.
 */
@Injectable()
export class ConsumeDocumentCreditUseCase {
  private readonly logger = new Logger(ConsumeDocumentCreditUseCase.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly billingOwnerService: BillingOwnerService,
  ) {}

  async execute(
    input: ConsumeDocumentCreditInput,
    manager?: EntityManager,
  ): Promise<DocumentCreditConsumptionEntity> {
    return manager
      ? this.consume(manager, input)
      : this.dataSource.transaction((own) => this.consume(own, input));
  }

  private async consume(
    manager: EntityManager,
    input: ConsumeDocumentCreditInput,
  ): Promise<DocumentCreditConsumptionEntity> {
    const consumptions = manager.getRepository(DocumentCreditConsumptionEntity);

    /**
     * Reintento del mismo documento: se devuelve el consumo que ya existe. Cobrar de nuevo por
     * algo que ya se pagó es peor que fallar, porque nadie lo nota.
     */
    const existing = await consumptions.findOne({
      where: { documentId: input.documentId },
    });

    if (existing) {
      this.logger.log(
        `El documento ${input.documentId} ya había consumido el crédito ${existing.id}; no se descuenta otro.`,
      );
      return existing;
    }

    /**
     * `resolveOwner` comprueba de paso que el usuario pertenezca a la cuenta activa. Sin eso, un
     * `X-Account-Id` ajeno cargaría el documento al saldo de otra organización — que es la forma
     * más barata de gastarle los créditos a alguien.
     */
    const owner = await this.billingOwnerService.resolveOwner(
      input.userId,
      input.accountId,
    );

    const profile = await this.billingOwnerService.findProfileByOwner(owner);

    /**
     * Sin perfil no hay saldo que gastar. Se responde lo mismo que si estuviera agotado: para
     * quien crea el documento las dos situaciones son "no puedes crearlo, consigue documentos",
     * y distinguirlas en el mensaje sólo expondría cómo está montada la facturación por dentro.
     * El detalle que sirve para depurar viaja en `cause`.
     */
    if (!profile) {
      throw new InsufficientDocumentCreditsException();
    }

    const creditLotId = await this.spendOneCredit(manager, profile.id);

    if (!creditLotId) {
      throw new InsufficientDocumentCreditsException(profile.id);
    }

    const consumption = await consumptions.save(
      consumptions.create({
        documentId: input.documentId,
        billingProfileId: profile.id,
        creditLotId,
        creditsConsumed: CREDITS_PER_DOCUMENT,
        consumedAt: new Date(),
      }),
    );

    this.logger.log(
      `El documento ${input.documentId} consumió 1 crédito del lote ${creditLotId} (perfil ${profile.id}).`,
    );

    return consumption;
  }

  /**
   * Descuenta un crédito del primer lote que lo acepte y devuelve cuál fue, o `null` si no queda
   * ninguno.
   *
   * **El orden de gasto es "lo que se pierde antes, primero".** `priority` descendente pone por
   * delante los créditos del periodo facturado (`priority` 100, ver
   * `RegisterSubscriptionBillingUseCase`) frente a los comprados sueltos y a los de bienvenida,
   * que valen igual pero no caducan con el periodo; entre lotes de la misma prioridad manda la
   * caducidad más próxima, y a igualdad de todo, el más viejo. Al revés —gastando primero lo
   * comprado— el cliente perdería al cerrar el mes unos créditos que le sobraban mientras
   * conservaba los que ya había pagado aparte.
   *
   * Se recorren los candidatos en vez de quedarse con el primero porque entre que se leyó la
   * lista y se intenta descontar, otra transacción puede haber vaciado alguno: `affected: 0`
   * significa exactamente eso, y el siguiente lote sigue siendo una respuesta válida.
   */
  private async spendOneCredit(
    manager: EntityManager,
    billingProfileId: string,
  ): Promise<string | null> {
    const candidates = await manager
      .createQueryBuilder(CreditLotEntity, 'lot')
      .select('lot.id', 'id')
      .where('lot.billing_profile_id = :billingProfileId', {
        billingProfileId,
      })
      .andWhere('lot.remaining > 0')
      .andWhere('(lot.expires_at IS NULL OR lot.expires_at > now())')
      .orderBy('lot.priority', 'DESC')
      .addOrderBy('lot.expires_at', 'ASC', 'NULLS LAST')
      .addOrderBy('lot.created_at', 'ASC')
      .getRawMany<{ id: string }>();

    for (const { id } of candidates) {
      const result = await manager
        .createQueryBuilder()
        .update(CreditLotEntity)
        .set({ remaining: () => '"remaining" - 1' })
        /**
         * `remaining > 0` va en el WHERE y no en una comprobación previa: es la condición que
         * convierte el descuento en atómico. Quitarla dejaría el saldo en negativo en cuanto dos
         * peticiones coincidieran — y `CHK_credit_lots_remaining` reventaría en su cara con un
         * error de constraint en vez de con el 409 que corresponde.
         */
        .where('id = :id', { id })
        .andWhere('remaining > 0')
        .execute();

      if (result.affected) {
        return id;
      }
    }

    return null;
  }
}
