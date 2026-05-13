import { Controller, Get, Post, Body, Patch, Param, Delete, UseInterceptors, UploadedFile, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiExcludeEndpoint, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from 'src/auth/decorators/public.decorator';
import { DocumentService } from './document.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { DocumentResponseDto, SignerDocumentListResponseDto } from './dto/document-response.dto';
import { ApiInvalidDataResponseDto, ApiNotFoundResponseDto } from 'src/interfaces/api-response.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { GetDocumentsBySignerDto } from './dto/get-documents-by-signer.dto';
import { DOCUMENT_STATUS_ENUM } from './enum/document-status.enum';

@ApiTags('Document')
@ApiBearerAuth('access-token')
@Controller('document')
export class DocumentController {
  constructor(
    private readonly documentService: DocumentService,
  ) {}

  @Public()
  @Get('file/:id')
  @ApiExcludeEndpoint()
  getDocumentUrl(
    @Param('id') id: string,
  ) {
    return this.documentService.getDocumentMinioURL(id);
  }

  @Public()
  @Post()
  @ApiOperation({ summary: 'Registrar nuevo documento para firmar' })
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiBody({ type: CreateDocumentDto })
  @ApiResponse({ status: 201, description: 'Documento registrado para firmar correctamente', type: DocumentResponseDto })
  @ApiResponse({ status: 400, description: 'Datos de entrada inválidos o archivo no proporcionado', type: ApiInvalidDataResponseDto })
  @ApiResponse({ status: 404, description: 'Firmante o creador no encontrado', type: ApiNotFoundResponseDto })
  @UseInterceptors(FileInterceptor('document'))
  async create(
    @Body() createDocumentDto: CreateDocumentDto,
    @UploadedFile() document: Express.Multer.File,
  ) {
    return await this.documentService.create(createDocumentDto, document);
  }

  @Public()
  @Get()
  @ApiOperation({ summary: 'Obtener todos los documentos' })
  @ApiResponse({ status: 200, description: 'Lista de todos los documentos', type: [DocumentResponseDto] })
  findAll() {
    return this.documentService.findAll();
  }

  @Public()
  @Get('signer/:signerId')
  @ApiOperation({ summary: 'Obtener documentos asignados a un firmante' })
  @ApiParam({ name: 'signerId', description: 'UUID del usuario firmante', format: 'uuid' })
  @ApiQuery({ name: 'status', enum: DOCUMENT_STATUS_ENUM, required: false, description: 'Filtrar por estatus del documento' })
  @ApiResponse({ status: 200, description: 'Lista de documentos del firmante', type: SignerDocumentListResponseDto })
  @ApiResponse({ status: 404, description: 'Firmante no encontrado', type: ApiNotFoundResponseDto })
  findDocumentsBySigner(
    @Param('signerId') signerId: string,
    @Query() query: GetDocumentsBySignerDto,
  ) {
    return this.documentService.findDocumentsBySigner(signerId, query.status);
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Obtener documento por UUID' })
  @ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Documento encontrado', type: DocumentResponseDto })
  @ApiResponse({ status: 404, description: 'Documento no encontrado', type: ApiNotFoundResponseDto })
  findOne(@Param('id') id: string) {
    return this.documentService.findOne(id);
  }

  @Public()
  @Patch(':id/submit')
  @ApiOperation({ summary: 'Enviar documento a autorización (CREATED → PENDING)' })
  @ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Documento enviado a autorización y firmante notificado', type: DocumentResponseDto })
  @ApiResponse({ status: 400, description: 'El documento no está en estatus CREATED', type: ApiInvalidDataResponseDto })
  @ApiResponse({ status: 404, description: 'Documento no encontrado', type: ApiNotFoundResponseDto })
  submitForAuthorization(@Param('id') id: string) {
    return this.documentService.submitForAuthorization(id);
  }

  @Public()
  @Patch(':id/cancellation/submit')
  @ApiOperation({ summary: 'Enviar documento a cancelación (SIGNED → CANCELLATION_PENDING)' })
  @ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Documento enviado a cancelación y firmante notificado', type: DocumentResponseDto })
  @ApiResponse({ status: 400, description: 'El documento no está en estatus SIGNED', type: ApiInvalidDataResponseDto })
  @ApiResponse({ status: 404, description: 'Documento no encontrado', type: ApiNotFoundResponseDto })
  submitForCancellation(@Param('id') id: string) {
    return this.documentService.submitForCancellation(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar documento (solo estatus CREATED)' })
  @ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' })
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiBody({ type: UpdateDocumentDto })
  @ApiResponse({ status: 200, description: 'Documento actualizado correctamente', type: DocumentResponseDto })
  @ApiResponse({ status: 400, description: 'El documento no está en estatus CREATED', type: ApiInvalidDataResponseDto })
  @ApiResponse({ status: 404, description: 'Documento no encontrado', type: ApiNotFoundResponseDto })
  update(@Param('id') id: string, @Body() updateDocumentDto: UpdateDocumentDto) {
    return this.documentService.update(id, updateDocumentDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar documento (solo estatus CREATED)' })
  @ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Documento eliminado correctamente' })
  @ApiResponse({ status: 400, description: 'El documento no está en estatus CREATED', type: ApiInvalidDataResponseDto })
  @ApiResponse({ status: 404, description: 'Documento no encontrado', type: ApiNotFoundResponseDto })
  remove(@Param('id') id: string) {
    return this.documentService.remove(id);
  }
}
