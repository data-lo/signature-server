import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class UpdateUserStatusDto {
  @ApiProperty({
    example: true,
    description:
      'Marca la consolidación del onboarding. Este endpoint siempre fija isConfigured=true en el servidor; el valor aquí es solo para simetría documental de la API.',
  })
  @IsBoolean()
  isConfigured: boolean;
}
