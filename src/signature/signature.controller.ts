import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor, FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from 'src/auth/decorators/public.decorator';
import { SignatureService } from './signature.service';
import { CreateSignatureDto } from './dto/create-signature.dto';

@ApiTags('Signature')
@ApiBearerAuth('access-token')
@Controller('signature')
export class SignatureController {
  constructor(private readonly signatureService: SignatureService) {}

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Obtener firma por UUID' })
  @ApiParam({ name: 'id', description: 'UUID de la firma', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Firma encontrada' })
  @ApiResponse({ status: 404, description: 'Firma no encontrada' })
  findOne(@Param('id') id: string) {
    return this.signatureService.findOne(id);
  }

  @Public()
  @Post()
  @ApiOperation({ summary: 'Crear nueva firma y asignarla al usuario' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['userId', 'imagen_firma'],
      properties: {
        userId: { type: 'string', format: 'uuid', description: 'UUID del usuario al que se asignará la firma' },
        createdBy: { type: 'string', format: 'uuid', description: 'UUID del responsable que registra la firma (opcional)' },
        imagen_firma: { type: 'string', format: 'binary', description: 'Imagen PNG de la firma' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Firma creada y asignada al usuario correctamente' })
  @ApiResponse({ status: 400, description: 'Imagen de firma requerida o datos inválidos' })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado' })
  @UseInterceptors(FileInterceptor('imagen_firma'))
  create(
    @Body() dto: CreateSignatureDto,
    @UploadedFile() signatureFile: Express.Multer.File,
  ) {
    return this.signatureService.create(dto, signatureFile);
  }

  @Public()
  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar imagen de firma y/o INE' })
  @ApiParam({ name: 'id', description: 'UUID de la firma a actualizar', format: 'uuid' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        imagen_firma: { type: 'string', format: 'binary', description: 'Nueva imagen PNG de la firma (opcional)' },
        imagen_ine: { type: 'string', format: 'binary', description: 'Nueva imagen de la identificación oficial (opcional)' },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Firma actualizada correctamente' })
  @ApiResponse({ status: 404, description: 'Firma no encontrada' })
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'imagen_firma', maxCount: 1 },
      { name: 'imagen_ine', maxCount: 1 },
    ]),
  )
  update(
    @Param('id') id: string,
    @UploadedFiles()
    files: { imagen_firma?: Express.Multer.File[]; imagen_ine?: Express.Multer.File[] },
  ) {
    return this.signatureService.update(id, files);
  }

  @Public()
  @Patch(':id/deactivate')
  @ApiOperation({ summary: 'Desactivar firma (reemplaza imagen con PNG en blanco, conserva INE)' })
  @ApiParam({ name: 'id', description: 'UUID de la firma a desactivar', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Firma desactivada correctamente' })
  @ApiResponse({ status: 404, description: 'Firma no encontrada' })
  deactivate(@Param('id') id: string) {
    return this.signatureService.deactivate(id);
  }
}
