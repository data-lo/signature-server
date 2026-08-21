// External dependencies
import {
  Controller,
  Get,
  Body,
  Patch,
  Delete,
  Param,
  UseInterceptors,
  UploadedFiles,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

// Services
import { SignatureService } from './signature.service';

// Decorators
import { Public } from 'src/auth/decorators/public.decorator';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';

// Enums
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';

// Interfaces
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';
import { MAX_UPLOAD_SAFETY_NET_BYTES } from 'src/shared/constants/file-upload.constants';

// Docs
import { ApiGetSignatureFile } from './docs/api-get-signature-file.docs';
import { ApiGetSignature } from './docs/api-get-signature.docs';
import { ApiUpdateSignature } from './docs/api-update-signature.docs';
import { ApiDeactivateSignature } from './docs/api-deactivate-signature.docs';
import { ApiDeleteSignatureImage } from './docs/api-delete-signature-image.docs';
import { ApiDeleteOfficialFile } from './docs/api-delete-official-file.docs';

@ApiTags('Signature')
@ApiBearerAuth('access-token')
@Controller('signature')
export class SignatureController {
  constructor(private readonly signatureService: SignatureService) {}

  @Public()
  @Get('files/:fileId')
  @ApiGetSignatureFile()
  async getFile(
    @Param('fileId') objectKey: string,
    @Body('bucketType') bucketType: BUCKET_TYPES_ENUM,
  ) {
    return await this.signatureService.getFile(objectKey, bucketType);
  }

  @Public()
  @Get(':id')
  @ApiGetSignature()
  findOne(@Param('id') id: string) {
    return this.signatureService.findOne(id);
  }

  @Patch(':id')
  @ApiUpdateSignature()
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'signatureImage', maxCount: 1 },
        { name: 'officialFile', maxCount: 1 },
      ],
      { limits: { fileSize: MAX_UPLOAD_SAFETY_NET_BYTES } },
    ),
  )
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @UploadedFiles()
    files: {
      signatureImage?: Express.Multer.File[];
      officialFile?: Express.Multer.File[];
    },
  ) {
    const fileFirma = files?.signatureImage?.[0];
    const fileIne = files?.officialFile?.[0];
    return this.signatureService.update(id, user.sub, {
      signatureImage: fileFirma,
      officialFile: fileIne,
    });
  }

  @Patch(':id/deactivate')
  @ApiDeactivateSignature()
  deactivate(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.signatureService.deactivate(id, user.sub);
  }

  @Delete(':id/signature-image')
  @ApiDeleteSignatureImage()
  deleteSignatureImage(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    return this.signatureService.deleteSignatureImage(id, user.sub);
  }

  @Delete(':id/official-file')
  @ApiDeleteOfficialFile()
  deleteOfficialFile(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.signatureService.deleteOfficialFile(id, user.sub);
  }
}
