import { Injectable } from '@nestjs/common';
import { CreateVerificationCodeDto } from './dto/create-verification-code.dto';
import { UpdateVerificationCodeDto } from './dto/update-verification-code.dto';

@Injectable()
export class VerificationCodeService {
  create(createVerificationCodeDto: CreateVerificationCodeDto) {
    return 'This action adds a new verificationCode';
  }

  findAll() {
    return `This action returns all verificationCode`;
  }

  findOne(id: number) {
    return `This action returns a #${id} verificationCode`;
  }

  update(id: number, updateVerificationCodeDto: UpdateVerificationCodeDto) {
    return `This action updates a #${id} verificationCode`;
  }

  remove(id: number) {
    return `This action removes a #${id} verificationCode`;
  }
}
