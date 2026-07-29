import { PartialType } from '@nestjs/swagger';
import { CreateEfirmaDto } from './create-efirma.dto';

export class UpdateEfirmaDto extends PartialType(CreateEfirmaDto) {}
