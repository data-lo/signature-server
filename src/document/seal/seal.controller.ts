import { Body, Controller, Post } from '@nestjs/common';

import { SealDocumentDto } from './dto/seal-document.dto';
import { SealDocumentUseCase } from './use-cases/seal-document.use-case';

@Controller('seal')
export class SealController {
  constructor(private readonly sealDocumentUseCase: SealDocumentUseCase) {}

  @Post()
  create(@Body() sealDocumentDto: SealDocumentDto) {
    return this.sealDocumentUseCase.create(sealDocumentDto);
  }
}
