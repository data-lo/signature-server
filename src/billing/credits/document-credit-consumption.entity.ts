import { DocumentEntity } from 'src/document/entities/document.entity';
import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { CreditLotEntity } from './credit-lot.entity';
import { BillingProfileEntity } from '../profiles/billing-profile.entity';
import { BILLING_SIGNATURE_TYPE_ENUM } from '../enums/billing-signature-type.enum';

/**
 * El recibo de un documento: qué crédito autorizó su creación y de qué lote salió.
 *
 * **Es la única prueba de que un documento se pagó**, y por eso se escribe en la MISMA
 * transacción que lo crea (ver `ConsumeDocumentCreditUseCase`): un documento sin su fila acá
 * sería uno que existe sin haber gastado nada, y una fila sin documento, un cobro sin objeto.
 *
 * **`document_id` es único, y esa restricción es la idempotencia.** Un reintento del alta —el
 * usuario que vuelve a pulsar, una reconexión, un reenvío del mismo formulario— choca contra el
 * índice en vez de descontar un segundo crédito. No es una precaución teórica: el flujo de
 * creación es largo (subir a MinIO, hashear, contar páginas) y reintentarlo es lo natural cuando
 * algo falla a mitad.
 */
@Entity('document_credit_consumptions')
@Check('CHK_document_credit_consumptions_credits', '"credits_consumed" > 0')
export class DocumentCreditConsumptionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'document_id', unique: true })
  documentId: string;

  /**
   * `ON DELETE RESTRICT`: borrar un documento con crédito consumido queda bloqueado por el motor.
   * Devolver el crédito es una decisión de negocio que todavía no se ha tomado (está fuera del
   * alcance de esta historia), y hasta que exista, dejar desaparecer el documento borraría la
   * única constancia de que ese crédito se gastó.
   */
  @OneToOne(() => DocumentEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'document_id' })
  document: DocumentEntity;

  /**
   * A quién se le cobró.
   *
   * **Es redundante con `credit_lot.billing_profile_id` a propósito.** Se guarda acá para poder
   * responder "cuánto consumió esta cuenta" sin pasar por los lotes, que es la consulta que hace
   * facturación y la que alimentará cualquier corte por cuenta. La redundancia es segura porque
   * el caso de uso escribe los dos del mismo propietario resuelto, en la misma transacción.
   */
  @Column({ name: 'billing_profile_id' })
  billingProfileId: string;

  @ManyToOne(() => BillingProfileEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'billing_profile_id' })
  billingProfile: BillingProfileEntity;

  @Column({ name: 'credit_lot_id' })
  creditLotId: string;

  @ManyToOne(() => CreditLotEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'credit_lot_id' })
  creditLot: CreditLotEntity;

  /**
   * Cuántos documentos gastó. Hoy siempre `1` —crear un documento cuesta uno— pero la columna
   * admite más: el `CHECK` es `> 0` y no `= 1` porque ya se contemplan consumos de varios
   * créditos (una firma por lotes, un documento que exija biometría) y volver a `= 1` cada vez
   * obligaría a migrar la restricción para poder escribir un `2`.
   */
  @Column({ name: 'credits_consumed', type: 'integer', default: 1 })
  creditsConsumed: number;

  /**
   * Con qué tipo de firma se creó el documento, cuando se sabe.
   *
   * Nullable: el consumo se resuelve con `{documentId, accountId, userId}` y no necesita conocer
   * el tipo de firma para descontar un crédito. Exigirlo obligaría al llamador a cargar el
   * documento sólo para llenar un campo que hoy nadie consulta — y a inventarse un valor en los
   * consumos que no vienen de una firma.
   */
  @Column({
    name: 'signature_type',
    type: 'enum',
    enum: BILLING_SIGNATURE_TYPE_ENUM,
    nullable: true,
  })
  signatureType: BILLING_SIGNATURE_TYPE_ENUM | null;

  /**
   * Cuándo se gastó el crédito, que es lo que cuenta para facturación.
   *
   * Se separa de `created_at` por el mismo motivo que en el historial de cobros: hoy coinciden
   * —el consumo se escribe en el acto— pero un ajuste registrado a mano, o una migración de
   * consumos, tendrían `consumed_at` en el pasado y `created_at` en el momento de capturarlos.
   * Confundirlos falsearía cualquier corte por fecha.
   */
  @Column({
    name: 'consumed_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  consumedAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  /**
   * Cuándo se devolvió el crédito, si se devolvió.
   *
   * **Nadie lo escribe todavía**: la devolución por cancelación o borrado es una regla que se
   * definirá en otra historia, y ésta la deja explícitamente fuera. La columna sobrevive porque
   * ya existe y porque quitarla obligaría a volver a agregarla; mientras tanto, `null` significa
   * "consumo vigente", que es lo que son todos.
   */
  @Column({ name: 'reversed_at', type: 'timestamptz', nullable: true })
  reversedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  reason: string | null;
}
