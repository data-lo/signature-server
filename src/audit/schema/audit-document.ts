import { Document } from 'mongoose';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

export enum AuditAction {
  DOCUMENT_CREATED = 'DOCUMENT_CREATED',
  DOCUMENT_SENT_TO_SIGN = 'DOCUMENT_SENT_TO_SIGN',
  DOCUMENT_SIGNED = 'DOCUMENT_SIGNED',
  DOCUMENT_CANCELLED = 'DOCUMENT_CANCELLED',
  DOCUMENT_REJECTED = 'DOCUMENT_REJECTED',
}

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
