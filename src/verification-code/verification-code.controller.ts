import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { VerificationCodeService } from './verification-code.service';
import { CreateVerificationCodeDto } from './dto/create-verification-code.dto';
import { UpdateVerificationCodeDto } from './dto/update-verification-code.dto';

@Controller('verification-code')
export class VerificationCodeController {
  constructor(private readonly verificationCodeService: VerificationCodeService) {}

  @Post()
  create(@Body() createVerificationCodeDto: CreateVerificationCodeDto) {
    return this.verificationCodeService.create(createVerificationCodeDto);
  }

  @Get()
  findAll() {
    return this.verificationCodeService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.verificationCodeService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateVerificationCodeDto: UpdateVerificationCodeDto) {
    return this.verificationCodeService.update(+id, updateVerificationCodeDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.verificationCodeService.remove(+id);
  }
}
