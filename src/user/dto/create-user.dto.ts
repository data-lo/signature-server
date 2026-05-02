import {
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

import { UserRoles } from '../interfaces/user.roles.enum';

export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  firstName: string;

  @IsString()
  @IsNotEmpty()
  lastName: string;

  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsOptional()
  @IsString()
  position?: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @IsEnum(UserRoles, { each: true })
  rol: string[];

  @IsString()
  @IsNotEmpty()
  curp: string;
}
