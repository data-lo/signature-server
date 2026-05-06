import { Controller, Get, Post, Body, Patch, Param, Delete, UseInterceptors, UploadedFile } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiExcludeEndpoint, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from 'src/auth/decorators/public.decorator';
import { DocumentService } from './document.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { DocumentResponseDto } from './dto/document-response.dto';
import { FileInterceptor } from '@nestjs/platform-express';

@ApiTags('Document')
@ApiBearerAuth('access-token')
@Controller('document')
export class DocumentController {
  constructor(private readonly documentService: DocumentService) {}

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
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['signerId', 'createdById', 'coord', 'document'],
      properties: {
        signerId: { type: 'string', format: 'uuid', description: 'UUID del usuario que debe firmar el documento' },
        createdById: { type: 'string', format: 'uuid', description: 'UUID del usuario que solicita la firma' },
        coord: {
          type: 'object',
          description: 'Coordenadas donde se colocará la firma en el PDF',
          properties: {
            left:   { type: 'number', example: 50,  description: 'Coordenada izquierda (px)' },
            right:  { type: 'number', example: 250, description: 'Coordenada derecha (px)' },
            top:    { type: 'number', example: 700, description: 'Coordenada superior (px)' },
            bottom: { type: 'number', example: 780, description: 'Coordenada inferior (px)' },
          },
        },
        document: { type: 'string', format: 'binary', description: 'Archivo PDF del documento a firmar' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Documento registrado para firmar correctamente', type: DocumentResponseDto })
  @ApiResponse({ status: 400, description: 'Datos de entrada inválidos o archivo no proporcionado' })
  @ApiResponse({ status: 404, description: 'Firmante o creador no encontrado' })
  @UseInterceptors(FileInterceptor('document'))
  async create(
    @Body() createDocumentDto: CreateDocumentDto,
    @UploadedFile() document: Express.Multer.File,
  ) {
    console.log(document.filename, document.mimetype);
    return await this.documentService.create(createDocumentDto, document);
  }

  @Get()
  @ApiExcludeEndpoint()
  findAll() {
    return this.documentService.findAll();
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Obtener documento por UUID' })
  @ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Documento encontrado', type: DocumentResponseDto })
  @ApiResponse({ status: 404, description: 'Documento no encontrado' })
  findOne(@Param('id') id: string) {
    return this.documentService.findOne(id);
  }

  @Patch(':id')
  @ApiExcludeEndpoint()
  update(@Param('id') id: string, @Body() updateDocumentDto: UpdateDocumentDto) {
    return this.documentService.update(id, updateDocumentDto);
  }

  @Delete(':id')
  @ApiExcludeEndpoint()
  remove(@Param('id') id: string) {
    return this.documentService.remove(id);
  }
}
