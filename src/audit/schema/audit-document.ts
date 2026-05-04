import { Document } from 'mongoose';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ collection: 'audits', timestamps: true })
export class AuditDocument extends Document {
  @Prop({ required: true })
  documentId: string;

  @Prop({ required: true })
  verificationCodeId: string;

  @Prop({ required: true })
  signedAt: Date;

  @Prop({ required: true })
  chainIndex: number;

  @Prop({ required: true })
  integrityHash: string;
}

export const AuditSchema = SchemaFactory.createForClass(AuditDocument);