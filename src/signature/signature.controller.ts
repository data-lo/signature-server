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
import { SignatureService } from './signature.service';
import { CreateSignatureDto } from './dto/create-signature.dto';

@Controller('signature')
export class SignatureController {
  constructor(private readonly signatureService: SignatureService) {}

  /**
   * GET /signature/:id
   * Obtiene una firma por su UUID.
   */
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.signatureService.findOne(id);
  }

  /**
   * POST /signature
   * Crea una nueva firma para un usuario.
   * Body (multipart/form-data):
   *   - userId: UUID del usuario
   *   - createdBy: UUID del responsable (opcional)
   *   - imagen_firma: archivo PNG de la firma
   */
  @Post()
  @UseInterceptors(FileInterceptor('imagen_firma'))
  create(
    @Body() dto: CreateSignatureDto,
    @UploadedFile() signatureFile: Express.Multer.File,
  ) {
    return this.signatureService.create(dto, signatureFile);
  }

  /**
   * PATCH /signature/:id
   * Actualiza la imagen de firma y/o la imagen de INE de una firma existente.
   * Body (multipart/form-data):
   *   - imagen_firma: nuevo archivo PNG de la firma (opcional)
   *   - imagen_ine: nuevo archivo de la identificación oficial (opcional)
   */
  @Patch(':id')
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

  /**
   * PATCH /signature/:id/deactivate
   * Desactiva una firma: sobreescribe la imagen de firma con un PNG en blanco en Minio
   * y establece isActive en false. La imagen de INE se conserva.
   */
  @Patch(':id/deactivate')
  deactivate(@Param('id') id: string) {
    return this.signatureService.deactivate(id);
  }
}
