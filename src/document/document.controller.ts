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
  ApiBody,
  ApiTags,
  ApiQuery,
  ApiParam,
  ApiConsumes,
  ApiResponse,
  ApiSecurity,
  ApiOperation,
  ApiExcludeEndpoint,
} from '@nestjs/swagger';

// DTOs
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { GetDocumentsBySignerDto } from './dto/get-documents-by-signer.dto';
import { DocumentResponseDto, SignerDocumentListResponseDto } from './dto/document-response.dto';

// Services
import { DocumentService } from './document.service';

// Enums
import { DOCUMENT_STATUS_ENUM } from './enum/document-status.enum';
import { IpInterceptor } from 'src/ip/ip.interceptor';
import { ClientIp } from 'src/ip/ip.decorator';

// Decorators
import { Public } from 'src/auth/decorators/public.decorator';

// Interfaces
import { BadRequestResponse, NotFoundResponse } from 'src/interfaces/api-response.dto';
import { DocumentCreateResponse } from './interfaces/responses/document-create-response';
import { DocumentGetListResponse } from './interfaces/responses/document-get-response';
import { GetDocumentsQueryDto } from './dto/get-documents-query-dto';

@Public()
@ApiTags('Document')
@ApiSecurity('x-api-key')
@Controller('document')
export class DocumentController {
  constructor(private readonly documentService: DocumentService) { }

  @Get('file/:id')
  @ApiExcludeEndpoint()
  getDocumentUrl(
    @Param('id') id: string,
  ) {
    return this.documentService.getDocumentMinioURL(id);
  }

  @Post()
  @ApiOperation({ summary: 'Registrar nuevo documento para firmar' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: CreateDocumentDto })
  @ApiResponse({ status: 201, description: 'Documento subido y registrado exitosamente en el sistema, pendiente de firma', type: DocumentCreateResponse })
  @ApiResponse({ status: 400, description: 'Datos de entrada inválidos, formato de archivo no soportado o documento no proporcionado', type: BadRequestResponse })
  @ApiResponse({ status: 404, description: 'El firmante o el usuario creador especificado no existe en el sistema', type: NotFoundResponse })
  @UseInterceptors(FileInterceptor('file'), IpInterceptor)
  async create(
    @Body() createDocumentDto: CreateDocumentDto,
    @UploadedFile() file: Express.Multer.File,
    @ClientIp() ip: string,
  ) {
    return await this.documentService.create(createDocumentDto, file, ip);
  }

  @Get()
  @ApiOperation({ summary: 'Consultar documentos con filtros opcionales' })
  @ApiQuery({ name: 'id', required: false, description: 'UUID del documento', format: 'uuid' })
  @ApiQuery({ name: 'signerId', required: false, description: 'UUID del firmante', format: 'uuid' })
  @ApiQuery({ name: 'email', required: false, description: 'Email del firmante/propietario' })
  @ApiQuery({ name: 'status', required: false, enum: DOCUMENT_STATUS_ENUM, description: 'Estatus del documento' })
  @ApiQuery({ name: 'dateFrom', required: false, description: 'Fecha inicio (ISO 8601)', example: '2024-01-01' })
  @ApiQuery({ name: 'dateTo', required: false, description: 'Fecha fin (ISO 8601)', example: '2024-12-31' })
  @ApiQuery({ name: 'page', required: false, description: 'Página', example: 1 })
  @ApiQuery({ name: 'limit', required: false, description: 'Resultados por página', example: 10 })
  @ApiResponse({ status: 200, description: 'Lista de documentos', type: DocumentGetListResponse })
  @ApiResponse({ status: 400, description: 'Parámetros inválidos', type: BadRequestResponse })
  @ApiResponse({ status: 404, description: 'Recurso no encontrado', type: NotFoundResponse })
  findAll(@Query() query: GetDocumentsQueryDto) {
    return this.documentService.findWithFilters(query);
  }

  @Patch(':id/submit')
  @ApiOperation({ summary: 'Enviar documento a autorización (CREATED → PENDING)' })
  @ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Documento enviado a autorización y firmante notificado', type: DocumentResponseDto })
  @ApiResponse({ status: 400, description: 'El documento no está en estatus CREATED', type: BadRequestResponse })
  @ApiResponse({ status: 404, description: 'Documento no encontrado', type: NotFoundResponse })
  submitForAuthorization(@Param('id') id: string) {
    return this.documentService.submitForAuthorization(id);
  }

  @Patch(':id/cancellation/submit')
  @ApiOperation({ summary: 'Enviar documento a cancelación (SIGNED → CANCELLATION_PENDING)' })
  @ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Documento enviado a cancelación y firmante notificado', type: DocumentResponseDto })
  @ApiResponse({ status: 400, description: 'El documento no está en estatus SIGNED', type: BadRequestResponse })
  @ApiResponse({ status: 404, description: 'Documento no encontrado', type: NotFoundResponse })
  submitForCancellation(@Param('id') id: string) {
    return this.documentService.submitForCancellation(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar documento (solo estatus CREATED)' })
  @ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' })
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiBody({ type: UpdateDocumentDto })
  @ApiResponse({ status: 200, description: 'Documento actualizado correctamente', type: DocumentResponseDto })
  @ApiResponse({ status: 400, description: 'El documento no está en estatus CREATED', type: BadRequestResponse })
  @ApiResponse({ status: 404, description: 'Documento no encontrado', type: NotFoundResponse })
  update(@Param('id') id: string, @Body() updateDocumentDto: UpdateDocumentDto) {
    return this.documentService.update(id, updateDocumentDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar documento (solo estatus CREATED)' })
  @ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Documento eliminado correctamente' })
  @ApiResponse({ status: 400, description: 'El documento no está en estatus CREATED', type: BadRequestResponse })
  @ApiResponse({ status: 404, description: 'Documento no encontrado', type: NotFoundResponse })
  remove(@Param('id') id: string) {
    return this.documentService.remove(id);
  }
}
