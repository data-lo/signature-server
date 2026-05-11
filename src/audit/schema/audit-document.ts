import { Document } from 'mongoose';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

/**
 * Tipos de operación que puede registrar un evento de auditoría.
 * Determina qué campos son obligatorios al crear el registro (ver AuditService.validateOperationFields).
 */
export enum TypeOfOperation {
  CREATE = 'CREATE',   // Creación inicial del documento
  SIGN = 'SIGN',       // Firma del documento por el firmante
  APPROVE = 'APPROVE', // Aprobación por parte del solicitante o sistema
  REJECT = 'REJECT',   // Rechazo del documento
}

@Schema({ collection: 'audits', timestamps: true })
export class AuditDocument extends Document {
  /** ID del documento al que pertenece este evento de auditoría. */
  @Prop({ required: true })
  documentId: string;

  /**
   * ID del código de verificación (OTP) utilizado en la operación.
   * Obligatorio para SIGN, APPROVE y REJECT; no aplica en CREATE.
   */
  @Prop()
  verificationCodeId?: string;

  /** IP desde la que se realizó la operación. Siempre obligatoria. */
  @Prop({ required: true })
  ipAddress: string;

  /**
   * Lista de usuarios involucrados en el evento junto con la acción que realizaron.
   * Permite registrar operaciones con múltiples participantes (ej. firmante + solicitante).
   */
  @Prop({ type: [{ userId: String, action: String }], default: [] })
  users: { userId: string; action: TypeOfOperation }[];

  /** Tipo de operación que originó este registro. */
  @Prop({ required: true, enum: TypeOfOperation })
  operation: TypeOfOperation;

  /** Fecha y hora en que se firmó el documento. Solo aplica para la operación SIGN. */
  @Prop()
  signedAt?: Date;

  /**
   * Contador secuencial de eventos por documento.
   * Se incrementa en 1 con cada nuevo registro del mismo documentId,
   * permitiendo reconstruir el orden cronológico de la cadena de auditoría.
   */
  @Prop({ required: true })
  chainIndex: number;

  /**
   * Hash de la concatenación de todos los campos del documento en el momento del evento.
   * Permite detectar si el documento fue alterado entre dos registros consecutivos.
   * TODO: pendiente de implementación cuando las funciones de hash estén disponibles.
   */
  @Prop()
  integrityHash?: string;

  /**
   * Hash encriptado de los campos del registro de audit.
   * Añade una capa adicional de seguridad sobre el chainHash mediante cifrado.
   * TODO: pendiente de implementación cuando las funciones de hash estén disponibles.
   */
  @Prop()
  cipher?: string;

  /**
   * Hash de la concatenación de todos los campos de este registro de audit.
   * Encadena criptográficamente los registros, haciendo detectable cualquier
   * modificación o eliminación retroactiva en la cadena.
   * TODO: pendiente de implementación cuando las funciones de hash estén disponibles.
   */
  @Prop()
  chainHash?: string;
}

export const AuditSchema = SchemaFactory.createForClass(AuditDocument);
