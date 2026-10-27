import { Document } from 'mongoose';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

export enum AuditAction {
  DOCUMENT_CREATED = 'DOCUMENT_CREATED',
  /** El reviewer autorizó que el documento salga a firma. */
  DOCUMENT_APPROVED = 'DOCUMENT_APPROVED',
  /** El reviewer negó la autorización: el flujo de firma no llega a empezar. */
  DOCUMENT_APPROVAL_REJECTED = 'DOCUMENT_APPROVAL_REJECTED',
  DOCUMENT_SENT_TO_SIGN = 'DOCUMENT_SENT_TO_SIGN',
  DOCUMENT_SIGNED = 'DOCUMENT_SIGNED',
  DOCUMENT_CANCELLATION_REQUESTED = 'DOCUMENT_CANCELLATION_REQUESTED',
  DOCUMENT_CANCELLED = 'DOCUMENT_CANCELLED',
  DOCUMENT_REJECTED = 'DOCUMENT_REJECTED',
  /** Se envió el código de una invitación individual (`/sign/:token`) al correo del firmante. */
  SIGNING_INVITATION_OTP_SENT = 'SIGNING_INVITATION_OTP_SENT',
  /** Intento de validar ese código: `result` dice si abrió una sesión pública o falló. */
  SIGNING_INVITATION_OTP_VERIFIED = 'SIGNING_INVITATION_OTP_VERIFIED',
  /** Se emitió una invitación nueva: reenvío por integración o renovación de un enlace vencido. */
  SIGNING_INVITATION_ISSUED = 'SIGNING_INVITATION_ISSUED',
}

/** Mecanismo con el que se autenticó quien hizo la operación. */
export enum AUDIT_AUTH_MECHANISM_ENUM {
  /** Sesión de la plataforma (JWT). */
  JWT = 'JWT',
  /** API key de organización (`X-API-Key`). */
  API_KEY = 'API_KEY',
  /** Token de invitación (`/sign/:token`), antes de validar el código. */
  INVITATION_TOKEN = 'INVITATION_TOKEN',
  /** Sesión pública de firma, abierta al validar el código del correo. */
  PUBLIC_SIGNING_SESSION = 'PUBLIC_SIGNING_SESSION',
}

/**
 * Contexto del actor de una operación auditada. Nunca lleva tokens, códigos ni secretos: sólo
 * identificadores y el user-agent.
 */
export interface AuditActorContext {
  /** `AUTHENTICATED_ACCOUNT`, `PUBLIC_INVITATION` o `INTEGRATION_API_CLIENT`. */
  type: string;
  authMechanism: AUDIT_AUTH_MECHANISM_ENUM;
  apiKeyId?: string;
  invitationId?: string;
  collaboratorId?: string;
  userAgent?: string;
}

/**
 * Sub-esquema de `AuditDocument.actor`. Va como clase propia y no como objeto literal en `@Prop`:
 * en un literal, Mongoose lee la clave `type` del actor como la declaración del tipo del campo y
 * descarta el resto (mecanismo, `apiKeyId`, invitación, colaborador y user-agent).
 */
@Schema({ _id: false })
class AuditActorRecord {
  @Prop({ type: String, required: true })
  type: string;

  @Prop({ type: String, required: true })
  authMechanism: AUDIT_AUTH_MECHANISM_ENUM;

  @Prop({ type: String })
  apiKeyId?: string;

  @Prop({ type: String })
  invitationId?: string;

  @Prop({ type: String })
  collaboratorId?: string;

  @Prop({ type: String })
  userAgent?: string;
}

const AuditActorSchema = SchemaFactory.createForClass(AuditActorRecord);

@Schema({ collection: 'audits', timestamps: true })
export class AuditDocument extends Document {
  @Prop({ required: true })
  documentId: string;

  @Prop()
  verificationCodeId?: string;

  @Prop({ required: true })
  ipAddress: string;

  @Prop({ type: [{ userId: String, action: String }], default: [] })
  users: { userId: string; action: AuditAction }[];

  @Prop({ required: true, enum: AuditAction })
  operation: AuditAction;

  @Prop()
  signedAt?: Date;

  /** Evidencia de ubicación declarada por el dispositivo del firmante al momento de firmar. */
  @Prop({
    type: { latitude: Number, longitude: Number, accuracy: Number },
    _id: false,
  })
  geolocation?: { latitude: number; longitude: number; accuracy?: number };

  /** Tipo de firma con el que firmó (`SIMPLE`, `FIEL`, `BIOMETRIC`). Sólo en `DOCUMENT_SIGNED`. */
  @Prop()
  signatureType?: string;

  /**
   * Método con el que el firmante acreditó su identidad: `ACCOUNT_SESSION` (sesión en su cuenta) o
   * `GUEST_EMAIL_OTP` (invitado sin cuenta, con código al correo). Sólo en `DOCUMENT_SIGNED`.
   */
  @Prop()
  signingAuthorization?: string;

  /** Quién hizo la operación y con qué mecanismo (ver `AuditActorContext`). */
  @Prop({ type: AuditActorSchema })
  actor?: AuditActorContext;

  /** `SUCCESS` o `FAILURE`; sólo en las operaciones que pueden fallar después de intentarse. */
  @Prop()
  result?: string;

  @Prop({ required: true })
  chainIndex: number;

  @Prop()
  integrityHash?: string;

  @Prop()
  cipher?: string;

  @Prop()
  chainHash?: string;
}

export const AuditSchema = SchemaFactory.createForClass(AuditDocument);
