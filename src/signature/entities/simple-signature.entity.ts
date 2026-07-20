import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { VerificationCodeEntity } from 'src/document/entities/verification-code.entity';

/**
 * Coordenadas de firma por colaborador (ver plan de migración ER-V2, Fase 4). Reemplaza el
 * ancla única `Document.signatureCoordinates` + apilado automático por índice: un colaborador
 * puede tener su propia posición explícita; si no la tiene, `finalizeSignedDocument` cae al
 * apilado automático (mismo comportamiento de hoy) como fallback — ver document.service.ts.
 *
 * `verificationCode` obtuvo su FK real en la Fase 7, al crearse verification_codes.
 *
 * Vive en el módulo `signature` (no en `document`, ver diagrama ER-V2 más reciente) — el tipo
 * de firma es un concepto del dominio de firmas, aunque su único consumidor hoy siga siendo
 * `CollaboratorEntity`/`document.service.ts` (import cruzado entre módulos, mismo patrón que ya
 * usa `SignatureModule` al registrar `UserEntity`).
 */
@Entity('simple_signatures')
export class SimpleSignatureEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'verification_code', nullable: true })
  verificationCode: string | null;

  @ManyToOne(() => VerificationCodeEntity, { nullable: true })
  @JoinColumn({ name: 'verification_code' })
  verificationCodeEntity: VerificationCodeEntity | null;

  @Column({ name: 'signature_coordinates', type: 'jsonb' })
  signatureCoordinates: {
    x: number;
    y: number;
    width: number;
    height: number;
    opacity?: number;
    page?: number;
  };
}
