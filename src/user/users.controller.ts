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

// Use cases
import { UploadSignatureImageUseCase } from 'src/signature/applications/upload-signature-image.use-case';
import { CheckRfcAvailabilityUseCase } from './applications/check-rfc-availability.use-case';
import { GetMyProfileUseCase } from './applications/get-my-profile.use-case';
import { UpdateMyPersonalInformationUseCase } from './applications/update-my-personal-information.use-case';
import { CompleteMyOnboardingUseCase } from './applications/complete-my-onboarding.use-case';

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
    private readonly checkRfcAvailability: CheckRfcAvailabilityUseCase,
    private readonly getMyProfile: GetMyProfileUseCase,
    private readonly updateMyPersonalInformation: UpdateMyPersonalInformationUseCase,
    private readonly uploadSignatureImage: UploadSignatureImageUseCase,
    private readonly completeMyOnboarding: CompleteMyOnboardingUseCase,
  ) {}

  @Get('check-rfc')
  @SkipJwtAuth()
  @ApiCheckRfcAvailability()
  checkRfc(@Query('rfc') rfc: string) {
    return this.checkRfcAvailability.execute(rfc);
  }

  @Get('me')
  @ApiGetMyProfile()
  getMe(@CurrentUser() user: JwtPayload) {
    return this.getMyProfile.execute(user.nationalId);
  }

  @Put('me/personal-information')
  @ApiUpdateMyPersonalInformation()
  updatePersonalInformation(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdatePersonalInformationDto,
  ) {
    return this.updateMyPersonalInformation.execute(user.sub, dto);
  }

  /**
   * El caso de uso valida el estado de la credencial, delega el manejo de archivos en
   * `SignatureService` y deja al usuario en CONFIGURED. Ese cambio de estado ya invalida el
   * snapshot de perfil en Redis, así que acá no hace falta refrescar el cache.
   */
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
  updateSignature(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateSignatureDto,
    @UploadedFiles()
    files: {
      signatureImage?: Express.Multer.File[];
      officialFile?: Express.Multer.File[];
    },
  ) {
    return this.uploadSignatureImage.execute(user.sub, dto, files);
  }

  @Patch('me/status')
  @ApiCompleteMyOnboarding()
  updateStatus(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateUserStatusDto,
  ) {
    return this.completeMyOnboarding.execute(user.sub, dto);
  }
}
