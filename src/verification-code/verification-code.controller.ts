import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { VerificationCodeService } from './verification-code.service';
import { CreateVerificationCodeDto } from './dto/create-verification-code.dto';
import { VerifyVerificationCodeDto } from './dto/verify-verification-code.dto';

@Controller('verification-code')
export class VerificationCodeController {
  constructor(private readonly verificationCodeService: VerificationCodeService) {}

  @Post()
  create(@Body() dto: CreateVerificationCodeDto) {
    return this.verificationCodeService.create(dto);
  }

  @Post('verify')
  verify(@Body() dto: VerifyVerificationCodeDto, @Req() req: Request) {
    const ipAddress = req['ipAddress'] ?? req.ip;
    return this.verificationCodeService.verifyCode(dto, ipAddress);
  }

  @Get('signer/:signerId')
  findBySigner(@Param('signerId') signerId: string) {
    return this.verificationCodeService.findBySigner(signerId);
  }

  @Get('document/:documentId')
  findByDocument(@Param('documentId') documentId: string) {
    return this.verificationCodeService.findByDocument(documentId);
  }
}
