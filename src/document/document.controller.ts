import { Controller, Get, Post, Body, Patch, Param, Delete, UseInterceptors, UploadedFile } from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from 'src/auth/decorators/public.decorator';
import { DocumentService } from './document.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { FileInterceptor } from '@nestjs/platform-express';

@ApiTags('Document')
@ApiBearerAuth('access-token')
@Controller('document')
export class DocumentController {
  constructor(private readonly documentService: DocumentService) {}

  @Public()
  @Post()
  @ApiOperation({ summary: 'Registrar nuevo documento para firmar' })
  @ApiConsumes('multipart/form-data')
  @ApiResponse({ status: 201, description: 'Documento registrado para firmar correctamente' })
  @ApiResponse({ status: 400, description: 'Datos de entrada inválidos' })
  @UseInterceptors(FileInterceptor('document'))
  async create(
    @Body() createDocumentDto: CreateDocumentDto,
    @UploadedFile() document: Express.Multer.File,
  ) {
    console.log(document.filename, document.mimetype);
    return await this.documentService.create(createDocumentDto, document);
  }

  @Public()
  @Get()
  @ApiOperation({ summary: 'Obtener todos los documentos' })
  @ApiResponse({ status: 200, description: 'Lista de documentos' })
  findAll() {
    return this.documentService.findAll();
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Obtener documento por ID' })
  @ApiParam({ name: 'id', description: 'ID del documento' })
  @ApiResponse({ status: 200, description: 'Documento encontrado' })
  @ApiResponse({ status: 404, description: 'Documento no encontrado' })
  findOne(@Param('id') id: string) {
    return this.documentService.findOne(id);
  }

  @Public()
  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar datos de un documento' })
  @ApiParam({ name: 'id', description: 'ID del documento' })
  @ApiResponse({ status: 200, description: 'Documento actualizado correctamente' })
  @ApiResponse({ status: 404, description: 'Documento no encontrado' })
  update(@Param('id') id: string, @Body() updateDocumentDto: UpdateDocumentDto) {
    return this.documentService.update(+id, updateDocumentDto);
  }

  @Public()
  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar documento por ID' })
  @ApiParam({ name: 'id', description: 'ID del documento' })
  @ApiResponse({ status: 200, description: 'Documento eliminado correctamente' })
  @ApiResponse({ status: 404, description: 'Documento no encontrado' })
  remove(@Param('id') id: string) {
    return this.documentService.remove(+id);
  }
}
