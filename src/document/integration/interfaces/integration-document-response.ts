import { ApiProperty } from '@nestjs/swagger';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { DOCUMENT_STATUS_ENUM } from '../../enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from '../../enum/signature-type.enum';

/**
 * Un documento visto desde la API de integración: sin colaboradores, sin creador, sin URL del
 * archivo. Sólo lo necesario para que el sistema externo siga el estado del documento.
 */
export class IntegrationDocumentData {
  @ApiProperty({
    format: 'uuid',
    example: '7d1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b',
  })
  id: string;

  @ApiProperty({ example: 'contrato.pdf' })
  fileName: string;

  @ApiProperty({
    enum: DOCUMENT_STATUS_ENUM,
    example: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
  })
  status: DOCUMENT_STATUS_ENUM;

  @ApiProperty({
    enum: SIGNATURE_TYPE_ENUM,
    nullable: true,
    example: SIGNATURE_TYPE_ENUM.SIMPLE,
    description:
      '`FIEL` es la firma avanzada; `null` en documentos antiguos sin un tipo único',
  })
  signatureType: SIGNATURE_TYPE_ENUM | null;

  @ApiProperty({ example: '2026-10-26T12:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({
    nullable: true,
    type: Date,
    example: null,
    description:
      'Momento en que la última firma cerró el documento; `null` mientras tanto',
  })
  signedAt: Date | null;
}

export class IntegrationDocumentsPagination {
  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({
    example: 25,
    description: 'Tamaño de página aplicado (máximo 100)',
  })
  limit: number;

  @ApiProperty({ example: 42 })
  total: number;

  @ApiProperty({ example: 2 })
  totalPages: number;
}

export class IntegrationDocumentsPage {
  @ApiProperty({ type: [IntegrationDocumentData] })
  items: IntegrationDocumentData[];

  @ApiProperty({ type: IntegrationDocumentsPagination })
  pagination: IntegrationDocumentsPagination;
}

export class IntegrationDocumentsPageResponse extends BaseResponse<IntegrationDocumentsPage> {
  @ApiProperty({ type: IntegrationDocumentsPage })
  data: IntegrationDocumentsPage;
}

/** Creador del documento, tal como se identificó en el payload. */
export class IntegrationDocumentCreatorData {
  @ApiProperty({ example: 'ana@cliente.com' })
  email: string;
}

/** Un firmante del documento creado. Sin ids internos ni URLs de firma. */
export class IntegrationDocumentParticipantData {
  @ApiProperty({ example: 'ana@correo.com' })
  email: string;

  @ApiProperty({
    enum: ['PENDING', 'WAITING_FOR_PREVIOUS_SIGNER', 'SIGNED', 'REJECTED'],
    example: 'PENDING',
    description:
      '`PENDING` si puede firmar ya; `WAITING_FOR_PREVIOUS_SIGNER` si el documento es secuencial y falta la firma de un firmante anterior',
  })
  status: string;

  @ApiProperty({
    enum: SIGNATURE_TYPE_ENUM,
    nullable: true,
    example: SIGNATURE_TYPE_ENUM.SIMPLE,
  })
  signatureType: SIGNATURE_TYPE_ENUM | null;

  @ApiProperty({ example: 1, description: 'Orden de firma, desde 1' })
  order: number;
}

/** Documento creado por `POST /integration/documents`. */
export class IntegrationCreatedDocumentData {
  @ApiProperty({
    format: 'uuid',
    example: '2be3b9d7-4c5d-4e6f-8a9b-0c1d2e3f4a5b',
  })
  id: string;

  @ApiProperty({
    enum: DOCUMENT_STATUS_ENUM,
    example: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
  })
  status: DOCUMENT_STATUS_ENUM;

  @ApiProperty({
    enum: SIGNATURE_TYPE_ENUM,
    nullable: true,
    example: SIGNATURE_TYPE_ENUM.SIMPLE,
    description: '`FIEL` es la firma avanzada',
  })
  signatureType: SIGNATURE_TYPE_ENUM | null;

  @ApiProperty({ example: 'contrato.pdf' })
  fileName: string;

