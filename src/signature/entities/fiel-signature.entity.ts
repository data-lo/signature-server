import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { VerificationCodeEntity } from 'src/document/entities/verification-code.entity';

/**
 * Modelo de datos únicamente, sin lógica de firma criptográfica conectada: el diagrama objetivo sólo
 * especifica estas cuatro columnas y no dice cómo ocurre la firma real —integración con un proveedor
 * certificado de e.firma/PKI mexicano, manejo de llaves, retención legal—, que es una decisión de
 * producto y legal.
 *
 * Vive en el módulo `signature` y no en `document`, mismo criterio que `SimpleSignatureEntity`.
 *
 * TODO(producto/legal): antes de construir cualquier lógica de firma sobre esta tabla, resolver:
 *   1. Qué proveedor de e.firma/PKI se integra, o si el producto maneja las llaves directo.
 *   2. Requisitos de retención legal específicos para documentos firmados con FIEL.
 *   3. Por qué se retiró la UI de e.firma de signature-app en una ronda anterior (ver su README),
 *      antes de asumir que es sólo despriorización y no un bloqueo real sin resolver.
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
