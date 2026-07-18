import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { VerificationCodeEntity } from './verification-code.entity';

/**
 * Modelo de datos únicamente (ver plan de migración ER-V2, Fase 8) — sin ninguna lógica de
 * firma criptográfica conectada. El diagrama objetivo solo especifica estas 4 columnas; no
 * dice cómo ocurre la firma real (integración con un proveedor certificado de e.firma/PKI
 * mexicano, manejo de llaves, requisitos de retención legal). Esa decisión es de
 * producto/legal, no de ingeniería — ver TODO abajo y el docblock de la migración asociada.
 *
 * TODO(producto/legal): antes de construir cualquier lógica de firma sobre esta tabla, resolver:
 *   1. Qué proveedor de e.firma/PKI se integra (o si el producto maneja las llaves directo).
 *   2. Requisitos de retención legal específicos para documentos firmados con FIEL.
 *   3. Por qué se retiró la UI de e.firma de signature-app en una ronda anterior (ver su
 *      README) antes de asumir que es solo despriorización y no un bloqueo real sin resolver.
 */
@Entity('fiel_signatures')
export class FielSignatureEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  rfc: string;

  @Column({ name: 'verification_code_id', nullable: true })
  verificationCodeId: string | null;

  @ManyToOne(() => VerificationCodeEntity, { nullable: true })
  @JoinColumn({ name: 'verification_code_id' })
  verificationCode: VerificationCodeEntity | null;

  @Column({ name: 'verification_code_required', default: false })
  verificationCodeRequired: boolean;
}
