// NestJS core
import {
  Body,
  Controller,
  Get,
  Patch,
  Put,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';

// Swagger
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

// Auth
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';

// Services
import { UserService } from './user.service';
import { SignatureService } from 'src/signature/signature.service';

// DTOs
import { UpdatePersonalInformationDto } from './dto/update-personal-information.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { CreateSignatureDto } from 'src/signature/dto/create-signature.dto';
import { SignatureCreateResponse } from 'src/signature/interfaces/signature-create-response';
import { PersonalInformationResponse } from './interfaces/response/personal-information-response';
import { UserMeResponse } from './interfaces/response/user-me-response';
import {
  BadRequestResponse,
  NotFoundResponse,
} from 'src/interfaces/api-response.dto';

@ApiTags('Users')
@ApiBearerAuth('access-token')
@Controller('api/v1/users')
export class UsersController {
  constructor(
    private readonly userService: UserService,
    private readonly signatureService: SignatureService,
  ) {}

  @Get('me')
  @ApiOperation({
    summary: 'Obtener el perfil cacheado del usuario autenticado',
    description:
      'Lee desde Redis DB 0 (key = CURP) el snapshot unificado de User + PersonalInformation para inicializar el store de onboarding en el cliente',
  })
  @ApiResponse({
    status: 200,
    description: 'Perfil obtenido correctamente',
    type: UserMeResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  @ApiResponse({
    status: 404,
    description: 'Usuario no encontrado',
    type: NotFoundResponse,
  })
  getMe(@CurrentUser() user: JwtPayload) {
    return this.userService.getMeFromCache(user.nationalId);
  }

  @Put('me/personal-information')
  @ApiOperation({
    summary: 'Actualizar información personal del usuario autenticado',
    description:
      'Actualiza en PostgreSQL los campos pendientes (teléfono, correo secundario) de onboarding. El usuario se identifica mediante el JWT.',
  })
  @ApiResponse({
    status: 200,
    description: 'Información personal actualizada correctamente',
    type: PersonalInformationResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  @ApiResponse({
    status: 404,
    description: 'Usuario no encontrado',
    type: NotFoundResponse,
  })
  updatePersonalInformation(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdatePersonalInformationDto,
  ) {
    return this.userService.updatePersonalInformation(user.sub, dto);
  }

  @Put('me/signature')
  @ApiOperation({
    summary: 'Registrar la firma digital del usuario autenticado',
    description:
      'Recibe la imagen PNG de la firma (y opcionalmente la identificación oficial), la almacena y vincula el signatureId en el usuario',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: CreateSignatureDto })
  @ApiResponse({
    status: 201,
    description: 'Firma registrada y asignada al usuario correctamente',
    type: SignatureCreateResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'Datos inválidos o imagen de firma no proporcionada',
    type: BadRequestResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'signatureImage', maxCount: 1 },
      { name: 'officialFile', maxCount: 1 },
    ]),
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
  @ApiOperation({
    summary: 'Consolidar el estado de onboarding del usuario autenticado',
    description:
      'Marca isConfigured=true de forma atómica en PostgreSQL y refresca el cache unificado en Redis. El usuario se identifica mediante el JWT.',
  })
  @ApiResponse({
    status: 200,
    description: 'Estado de configuración actualizado correctamente',
  })
  @ApiResponse({
    status: 401,
    description: 'Token de autenticación inválido, expirado o no proporcionado',
  })
  @ApiResponse({
    status: 404,
    description: 'Usuario no encontrado',
    type: NotFoundResponse,
  })
  updateStatus(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateUserStatusDto,
  ) {
    return this.userService.updateStatus(user.sub, dto);
  }
}
