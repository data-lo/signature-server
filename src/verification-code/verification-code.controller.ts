// NestJS Core
import { Controller, Post, Body, HttpCode, HttpStatus, UseInterceptors, Req } from '@nestjs/common';

// Swagger
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

// Decorators
import { Public } from 'src/auth/decorators/public.decorator';

// Throttler
import { SkipThrottle, Throttle } from '@nestjs/throttler';

// Interceptors
import { IpInterceptor } from 'src/ip/ip.interceptor';

// DTOs
import { CreateVerificationCodeDto } from './dto/create-verification-code.dto';
import { ValidateCodeDto } from './dto/validate-code.dto';

// Services
import { VerificationCodeService } from './verification-code.service';

@ApiTags('Código de Verificación')
@Controller('verification-code')
export class VerificationCodeController {
  constructor(private readonly verificationCodeService: VerificationCodeService) {}

  @Public()
  @Post('generate')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 3, ttl: 60 * 1000 } })
  @ApiOperation({ summary: 'Genera y envía un código OTP al firmante del documento' })
  @ApiBody({ type: CreateVerificationCodeDto })
  @ApiResponse({ status: 201, description: 'Código OTP generado y enviado correctamente' })
  @ApiResponse({ status: 400, description: 'Datos de entrada inválidos' })
  @ApiResponse({ status: 403, description: 'El firmante no está asociado al documento' })
  @ApiResponse({ status: 404, description: 'Documento no encontrado' })
  generate(@Body() dto: CreateVerificationCodeDto) {
    return this.verificationCodeService.create(dto);
  }

  @Public()
  @SkipThrottle()
  @Post('validate')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(IpInterceptor)
  @ApiOperation({ summary: 'Valida el código OTP enviado por el firmante' })
  @ApiBody({ type: ValidateCodeDto })
  @ApiResponse({ status: 200, description: 'Código validado correctamente, documento en procesamiento' })
  @ApiResponse({ status: 400, description: 'Datos de entrada inválidos' })
  @ApiResponse({ status: 401, description: 'Código de verificación inválido' })
  @ApiResponse({ status: 403, description: 'El firmante no está asociado al documento' })
  @ApiResponse({ status: 404, description: 'Código de verificación no encontrado o expirado' })
  validate(@Body() dto: ValidateCodeDto, @Req() req: Request) {
    return this.verificationCodeService.validateAndSaveCode(dto, req['ip']);
  }
}