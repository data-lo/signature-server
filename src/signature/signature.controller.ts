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

import { GetSignatureFileUseCase } from './applications/get-signature-file.use-case';
import { GetSignatureUseCase } from './applications/get-signature.use-case';
import { UpdateSignatureUseCase } from './applications/update-signature.use-case';
import { DeactivateSignatureUseCase } from './applications/deactivate-signature.use-case';
import { DeleteSignatureImageUseCase } from './applications/delete-signature-image.use-case';
import { DeleteOfficialFileUseCase } from './applications/delete-official-file.use-case';

import { Public } from 'src/auth/decorators/public.decorator';
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';

import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';

import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';
import { MAX_UPLOAD_SAFETY_NET_BYTES } from 'src/shared/constants/file-upload.constants';

import { ApiGetSignatureFile } from './docs/api-get-signature-file.docs';
import { ApiGetSignature } from './docs/api-get-signature.docs';
import { ApiUpdateSignature } from './docs/api-update-signature.docs';
import { ApiDeactivateSignature } from './docs/api-deactivate-signature.docs';
import { ApiDeleteSignatureImage } from './docs/api-delete-signature-image.docs';
import { ApiDeleteOfficialFile } from './docs/api-delete-official-file.docs';

/**
 * El controller sólo traduce HTTP: cada endpoint delega en un caso de uso de `applications/`.
 */
@ApiTags('Signature')
@ApiBearerAuth('access-token')
@Controller('signature')
export class SignatureController {
  constructor(
    private readonly getSignatureFile: GetSignatureFileUseCase,
    private readonly getSignature: GetSignatureUseCase,
    private readonly updateSignature: UpdateSignatureUseCase,
    private readonly deactivateSignature: DeactivateSignatureUseCase,
    private readonly deleteSignatureImage: DeleteSignatureImageUseCase,
    private readonly deleteOfficialFile: DeleteOfficialFileUseCase,
  ) {}

  @Public()
  @Get('files/:fileId')
  @ApiGetSignatureFile()
  async getFile(
    @Param('fileId') objectKey: string,
    @Body('bucketType') bucketType: BUCKET_TYPES_ENUM,
  ) {
    return await this.getSignatureFile.execute(objectKey, bucketType);
  }

  @Public()
  @Get(':id')
  @ApiGetSignature()
  findOne(@Param('id') id: string) {
    return this.getSignature.execute(id);
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
    return this.updateSignature.execute(id, user.sub, {
      signatureImage: files?.signatureImage?.[0],
      officialFile: files?.officialFile?.[0],
    });
  }

  @Patch(':id/deactivate')
  @ApiDeactivateSignature()
  deactivate(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.deactivateSignature.execute(id, user.sub);
  }

  @Delete(':id/signature-image')
  @ApiDeleteSignatureImage()
  deleteSignatureImageEndpoint(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    return this.deleteSignatureImage.execute(id, user.sub);
  }

  @Delete(':id/official-file')
  @ApiDeleteOfficialFile()
  deleteOfficialFileEndpoint(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    return this.deleteOfficialFile.execute(id, user.sub);
  }
}
