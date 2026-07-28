// External dependencies
import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseInterceptors,
  UploadedFile,
  Query,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiTags,
  ApiQuery,
  ApiParam,
  ApiHeader,
  ApiConsumes,
  ApiResponse,
  ApiOperation,
  ApiExcludeEndpoint,
} from '@nestjs/swagger';

// DTOs
import { CreateDocumentDto } from './dto/create-document.dto';
import { RejectDocumentDto } from './dto/reject-document.dto';
import { VerifyCodeDto } from './dto/verify-code.dto';

// Services
import { DocumentService } from './document.service';

// Enums
import { DOCUMENT_STATUS_ENUM } from './enum/document-status.enum';
import { IpInterceptor } from 'src/ip/ip.interceptor';
import { ClientIp } from 'src/ip/ip.decorator';

// Decorators
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { ActiveAccountId } from 'src/auth/decorators/active-account-id.decorator';

// Interfaces
import {
  BadRequestResponse,
  NotFoundResponse,
} from 'src/interfaces/api-response.dto';
import { DocumentCreateResponse } from './interfaces/responses/document-create-response';
import { DocumentGetListResponse } from './interfaces/responses/document-get-response';
import { GetDocumentsQueryDto } from './dto/get-documents-query.dto';
import { SignatureCoordinatesDto } from './dto/signature-coordinates.dto';
import { DocumentUpdateResponse } from './interfaces/responses/document-update-response';
import { SubmitForAuthorizationResponse } from './interfaces/responses/submit-for-authorization-response';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';
import { MAX_UPLOAD_SAFETY_NET_BYTES } from 'src/shared/constants/file-upload.constants';

@ApiTags('Document')
@ApiBearerAuth('access-token')
@Controller('document')
export class DocumentController {
  constructor(private readonly documentService: DocumentService) {}

  @Get('file/:id')
  @ApiExcludeEndpoint()
  async getDocumentUrl(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    await this.documentService.assertUserHasAccess(id, user.sub);
    return this.documentService.getDocumentMinioURL(id);
  }

