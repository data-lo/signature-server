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
 * Coordenadas de firma por colaborador, en reemplazo del ancla única
 * `Document.signatureCoordinates` más apilado automático por índice.
 *
 * Un colaborador puede tener sus propias posiciones explícitas —un arreglo, una por página o zona
 * donde las colocó—; sin fila asignada (`simpleSignatureId` null), `finalizeSignedDocument` cae al
 * apilado automático. Un arreglo vacío es distinto de "sin fila asignada": significa que sí pasó por
 * el flujo de ubicación pero no colocó ninguna, y no debe estampar nada visualmente al firmar.
 *
 * Vive en el módulo `signature` y no en `document` porque el tipo de firma es un concepto del
 * dominio de firmas, aunque su único consumidor hoy sea `CollaboratorEntity`/`document.service.ts`.
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
  signatureCoordinates: (
    | SignaturePositionRecord
    | LegacySignatureCoordinates
  )[];
}
