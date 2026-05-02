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

@Controller('signature')
export class SignatureController {
  constructor(
    private readonly signatureService: SignatureService,
    private readonly minioService: MinioService,
  ) {}

  @Post()
  @UseInterceptors(FilesInterceptor('files',2))
  async create(
    @UploadedFiles() files: Array<Express.Multer.File>,
    @Body() createSignatureDto: CreateSignatureDto,
  ) {

    let responses = [];
    const { signatureFile, oficialCardPdfFile } =
      this.minioService.checkFileObjects(files);

    if (signatureFile) {
      responses.push(
        await this.minioService.uploadObject(
          { file: signatureFile, name: signatureFile.originalname },
          'signatures_images',
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

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.signatureService.findOne(+id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateSignatureDto: UpdateSignatureDto,
  ) {
    return this.signatureService.update(+id, updateSignatureDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.signatureService.remove(+id);
  }
}
