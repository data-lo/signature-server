// NestJS core
import {
  Body,
  Controller,
  Get,
  Patch,
  Put,
  Query,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';

// Swagger
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

// Auth
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { SkipJwtAuth } from 'src/auth/decorators/skip-jwt-auth.decorator';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';
import { MAX_UPLOAD_SAFETY_NET_BYTES } from 'src/shared/constants/file-upload.constants';

// Services
import { UserService } from './user.service';
import { SignatureService } from 'src/signature/signature.service';

// DTOs
import { UpdatePersonalInformationDto } from './dto/update-personal-information.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { CreateSignatureDto } from 'src/signature/dto/create-signature.dto';

// Docs
import { ApiCheckRfcAvailability } from './docs/api-check-rfc-availability.docs';
import { ApiGetMyProfile } from './docs/api-get-my-profile.docs';
import { ApiUpdateMyPersonalInformation } from './docs/api-update-my-personal-information.docs';
import { ApiRegisterMySignature } from './docs/api-register-my-signature.docs';
import { ApiCompleteMyOnboarding } from './docs/api-complete-my-onboarding.docs';

@ApiTags('Users')
@ApiBearerAuth('access-token')
@Controller('api/v1/users')
export class UsersController {
  constructor(
    private readonly userService: UserService,
    private readonly signatureService: SignatureService,
  ) {}

  @Get('check-rfc')
  @SkipJwtAuth()
  @ApiCheckRfcAvailability()
  checkRfc(@Query('rfc') rfc: string) {
    return this.userService.checkRfcAvailability(rfc);
  }

  @Get('me')
  @ApiGetMyProfile()
  getMe(@CurrentUser() user: JwtPayload) {
    return this.userService.getMeFromCache(user.nationalId);
  }

  @Put('me/personal-information')
  @ApiUpdateMyPersonalInformation()
  updatePersonalInformation(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdatePersonalInformationDto,
  ) {
    return this.userService.updatePersonalInformation(user.sub, dto);
  }

  @Put('me/signature')
  @ApiRegisterMySignature()
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'signatureImage', maxCount: 1 },
        { name: 'officialFile', maxCount: 1 },
      ],
      { limits: { fileSize: MAX_UPLOAD_SAFETY_NET_BYTES } },
    ),
  )
  async updateSignature(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateSignatureDto,
    @UploadedFiles()
    files: {
      signatureImage?: Express.Multer.File[];
      officialFile?: Express.Multer.File[];
    },
  ) {
    const result = await this.signatureService.create(user.sub, dto, files);
    await this.userService.refreshCurpCacheForUser(user.sub);
    return result;
  }

  @Patch('me/status')
  @ApiCompleteMyOnboarding()
  updateStatus(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateUserStatusDto,
  ) {
    return this.userService.updateStatus(user.sub, dto);
  }
}
