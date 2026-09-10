import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { CreditLotEntity } from './credit-lot.entity';
import { DocumentCreditConsumptionEntity } from './document-credit-consumption.entity';
import { BillingOwnerService } from '../profiles/billing-owner.service';
import { InsufficientDocumentCreditsException } from '../exceptions/billing.exceptions';
import { BILLING_SIGNATURE_TYPE_ENUM } from '../enums/billing-signature-type.enum';

export interface ConsumeDocumentCreditInput {
  /** Documento que se cobra. Es la llave de idempotencia: `document_id` es único en el recibo. */
  documentId: string;
  /** Cuenta activa (`X-Account-Id`): decide a QUÉ propietario se le cobra. */
  accountId: string;
  userId: string;
  /**
   * Con qué tipo de firma se creó el documento, en vocabulario comercial.
   *
   * Lo manda quien crea el documento leyéndolo de `documents.signature_type`, nunca del payload
   * del cliente: un cliente que mintiera aquí falsearía la facturación sin tocar el documento.
   *
   * Opcional porque no todo documento tiene tipo de firma; sin él el crédito se descuenta igual y
   * el recibo queda en `null`. Cobrar es lo que no puede fallar.
   */
  signatureType?: BILLING_SIGNATURE_TYPE_ENUM | null;
}

/** Lo que cuesta crear un documento. Constante y no parámetro: hoy no hay otra tarifa. */
const CREDITS_PER_DOCUMENT = 1;

/**
 * Gasta un crédito de documento y deja constancia de con cuál se pagó.
 *
 * @remarks
 * Flujo:
 *
 * 1. Busca el consumo del documento. Si existe, lo devuelve sin descontar nada.
 * 2. Resuelve el propietario facturable, comprobando de paso que el usuario pertenezca a la
 *    cuenta activa.
 * 3. Obtiene su `billing_profile`; sin perfil no hay saldo que gastar.
 * 4. Descuenta un crédito del primer lote utilizable (ver `spendOneCredit`).
 * 5. Escribe la fila de `document_credit_consumptions` con el lote, el perfil y el tipo de firma.
 *
 * **Corre dentro de la transacción de quien crea el documento**, y por eso recibe un
 * `EntityManager` en vez de abrir el suyo: si el consumo falla, el documento tiene que
 * desaparecer con él. Con transacción propia podría quedar un documento creado y sin pagar, o un
 * crédito gastado sin documento, que son las dos mitades del mismo error. Sin `manager`, abre una
 * por su cuenta para poder usarse suelto.
 *
 * **Doble consumo.** La comprobación del paso 1 no basta contra dos peticiones simultáneas —las
 * dos podrían no encontrar nada—, así que el respaldo real es el índice único de `document_id`:
 * la segunda revienta al insertar, dentro de la transacción, sin dejar nada descontado.
 *
 * **Carrera por el último crédito.** El descuento del paso 4 no lee el saldo para después
 * decidir: va como `UPDATE ... WHERE remaining > 0` y es el motor quien resuelve la carrera sobre
 * la fila que la propia escritura bloquea. Un `SELECT` previo seguido de un `save` dejaría a dos
 * transacciones leyendo `remaining: 1` y descontando las dos.
 */
@Injectable()
export class ConsumeDocumentCreditUseCase {
  private readonly logger = new Logger(ConsumeDocumentCreditUseCase.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly billingOwnerService: BillingOwnerService,
  ) {}

  /**
   * Ejecuta el caso de uso.
   *
   * @param input Documento a cobrar, cuenta activa y usuario que lo crea; opcionalmente el tipo
   *   de firma, que se anota en el recibo.
   * @param manager Transacción de quien crea el documento. Sin él abre una propia, y entonces el
   *   consumo queda confirmado aunque el documento se deshaga después.
   * @returns El consumo escrito, o el que ya existía para ese documento.
   * @throws {InsufficientDocumentCreditsException} Cuando la cuenta no tiene perfil de
   *   facturación o ningún lote con saldo utilizable. Es la misma respuesta en los dos casos:
   *   para quien crea el documento significan lo mismo, y distinguirlas expondría cómo está
   *   montada la facturación por dentro.
   * @throws {ForbiddenException} Cuando el usuario no pertenece a la cuenta activa.
   */
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

    // Al recibo existente no se le reescribe nada: es constancia de un cobro ya consumado.
    const existing = await consumptions.findOne({
      where: { documentId: input.documentId },
    });

    if (existing) {
      this.logger.log(
        `El documento ${input.documentId} ya había consumido el crédito ${existing.id}; no se descuenta otro.`,
      );
      return existing;
    }

    // Sin la comprobación de membresía, un `X-Account-Id` ajeno cobraría a otra organización.
    const owner = await this.billingOwnerService.resolveOwner(
      input.userId,
      input.accountId,
    );

    const profile = await this.billingOwnerService.findProfileByOwner(owner);

    // El detalle que sirve para depurar viaja en `cause`, no en el mensaje al usuario.
    if (!profile) {
      throw new InsufficientDocumentCreditsException(
        CREDITS_PER_DOCUMENT,
        0,
        'La cuenta activa no tiene perfil de facturación, así que tampoco lotes de crédito.',
      );
    }

    const creditLotId = await this.spendOneCredit(manager, profile.id);

    if (!creditLotId) {
      throw new InsufficientDocumentCreditsException(
        CREDITS_PER_DOCUMENT,
        0,
        `Sin credit_lots con saldo utilizable para el perfil ${profile.id}.`,
      );
    }

    const consumption = await consumptions.save(
      consumptions.create({
        documentId: input.documentId,
        billingProfileId: profile.id,
        creditLotId,
        creditsConsumed: CREDITS_PER_DOCUMENT,
        // `null` significa "no se decidió"; traducirlo a SIMPLE falsearía el corte de facturación.
        signatureType: input.signatureType ?? null,
        consumedAt: new Date(),
      }),
    );

    this.logger.log(
      `El documento ${input.documentId} consumió 1 crédito del lote ${creditLotId} (perfil ${profile.id}).`,
    );

    return consumption;
  }

  /**
   * Descuenta un crédito del primer lote que lo acepte.
   *
   * @remarks
   * El orden de gasto es "lo que se pierde antes, primero": `priority` descendente pone por
   * delante los créditos del periodo facturado (100, ver `RegisterSubscriptionBillingUseCase`)
   * frente a los comprados sueltos y a los de bienvenida, que no caducan con el periodo; a
   * igualdad de prioridad manda la caducidad más próxima y después el lote más viejo. Al revés,
   * el cliente perdería al cerrar el mes los créditos que le sobraban mientras conservaba los que
   * había pagado aparte.
   *
   * @param manager Transacción en curso.
   * @param billingProfileId Perfil cuyo saldo se gasta.
   * @returns El lote del que se descontó, o `null` si ninguno aceptó el descuento.
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

    // Otra transacción pudo vaciar un candidato entre la lista y el UPDATE: se prueba el siguiente.
    for (const { id } of candidates) {
      const result = await manager
        .createQueryBuilder()
        .update(CreditLotEntity)
        .set({ remaining: () => '"remaining" - 1' })
        // `remaining > 0` en el WHERE es lo que hace atómico el descuento.
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
