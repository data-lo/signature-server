import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  UseInterceptors,
  UploadedFiles,
 } from '@nestjs/common';
import { SignatureService } from './signature.service';
import { CreateSignatureDto } from './dto/create-signature.dto';
import { UpdateSignatureDto } from './dto/update-signature.dto';
import { FileFieldsInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiResponse, ApiTags, ApiExcludeEndpoint } from '@nestjs/swagger';
import { Public } from 'src/auth/decorators/public.decorator';
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';
import { SignatureResponseDto } from './dto/signature-response.dto';
import { ApiInvalidDataResponseDto, ApiNotFoundResponseDto } from 'src/interfaces/api-response.dto';


@ApiTags('Signature')
@ApiBearerAuth('access-token')
@Controller('signature')
export class SignatureController {
  constructor(
    private readonly signatureService: SignatureService,
  ) {}

  @Public()
  @ApiExcludeEndpoint()
  @Get('files/:fileId')
  @ApiOperation({ summary: 'Obtener archivo de firma o identificación desde MinIO' })
  @ApiParam({ name: 'fileId', description: 'Clave del objeto en MinIO (object key)' })
  @ApiResponse({ status: 200, description: 'URL del archivo generada correctamente' })
  @ApiResponse({ status: 404, description: 'Archivo no encontrado', type: ApiNotFoundResponseDto })
  async getFile(
    @Param('fileId') fileId: string,
    @Body('bucketType') bucketType: BUCKET_TYPES_ENUM,
  ) {
    return await this.signatureService.getFile(fileId, bucketType);
  }

  @Public()
  @ApiExcludeEndpoint()
  @Get(':id')
  @ApiOperation({ summary: 'Obtener firma por UUID' })
  @ApiParam({ name: 'id', description: 'UUID de la firma', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Firma encontrada', type: SignatureResponseDto })
  @ApiResponse({ status: 404, description: 'Firma no encontrada', type: ApiNotFoundResponseDto })
  findOne(@Param('id') id: string) {
    return this.signatureService.findOne(id);
  }

  @Public()
  @Post()
  @ApiOperation({ summary: 'Crear nueva firma y asignarla al usuario' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: CreateSignatureDto })
  @ApiResponse({ status: 201, description: 'Firma creada y asignada al usuario correctamente', type: SignatureResponseDto })
  @ApiResponse({ status: 400, description: 'Imagen de firma requerida o datos inválidos', type: ApiInvalidDataResponseDto })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado', type: ApiNotFoundResponseDto })
  @UseInterceptors(FilesInterceptor('files',2))
  async create(
    @Body() dto: CreateSignatureDto,
    @UploadedFiles() files: Array<Express.Multer.File>,
  ) {
    return this.signatureService.create(dto, files);
  }

  @Public()
  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar imagen de firma y/o INE' })
  @ApiParam({ name: 'id', description: 'UUID de la firma a actualizar', format: 'uuid' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UpdateSignatureDto })
  @ApiResponse({ status: 200, description: 'Firma actualizada correctamente', type: SignatureResponseDto })
  @ApiResponse({ status: 404, description: 'Firma no encontrada', type: ApiNotFoundResponseDto })
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
    const fileFirma = files?.imagen_firma?.[0];
    const fileIne = files?.imagen_ine?.[0];
    return this.signatureService.update(id, {
      imagen_firma: fileFirma,
      imagen_ine: fileIne,
    });
  }

  @Public()
  @Patch(':id/deactivate')
  @ApiOperation({ summary: 'Desactivar firma (reemplaza imagen con PNG en blanco, conserva INE)' })
  @ApiParam({ name: 'id', description: 'UUID de la firma a desactivar', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Firma desactivada correctamente', type: SignatureResponseDto })
  @ApiResponse({ status: 404, description: 'Firma no encontrada', type: ApiNotFoundResponseDto })
  deactivate(@Param('id') id: string) {
    return this.signatureService.deactivate(id);
  }
}
