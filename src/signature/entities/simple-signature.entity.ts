import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { VerificationCodeEntity } from 'src/document/entities/verification-code.entity';

/**
 * Ubicación de una firma dentro de una página, en ratios 0-1 relativos al tamaño de esa página
 * (ver historia "Ubicación de firmas por usuario"). `signatureId` es el id que generó el
 * cliente al colocarla (o uno generado por el backend si no llegó) — permite identificar cada
 * entrada del arreglo individualmente para editarla/borrarla más adelante.
 */
export interface SignaturePositionRecord {
  signatureId?: string;
  page: number;
  xRatio: number;
  yRatio: number;
  widthRatio: number;
  heightRatio: number;
  opacity?: number;
}

/**
 * Shape previa a la historia "Ubicación de firmas por usuario" (una sola posición, en píxeles
 * absolutos, sin ratios) — solo para leer datos ya persistidos antes de la migración
 * `ArraySignatureCoordinates`, que envuelve estos objetos sueltos en un arreglo de un elemento
 * sin convertirlos a ratios (ver finalizeSignedDocument, que sabe interpretar ambos shapes).
 */
export interface LegacySignatureCoordinates {
  x: number;
  y: number;
  width: number;
  height: number;
  opacity?: number;
  page?: number;
}

/**
 * Coordenadas de firma por colaborador (ver plan de migración ER-V2, Fase 4). Reemplaza el
 * ancla única `Document.signatureCoordinates` + apilado automático por índice: un colaborador
 * puede tener sus propias posiciones explícitas (un arreglo, una por página/zona donde las
 * colocó); si no tiene fila de SimpleSignature asignada (simpleSignatureId null),
 * `finalizeSignedDocument` cae al apilado automático (mismo comportamiento de hoy) como
 * fallback — ver document.service.ts. Un arreglo vacío (`signatureCoordinates: []`) es distinto
 * de "sin fila asignada": significa que el colaborador sí pasó por el flujo de ubicación de
 * firmas pero no colocó ninguna, y no debe estampar nada visualmente al firmar.
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
  signatureCoordinates: (SignaturePositionRecord | LegacySignatureCoordinates)[];
}
