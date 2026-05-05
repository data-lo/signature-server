import { Body, Controller, ForbiddenException, Get, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from 'src/auth/decorators/public.decorator';
import { EmailService } from 'src/shared/email/email.service';
import { VerificationCodeService } from './verification-code.service';
import { CreateVerificationCodeDto } from './dto/create-verification-code.dto';
import { VerifyVerificationCodeDto } from './dto/verify-verification-code.dto';

@ApiTags('Verification Code')
@ApiBearerAuth("API Key")
@Controller('verification-code')
export class VerificationCodeController {
  constructor(
    private readonly verificationCodeService: VerificationCodeService,
    private readonly emailService: EmailService
  ) { }



  // @Public()
  // @Post()
  // @ApiOperation({ summary: 'Generar y enviar código OTP al firmante' })
  // @ApiResponse({ status: 201, description: 'Código OTP generado. Retorna el código de 6 dígitos para enviarlo por correo.' })
  // @ApiResponse({ status: 400, description: 'Datos de entrada inválidos' })
  // create(@Body() dto: CreateVerificationCodeDto) {
  //   return this.verificationCodeService.create(dto);
  // }

  // @Public()
  // @Post('verify')
  // @ApiOperation({ summary: 'Verificar código OTP ingresado por el firmante' })
  // @ApiResponse({ status: 201, description: 'Retorna true si el código es válido, false si expiró o no coincide' })
  // @ApiResponse({ status: 400, description: 'Datos de entrada inválidos' })
  // verify(@Body() dto: VerifyVerificationCodeDto, @Req() req: Request) {
  //   const ipAddress = req['ipAddress'] ?? req.ip;
  //   return this.verificationCodeService.verifyCode(dto, ipAddress);
  // }

  // @Public()
  // @Get('signer/:signerId')
  // @ApiOperation({ summary: 'Consultar historial de códigos OTP por firmante' })
  // @ApiParam({ name: 'signerId', description: 'UUID del firmante', format: 'uuid' })
  // @ApiResponse({ status: 200, description: 'Historial de códigos del firmante, ordenado del más reciente al más antiguo' })
  // findBySigner(@Param('signerId') signerId: string) {
  //   return this.verificationCodeService.findBySigner(signerId);
  // }

  // @Public()
  // @Get('document/:documentId')
  // @ApiOperation({ summary: 'Consultar historial de códigos OTP por documento' })
  // @ApiParam({ name: 'documentId', description: 'UUID del documento', format: 'uuid' })
  // @ApiResponse({ status: 200, description: 'Historial de códigos del documento, ordenado del más reciente al más antiguo' })
  // findByDocument(@Param('documentId') documentId: string) {
  //   return this.verificationCodeService.findByDocument(documentId);
  // }
}
