// External dependencies
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
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiExcludeEndpoint,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';

// DTOs
import { CreateSignatureDto } from './dto/create-signature.dto';
import { UpdateSignatureDto } from './dto/update-signature.dto';
import { SignatureCreateData, SignatureCreateResponse } from './interfaces/signature-create-response';

// Services
import { SignatureService } from './signature.service';

// Decorators
import { Public } from 'src/auth/decorators/public.decorator';

// Enums
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';

// Interfaces
import { BadRequestResponse, NotFoundResponse, ConflictResponse, BaseResponse } from 'src/interfaces/api-response.dto';
import { SignatureUpdateReponse } from './interfaces/signature-update-response';
import { SignatureDeactivateResponse } from './interfaces/signature-deactivate-response';

@Public()
@ApiTags('Signature')
@ApiSecurity('x-api-key')
@Controller('signature')
export class SignatureController {
  constructor(
    private readonly signatureService: SignatureService,
  ) { }

  @ApiExcludeEndpoint()
  @Get('files/:fileId')
  @ApiOperation({ summary: 'Obtener URL prefirmada de un archivo almacenado en MinIO' })
  @ApiParam({ name: 'fileId', description: 'Clave del objeto en MinIO (object key) del archivo a recuperar' })
  @ApiResponse({ status: 200, description: 'URL prefirmada generada correctamente' })
  @ApiResponse({ status: 404, description: 'Archivo no encontrado en el bucket indicado', type: NotFoundResponse })
  async getFile(
    @Param('fileId') fileId: string,
    @Body('bucketType') bucketType: BUCKET_TYPES_ENUM,
  ) {
    return await this.signatureService.getFile(fileId, bucketType);
  }

  @ApiExcludeEndpoint()
  @Get(':id')
  @ApiOperation({ summary: 'Obtener los datos de una firma por su UUID' })
  @ApiParam({ name: 'id', description: 'Identificador único de la firma en formato UUID v4', format: 'uuid', example: '8c388293-6f5e-4e61-8c96-ae36c2fa6faa' })
  @ApiResponse({ status: 200, description: 'Firma encontrada y datos retornados correctamente', type: BaseResponse })
  @ApiResponse({ status: 404, description: 'No existe una firma registrada con el UUID proporcionado', type: NotFoundResponse })
  findOne(@Param('id') id: string) {
    return this.signatureService.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Registrar una nueva firma y asignarla a un usuario' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: CreateSignatureDto })
  @ApiResponse({ status: 201, description: 'Firma registrada y asignada al usuario correctamente', type: SignatureCreateResponse })
  @ApiResponse({ status: 400, description: 'Datos inválidos o imagen de firma no proporcionada', type: BadRequestResponse })
  @ApiResponse({ status: 401, description: 'API Key inválida o no proporcionada' })
  @ApiResponse({ status: 404, description: 'No existe un usuario registrado con el UUID proporcionado', type: NotFoundResponse })
  @ApiResponse({ status: 409, description: 'El usuario ya tiene una firma registrada', type: ConflictResponse })
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'signatureImage', maxCount: 1 },
      { name: 'officialFile', maxCount: 1 },
    ])
  )
  async create(
    @Body() dto: CreateSignatureDto,
    @UploadedFiles() files: { signatureImage?: Express.Multer.File[]; officialFile?: Express.Multer.File[] },
  ) {
    return this.signatureService.create(dto, files);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar la imagen de firma y/o identificación oficial de un usuario' })
  @ApiParam({ name: 'id', description: 'Identificador único de la firma a actualizar en formato UUID v4', format: 'uuid', example: '8c388293-6f5e-4e61-8c96-ae36c2fa6faa' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UpdateSignatureDto })
  @ApiResponse({ status: 200, description: 'Firma actualizada correctamente', type: SignatureUpdateReponse })
  @ApiResponse({ status: 401, description: 'API Key inválida o no proporcionada' })
  @ApiResponse({ status: 404, description: 'No existe una firma registrada con el UUID proporcionado', type: NotFoundResponse })
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'signatureImage', maxCount: 1 },
      { name: 'officialFile', maxCount: 1 },
    ]),
  )
  update(
    @Param('id') id: string,
    @UploadedFiles()
    files: { signatureImage?: Express.Multer.File[]; officialFile?: Express.Multer.File[] },
  ) {
    const fileFirma = files?.signatureImage?.[0];
    const fileIne = files?.officialFile?.[0];
    return this.signatureService.update(id, {
      signatureImage: fileFirma,
      officialFile: fileIne,
    });
  }

  @Patch(':id/deactivate')
  @ApiOperation({ summary: 'Desactivar la firma de un usuario reemplazándola por una imagen en blanco' })
  @ApiParam({ name: 'id', description: 'Identificador único de la firma a desactivar en formato UUID v4', format: 'uuid', example: '8c388293-6f5e-4e61-8c96-ae36c2fa6faa' })
  @ApiResponse({ status: 200, description: 'Firma desactivada correctamente. La imagen de firma es reemplazada por un PNG en blanco y la identificación oficial se conserva', type: SignatureDeactivateResponse })
  @ApiResponse({ status: 401, description: 'API Key inválida o no proporcionada' })
  @ApiResponse({ status: 404, description: 'No existe una firma registrada con el UUID proporcionado', type: NotFoundResponse })
  deactivate(@Param('id') id: string) {
    return this.signatureService.deactivate(id);
  }
}