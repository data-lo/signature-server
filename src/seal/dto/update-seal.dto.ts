import { PartialType } from '@nestjs/swagger';
import { CreateSealDto } from './create-seal.dto';

export class UpdateSealDto extends PartialType(CreateSealDto) {}