  @ApiProperty({ example: '2026-10-26T12:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ type: IntegrationDocumentCreatorData })
  creator: IntegrationDocumentCreatorData;

  @ApiProperty({
    example: 1,
    description: 'Firmantes y testigos del documento',
  })
  participantsCount: number;

  @ApiProperty({
    example:
      'https://app.firmalo.com/public/documents/2be3b9d7-4c5d-4e6f-8a9b-0c1d2e3f4a5b',
    description: 'URL pública de consulta del documento (`PUBLIC_WEB_APP_URL`)',
  })
  publicUrl: string;

  @ApiProperty({
    type: [IntegrationDocumentParticipantData],
    description:
      'Firmantes en orden de firma. No incluye URLs de firma: cada uno recibe su invitación por correo, y el portal pide un acceso temporal con `POST /integration/documents/:documentId/signing-access`.',
  })
  participants: IntegrationDocumentParticipantData[];
}

export class IntegrationCreatedDocumentResponse extends BaseResponse<IntegrationCreatedDocumentData> {
  @ApiProperty({ type: IntegrationCreatedDocumentData })
  data: IntegrationCreatedDocumentData;
}

/** Contenido de `error` en toda respuesta de error de la API de integración. */
export class IntegrationErrorData {
  @ApiProperty({
    example: 'DUPLICATE_PARTICIPANT_EMAIL',
    description:
      'Código estable del error (p. ej. `PARTICIPANTS_REQUIRED`, `SIGNER_REQUIRED`, `MAX_PARTICIPANTS_EXCEEDED`, `INVALID_PARTICIPANT_ROLE`, `INVALID_PARTICIPANT_EMAIL`, `DUPLICATE_PARTICIPANT_EMAIL`, `SIGNER_SIGNATURE_POSITION_REQUIRED`, `WITNESS_SIGNATURE_POSITION_NOT_ALLOWED`, `INVALID_SIGNING_ORDER`, `DUPLICATE_SIGNING_ORDER`, `INVALID_SIGNATURE_POSITION`, `SIGNATURE_POSITION_PAGE_OUT_OF_RANGE`, `SIGNATURE_POSITION_OVERLAP`, `API_KEY_INVALID`, `INTERNAL_ERROR`)',
  })
  code: string;

  @ApiProperty({
    example: 'Un colaborador sólo puede participar una vez en el documento.',
  })
  message: string;

  @ApiProperty({
    required: false,
    type: Object,
    example: { field: 'participants[2].email', email: 'ana@correo.com' },
    description:
      'Datos del error: `field` con la ruta del campo afectado cuando aplica, y los valores que lo explican (`limit`, `received`, `page`, `totalPages`…).',
  })
  details?: Record<string, unknown>;
}

/** `{ success: false, error: { code, message, details } }`: forma de todo error de integración. */
export class IntegrationErrorResponseDto {
  @ApiProperty({ example: false })
  success: false;

  @ApiProperty({ type: IntegrationErrorData })
  error: IntegrationErrorData;
}

/** Acceso temporal de firma emitido por `POST /integration/documents/:documentId/signing-access`. */
export class IntegrationSigningAccessData {
  @ApiProperty({
    example: 'https://app.firmalo.com/sign/launch/EjemploDeTokenNoReal',
    description:
      'URL `/sign/launch/:token` de un solo uso para abrir desde tu portal. Al abrirla, la plataforma envía un código al correo del firmante.',
  })
  url: string;

  @ApiProperty({
    example: '2026-10-26T12:05:00.000Z',
    description: 'Vencimiento de la URL: cinco minutos después de emitirla',
  })
  expiresAt: Date;
}

export class IntegrationSigningAccessResponse extends BaseResponse<IntegrationSigningAccessData> {
  @ApiProperty({ example: 'Acceso temporal de firma generado' })
  message: string;

  @ApiProperty({ type: IntegrationSigningAccessData })
  data: IntegrationSigningAccessData;
}

/** Resultado de `POST …/collaborators/:collaboratorId/resend-invitation`. Nunca trae el enlace. */
export class IntegrationResentInvitationData {
  @ApiProperty({
    format: 'uuid',
    example: '5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f',
  })
  collaboratorId: string;

  @ApiProperty({
    example: '2026-11-02T12:00:00.000Z',
    description: 'Vencimiento de la invitación nueva',
  })
  invitationExpiresAt: Date;

  @ApiProperty({
    example: true,
    description:
      '`false` si la invitación se emitió pero el correo no se pudo entregar; se puede reintentar más tarde',
  })
  emailDelivered: boolean;
}

export class IntegrationResentInvitationResponse extends BaseResponse<IntegrationResentInvitationData> {
  @ApiProperty({ example: 'Invitación reenviada al correo del firmante' })
  message: string;

  @ApiProperty({ type: IntegrationResentInvitationData })
  data: IntegrationResentInvitationData;
}
