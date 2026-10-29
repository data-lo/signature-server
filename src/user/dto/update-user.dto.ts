import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateUserDto } from './create-user.dto';

// nationalId (CURP) no es editable: es un campo de identidad, se fija solo al crear el usuario.
export class UpdateUserDto extends PartialType(
  OmitType(CreateUserDto, ['nationalId'] as const),
) {}
