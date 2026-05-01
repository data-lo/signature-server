import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  lastname: string;

  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsOptional()
  @IsString()
  position?: string;

  @IsString()
  @IsNotEmpty()
  signatureId: string;

  @IsBoolean()
  isActive: boolean;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  rol: string[];

  @IsString()
  @IsNotEmpty()
  curp: string;
}
