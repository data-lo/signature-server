import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { PLAN_ID_ENUM } from '../enums/plan-id.enum';

export class CreateCheckoutSessionDto {
  @ApiProperty({
    example: PLAN_ID_ENUM.PRO,
    description: 'Identificador interno del plan',
    enum: PLAN_ID_ENUM,
  })
  @IsEnum(PLAN_ID_ENUM)
  planId: PLAN_ID_ENUM;
}