  @Post()
  @ApiOperation({ summary: 'Registrar nuevo documento para firmar' })
  @ApiHeader({
    name: 'X-Account-Id',
    description:
      'UUID de la cuenta activa (personal u organización). El documento queda scopeado a esa cuenta; el usuario debe ser miembro activo.',
    required: true,
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: CreateDocumentDto })
  @ApiResponse({
    status: 201,
    description:
      'Documento subido y registrado exitosamente en el sistema, pendiente de firma',
    type: DocumentCreateResponse,
  })
  @ApiResponse({
    status: 400,
    description:
      'Datos de entrada inválidos, formato de archivo no soportado o documento no proporcionado',
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
  @ApiResponse({
    status: 404,
    description:
      'Algún firmante o espectador especificado no existe en el sistema',
    type: NotFoundResponse,
  })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_SAFETY_NET_BYTES },
    }),
    IpInterceptor,
  )
  async create(
    @CurrentUser() user: JwtPayload,
    @ActiveAccountId() accountId: string,
    @Body() createDocumentDto: CreateDocumentDto,
    @UploadedFile() file: Express.Multer.File,
    @ClientIp() ip: string,
  ) {
    return await this.documentService.create(
      user.sub,
      accountId,
      createDocumentDto,
      file,
      ip,
    );
  }

  @Get()
  @ApiOperation({ summary: 'Consultar documentos con filtros opcionales' })
  @ApiHeader({
    name: 'X-Account-Id',
    description:
      'UUID de la cuenta activa (personal u organización). El listado se restringe a los documentos de esa cuenta; el usuario debe ser miembro activo.',
    required: true,
  })
  @ApiQuery({
    name: 'id',
    required: false,
    description: 'UUID del documento',
    format: 'uuid',
  })
  @ApiQuery({
    name: 'participantEmail',
    required: false,
    description: 'Email de un participante (firmante o espectador)',
  })
  @ApiQuery({
    name: 'email',
    required: false,
    description: 'Email del propietario o de cualquier participante',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: DOCUMENT_STATUS_ENUM,
    description: 'Estatus del documento',
  })
  @ApiQuery({
    name: 'dateFrom',
    required: false,
    description: 'Fecha de creación inicio (ISO 8601)',
    example: '2024-01-01',
  })
  @ApiQuery({
    name: 'dateTo',
    required: false,
    description: 'Fecha de creación fin (ISO 8601)',
    example: '2024-12-31',
  })
  @ApiQuery({
    name: 'signedDateFrom',
    required: false,
    description: 'Fecha de firma inicio (ISO 8601)',
    example: '2024-01-01',
  })
  @ApiQuery({
    name: 'signedDateTo',
    required: false,
    description: 'Fecha de firma fin (ISO 8601)',
    example: '2024-12-31',
  })
  @ApiQuery({
    name: 'fileName',
    required: false,
    description: 'Búsqueda parcial por nombre de archivo',
  })
  @ApiQuery({
    name: 'participantName',
    required: false,
    description:
      'Búsqueda parcial por nombre o correo de un firmante/espectador',
  })
  @ApiQuery({
    name: 'myTurnOnly',
    required: false,
    description:
      'Requiere participantEmail. Solo documentos donde te toca firmar ahora mismo',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'Página',
    example: 1,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Resultados por página',
    example: 10,
  })
  @ApiResponse({
    status: 200,
    description: 'Lista de documentos',
    type: DocumentGetListResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'Parámetros inválidos',
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
  findAll(
    @CurrentUser() user: JwtPayload,
    @ActiveAccountId() accountId: string,
    @Query() query: GetDocumentsQueryDto,
  ) {
    return this.documentService.findWithFilters(user.sub, accountId, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Obtener el detalle de un documento para la pantalla de firma',
  })
  @ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' })
  @ApiResponse({
    status: 200,
    description: 'Detalle del documento obtenido correctamente',
  })
  @ApiResponse({
    status: 401,
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  @ApiResponse({
    status: 403,
    description: 'No tienes acceso a este documento',
  })
  @ApiResponse({
    status: 404,
    description: 'Documento no encontrado',
    type: NotFoundResponse,
  })
  findOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.documentService.findDetailForUser(id, user.sub);
  }

  @Patch(':id/submit-for-authorization')
  @ApiOperation({
    summary:
      'Enviar documento a autorización (notifica al primer firmante en turno)',
  })
  @ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' })
  @ApiResponse({
    status: 200,
    description:
      'Documento enviado a autorización exitosamente, firmante notificado por correo',
    type: SubmitForAuthorizationResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'El documento no se encuentra en estatus CREATED',
    type: BadRequestResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  @ApiResponse({
    status: 403,
    description: 'El documento no pertenece al usuario autenticado',
  })
  @ApiResponse({
    status: 404,
    description: 'Documento no encontrado',
    type: NotFoundResponse,
  })
  submitForAuthorization(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    return this.documentService.submitForAuthorization(id, user.sub);
  }

  @Patch(':id/sign')
  @ApiOperation({
    summary: 'Firmar el documento (solo si es tu turno como firmante)',
  })
  @ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Documento firmado correctamente' })
  @ApiResponse({
    status: 400,
    description:
      'El documento no se encuentra en estatus PENDING o ya respondiste',
    type: BadRequestResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  @ApiResponse({
    status: 403,
    description: 'No eres firmante de este documento o no es tu turno',
  })
  @ApiResponse({
    status: 404,
    description: 'Documento no encontrado',
    type: NotFoundResponse,
  })
  sign(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.documentService.sign(id, user.sub);
  }

  @Patch(':id/link-collaborator')
  @ApiOperation({
    summary:
      'Vincula al usuario autenticado como firmante del documento si fue invitado solo por email (Firma Digital Simple) — ver historia "Notificación por Email para Firma Simple y Vinculación de Cuenta"',
  })
  @ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' })
  @ApiResponse({
    status: 200,
    description:
      'Vinculación procesada (linked=true si había una invitación pendiente que coincidía con el email del usuario autenticado, linked=false si no)',
  })
  @ApiResponse({
    status: 401,
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  linkCollaborator(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.documentService.linkPendingCollaboratorAccount(id, user.sub);
  }

  @Post(':id/verification-codes')
  @ApiOperation({
    summary:
      'Solicitar un código de verificación para firmar (documentos con requiresVerification=true)',
  })
  @ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' })
  @ApiResponse({
    status: 201,
    description: 'Código de verificación enviado por correo',
  })
  @ApiResponse({
    status: 401,
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  @ApiResponse({
    status: 403,
    description: 'No eres firmante de este documento',
  })
  @UseInterceptors(IpInterceptor)
  requestVerificationCode(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @ClientIp() ip: string,
  ) {
    return this.documentService.requestVerificationCode(id, user.sub, ip);
  }

  @Post(':id/verification-codes/verify')
  @ApiOperation({ summary: 'Validar el código de verificación recibido' })
  @ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' })
  @ApiBody({ type: VerifyCodeDto })
  @ApiResponse({ status: 201, description: 'Código verificado correctamente' })
  @ApiResponse({
    status: 400,
    description: 'Código inválido, expirado o ya usado',
    type: BadRequestResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  @ApiResponse({
    status: 403,
    description: 'No eres firmante de este documento',
  })
  verifyCode(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: VerifyCodeDto,
  ) {
    return this.documentService.verifyCode(id, user.sub, dto.code);
  }

  @Patch(':id/reject')
  @ApiOperation({
    summary:
      'Rechazar el documento con un motivo (solo si es tu turno como firmante)',
  })
  @ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' })
  @ApiBody({ type: RejectDocumentDto })
  @ApiResponse({
    status: 200,
    description: 'Documento rechazado correctamente',
  })
  @ApiResponse({
    status: 400,
    description:
      'El documento no se encuentra en estatus PENDING o ya respondiste',
    type: BadRequestResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  @ApiResponse({
    status: 403,
    description: 'No eres firmante de este documento o no es tu turno',
  })
  @ApiResponse({
    status: 404,
    description: 'Documento no encontrado',
    type: NotFoundResponse,
  })
  reject(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: RejectDocumentDto,
  ) {
    return this.documentService.reject(id, user.sub, dto.reason);
  }

  @Patch(':id/submit-for-cancellation')
  @ApiOperation({ summary: 'Enviar documento a cancelación' })
  @ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' })
  @ApiResponse({
    status: 200,
    description:
      'Solicitud de cancelación enviada exitosamente, firmantes notificados por correo',
  })
  @ApiResponse({
    status: 400,
    description: 'El documento no se encuentra en estatus SIGNED',
    type: BadRequestResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  @ApiResponse({
    status: 403,
    description: 'El documento no pertenece al usuario autenticado',
  })
  @ApiResponse({
    status: 404,
    description: 'Documento no encontrado',
    type: NotFoundResponse,
  })
  submitForCancellation(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    return this.documentService.requestCancellation(id, user.sub);
  }

  @Patch(':id/confirm-cancellation')
  @ApiOperation({
    summary: 'Confirmar la cancelación de un documento (cualquier firmante)',
  })
  @ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' })
  @ApiResponse({
    status: 200,
    description:
      'Documento cancelado correctamente, marca de agua estampada y participantes notificados',
  })
  @ApiResponse({
    status: 400,
    description: 'El documento no se encuentra en estatus CANCELLATION_PENDING',
    type: BadRequestResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  @ApiResponse({
    status: 403,
    description: 'No eres firmante de este documento',
  })
  @ApiResponse({
    status: 404,
    description: 'Documento no encontrado',
    type: NotFoundResponse,
  })
  confirmCancellation(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    return this.documentService.confirmCancellation(id, user.sub);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Actualizar campos del documento (solo en estatus CREATED)',
  })
  @ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' })
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiBody({ type: SignatureCoordinatesDto })
  @ApiResponse({
    status: 200,
    description: 'Documento actualizado exitosamente',
    type: DocumentUpdateResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'El documento no se encuentra en estatus CREATED',
    type: BadRequestResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  @ApiResponse({
    status: 403,
    description: 'El documento no pertenece al usuario autenticado',
  })
  @ApiResponse({
    status: 404,
    description: 'Documento no encontrado',
    type: NotFoundResponse,
  })
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() signatureCoordinatesDto: SignatureCoordinatesDto,
  ) {
    return this.documentService.update(id, user.sub, signatureCoordinatesDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar documento (solo estatus CREATED)' })
  @ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' })
  @ApiResponse({
    status: 200,
    description: 'Documento eliminado correctamente',
  })
  @ApiResponse({
    status: 400,
    description: 'El documento no está en estatus CREATED',
    type: BadRequestResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  @ApiResponse({
    status: 403,
    description: 'El documento no pertenece al usuario autenticado',
  })
  @ApiResponse({
    status: 404,
    description: 'Documento no encontrado',
    type: NotFoundResponse,
  })
  remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.documentService.remove(id, user.sub);
  }
}
