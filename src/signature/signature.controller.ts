import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseInterceptors,
  UploadedFiles,
} from '@nestjs/common';
import { SignatureService } from './signature.service';
import { CreateSignatureDto } from './dto/create-signature.dto';
import { UpdateSignatureDto } from './dto/update-signature.dto';
import { MinioService } from 'src/shared/minio/minio.service';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';

@ApiTags('Signature')
@ApiBearerAuth('access-token')
@Controller('signature')
export class SignatureController {
  constructor(
    private readonly signatureService: SignatureService,
    private readonly minioService: MinioService,
  ) {}

  @Get('files/:fileId')
  async getFile(
    @Param('fileId') fileId: string,
    @Body('documentType') bucketType:BUCKET_TYPES_ENUM,
  ) {
    return await this.minioService.getFile(fileId, bucketType); 
  }
  
  @Patch(':id')
  @UseInterceptors(FileInterceptor('file'))
  updateFile(
    @Param('id') id: string,
    @Body() updateSignatureDto: UpdateSignatureDto,
  ) {
    return this.signatureService.update(+id, updateSignatureDto);
  }
  
  @Post()
  @UseInterceptors(FilesInterceptor('files',2))
  async create(
    @UploadedFiles() files: Array<Express.Multer.File>,
    @Body() createSignatureDto: CreateSignatureDto,
  ) {

    let responses = [];
    const { signatureFile, oficialCardPdfFile } =
      this.minioService.checkSignatureFileObjects(files);

    if (signatureFile) {
      responses.push(
        await this.minioService.uploadObject(
          { file: signatureFile, name: signatureFile.originalname },
          'signature_images',
        ),
      );
    }

    if (oficialCardPdfFile) {
      responses.push(
        await this.minioService.uploadObject(
          { file: oficialCardPdfFile, name: oficialCardPdfFile.originalname },
          'oficial_cards',
        ),
      );
    }
    return responses;
    //return this.signatureService.create(createSignatureDto);
  }




  @Get()
  findAll() {
    return this.signatureService.findAll();
  }

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
  update(
    @Param('id') id: string,
    @Body() updateSignatureDto: UpdateSignatureDto,
  ) {
    return this.signatureService.update(+id, updateSignatureDto);
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
