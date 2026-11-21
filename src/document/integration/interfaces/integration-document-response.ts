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
      'Tipo de firma. `FIEL` corresponde a `ADVANCED` en la petición. Puede ser `null` en documentos antiguos.',
  })
  signatureType: SIGNATURE_TYPE_ENUM | null;

  @ApiProperty({ example: '2026-10-26T12:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({
    nullable: true,
    type: Date,
    example: null,
    description:
      'Cuándo firmó el último firmante; `null` mientras falten firmas.',
  })
  signedAt: Date | null;
}

export class IntegrationDocumentsPagination {
  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({
    example: 25,
    description: 'Documentos por página.',
  })
  limit: number;

  @ApiProperty({
    example: 42,
    description: 'Documentos que cumplen los filtros.',
  })
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
  @ApiProperty({
    example: 'ana.lopez@cliente.example',
    description: 'El `creator.email` que enviaste.',
  })
  email: string;
}

/** Un firmante del documento creado. Sin ids internos ni URLs de firma. */
export class IntegrationDocumentParticipantData {
  @ApiProperty({ example: 'luis.martinez@correo.example' })
  email: string;

  @ApiProperty({
    enum: ['PENDING', 'WAITING_FOR_PREVIOUS_SIGNER', 'SIGNED', 'REJECTED'],
    example: 'PENDING',
    description:
      '`PENDING`: ya puede firmar. `WAITING_FOR_PREVIOUS_SIGNER`: el documento es secuencial y falta la firma de alguien antes. `SIGNED` o `REJECTED`: ya respondió.',
  })
  status: string;

  @ApiProperty({
    enum: SIGNATURE_TYPE_ENUM,
    nullable: true,
    example: SIGNATURE_TYPE_ENUM.SIMPLE,
  })
  signatureType: SIGNATURE_TYPE_ENUM | null;

  @ApiProperty({ example: 1, description: 'Turno de firma, desde 1.' })
  order: number;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description:
      'El `taxId` que enviaste para el firmante. `null` si no lo enviaste o si la firma no es `FIEL`.',
  })
  taxId: string | null;
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
    description:
      'Tipo de firma. `FIEL` corresponde a `ADVANCED` en la petición.',
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
    description: 'Total de firmantes y testigos.',
  })
  participantsCount: number;

  @ApiProperty({
    example:
      'https://app.firmalo.com/public/documents/2be3b9d7-4c5d-4e6f-8a9b-0c1d2e3f4a5b',
    description: 'Página pública de consulta del documento.',
  })
  publicUrl: string;

  @ApiProperty({
    type: [IntegrationDocumentParticipantData],
    description:
      'Sólo los firmantes, en orden de firma; los testigos no aparecen. Cada uno recibe su invitación por correo. Para que firme desde tu portal, pide un enlace con `POST /api/v1/integration/documents/{documentId}/signing-access`.',
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
      'Código estable del error. Decide qué hacer según este valor; cada endpoint lista los suyos en sus respuestas.',
  })
  code: string;

  @ApiProperty({
    example: 'Un colaborador sólo puede participar una vez en el documento.',
    description: 'Explicación legible. Puede cambiar: no la uses para decidir.',
  })
  message: string;

  @ApiProperty({
    required: false,
    type: Object,
    example: {
      field: 'participants[2].email',
      email: 'luis.martinez@correo.example',
    },
    description:
      'Opcional. En errores de validación, `field` señala el campo que debes corregir; puede traer otros datos que explican el error.',
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
    description: 'Enlace de un solo uso. Redirige al firmante a esta URL.',
  })
  url: string;

  @ApiProperty({
    example: '2026-10-26T12:05:00.000Z',
    description: 'Cuándo vence el enlace: 5 minutos después de generarlo.',
  })
  expiresAt: Date;
}

export class IntegrationSigningAccessResponse extends BaseResponse<IntegrationSigningAccessData> {
  @ApiProperty({ example: 'Acceso temporal de firma generado' })
  message: string;

  @ApiProperty({ type: IntegrationSigningAccessData })
  data: IntegrationSigningAccessData;
}

/** Resultado de `POST …/collaborators/resend-invitation`. Nunca trae el enlace ni ids internos. */
export class IntegrationResentInvitationData {
  @ApiProperty({
    example: 'luis.martinez@correo.example',
    description: 'Correo al que se envió la invitación.',
  })
  email: string;

  @ApiProperty({
    example: '2026-11-02T12:00:00.000Z',
    description: 'Cuándo vence el enlace de la invitación nueva.',
  })
  invitationExpiresAt: Date;

  @ApiProperty({
    example: true,
    description:
      '`false` si no se pudo enviar el correo. La invitación existe; vuelve a reenviarla pasados 10 minutos.',
  })
  emailDelivered: boolean;
}

export class IntegrationResentInvitationResponse extends BaseResponse<IntegrationResentInvitationData> {
  @ApiProperty({ example: 'Invitación reenviada al correo del firmante' })
  message: string;

  @ApiProperty({ type: IntegrationResentInvitationData })
  data: IntegrationResentInvitationData;
}
