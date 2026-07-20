import { Body, Controller, Post, UseInterceptors } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { DocumentSignaturesService } from './document-signatures.service';
import { CreateDocumentSignaturesDto } from './dto/create-document-signatures.dto';
import { DocumentSignaturesCreateResponse } from './interfaces/responses/document-signatures-create-response';
import { BadRequestResponse } from 'src/interfaces/api-response.dto';

import { IpInterceptor } from 'src/ip/ip.interceptor';
import { ClientIp } from 'src/ip/ip.decorator';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { ActiveAccountId } from 'src/auth/decorators/active-account-id.decorator';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';

@ApiTags('Document')
@ApiBearerAuth('access-token')
@Controller('api/v1/documents')
export class DocumentSignaturesController {
  constructor(
    private readonly documentSignaturesService: DocumentSignaturesService,
  ) {}

  @Post('signatures')
  @ApiOperation({
    summary:
      'Orquesta la creación transaccional de un documento y su flujo de firmas (Document, Collaborator, Notification, verification_code) y publica un evento de Kafka por notificación',
  })
  @ApiHeader({
    name: 'X-Account-Id',
    description:
      'UUID de la cuenta activa (personal u organización). El documento queda scopeado a esa cuenta; el usuario debe ser miembro activo.',
    required: true,
  })
  @ApiBody({ type: CreateDocumentSignaturesDto })
  @ApiResponse({
    status: 201,
    description:
      'Documento, colaboradores, notificaciones y códigos de verificación creados; eventos publicados en Kafka',
    type: DocumentSignaturesCreateResponse,
  })
  @ApiResponse({
    status: 400,
    description:
      'Payload inválido, archivo referenciado (objectKey) no encontrado, o colaborador ADVANCED sin rfc',
    type: BadRequestResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  @ApiResponse({
    status: 403,
    description: 'No perteneces a la cuenta activa (X-Account-Id)',
  })
  @UseInterceptors(IpInterceptor)
  async create(
    @CurrentUser() user: JwtPayload,
    @ActiveAccountId() accountId: string,
    @Body() dto: CreateDocumentSignaturesDto,
    @ClientIp() ip: string,
  ) {
    return this.documentSignaturesService.create(user.sub, accountId, dto, ip);
  }
}
