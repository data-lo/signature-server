// NestJS Core
import { Controller, Post, Body, HttpCode, HttpStatus, UseInterceptors, Req } from '@nestjs/common';

// Swagger
import { ApiBody, ApiOperation, ApiResponse, ApiTags, ApiExcludeEndpoint } from '@nestjs/swagger';
import { ApiInvalidDataResponseDto, ApiForbiddenResponseDto, ApiNotFoundResponseDto, ApiUnauthorizedResponseDto } from 'src/interfaces/api-response.dto';

// Decorators
import { Public } from 'src/auth/decorators/public.decorator';

// DTOs
import { CreateVerificationCodeDto } from './dto/create-verification-code.dto';
import { VerificationCodeResponseDto } from './dto/verification-code-response.dto';

// Services
import { VerificationCodeService } from './verification-code.service';
import { IpInterceptor } from 'src/ip/ip.interceptor';
import { validateCodeDto } from './dto/validate-code.dto';


@ApiTags('Código de Verificación')
@Controller('verification-code')
export class VerificationCodeController {
    constructor(private readonly verificationCodeService: VerificationCodeService) { }

    @Public()
    @ApiExcludeEndpoint()
    @Post('generate')
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({ summary: 'Genera y envía un código OTP al firmante del documento' })
    @ApiBody({ type: CreateVerificationCodeDto })
    @ApiResponse({ status: 201, description: 'Código OTP generado y enviado correctamente', type: VerificationCodeResponseDto })
    @ApiResponse({ status: 400, description: 'Datos de entrada inválidos', type: ApiInvalidDataResponseDto })
    @ApiResponse({ status: 403, description: 'El firmante no está asociado al documento', type: ApiForbiddenResponseDto })
    generate(@Body() dto: CreateVerificationCodeDto) {
        return this.verificationCodeService.create(dto);
    }


    @Public()
    @ApiExcludeEndpoint()
    @Post('validate')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Valida el código OTP enviado por el firmante' })
    @ApiBody({ type: validateCodeDto })
    @ApiResponse({ status: 200, description: 'Código validado correctamente, documento en procesamiento' })
    @ApiResponse({ status: 400, description: 'Datos de entrada inválidos', type: ApiInvalidDataResponseDto })
    @ApiResponse({ status: 401, description: 'Código de verificación inválido', type: ApiUnauthorizedResponseDto })
    @ApiResponse({ status: 403, description: 'El firmante no está asociado al documento', type: ApiForbiddenResponseDto })
    @ApiResponse({ status: 404, description: 'Código de verificación no encontrado o expirado', type: ApiNotFoundResponseDto })
    @UseInterceptors(IpInterceptor)
    validate(@Body() dto: validateCodeDto, @Req() req: Request) {
      return this.verificationCodeService.validateAndSaveCode(dto, req['ip']);
    }
}
