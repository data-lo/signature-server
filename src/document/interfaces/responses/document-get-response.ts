import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse } from '../../../interfaces/api-response.dto';
import { DOCUMENT_STATUS_ENUM } from 'src/document/enum/document-status.enum';

export class DocumentGetData {
    @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', description: 'UUID del documento', format: 'uuid' })
    id: string;

    @ApiProperty({ example: 'Convenio_2026_Manuel_Balderrama.pdf', description: 'Nombre original del archivo subido' })
    fileName: string;

    @ApiProperty({ example: 'application/pdf', description: 'Tipo MIME del archivo' })
    fileType: string;

    @ApiProperty({ example: 12, description: 'Total de páginas del documento PDF' })
    totalPages: number;

    @ApiProperty({ example: 'created', description: 'Estatus actual del documento', enum: DOCUMENT_STATUS_ENUM })
    status: string;

    @ApiProperty({ example: '2026-05-14T07:33:29.821Z', description: 'Fecha de creación del documento' })
    createdAt: Date;

    @ApiProperty({ example: 'http://31.97.132.137:9010/created-documents/a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=...', description: 'URL segura y prefirmada para acceder al documento en MinIO' })
    secureUrl: string;

    @ApiProperty({ example: 86400, description: 'Tiempo de expiración de la URL prefirmada en segundos (24 horas)' })
    expiresIn: number;
}

export class DocumentGetResponse extends BaseResponse {
    @ApiProperty({ type: DocumentGetData, description: 'Datos del usuario encontrado' })
    data: DocumentGetData;
}

export class DocumentGetListResponse extends BaseResponse {
    @ApiProperty({ type: [DocumentGetData], description: 'Lista de usuarios activos' })
    data: DocumentGetData[];
}