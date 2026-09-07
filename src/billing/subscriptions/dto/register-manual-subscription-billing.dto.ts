import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDate,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Alta de un periodo cobrado fuera de la plataforma.
 *
 * La regla de que haga falta `externalReference` **o** `createdByUserId` NO se declara aquí sino
 * en `RegisterSubscriptionBillingUseCase`: `class-validator` sólo mira los campos de este DTO, y
 * la misma regla tiene que valer también para el adaptador de Stripe, que no pasa por ningún DTO.
 * Dejarla en un solo sitio evita que las dos versiones se separen.
 */
export class RegisterManualSubscriptionBillingDto {
  @ApiProperty({
    description:
      'Perfil de facturación al que se acredita el periodo. Sirve igual para una cuenta personal que para una organización: el perfil ya sabe de quién es.',
  })
  @IsUUID()
  billingProfileId: string;

  @ApiProperty({
    example: 'plus',
    description:
      'Plan que cubre el periodo. Debe existir en el catálogo local (`plans.plan_type`).',
    maxLength: 64,
  })
  @IsString()
  @MaxLength(64)
  planType: string;

  @ApiProperty({
    example: 149900,
    description:
      'Importe cobrado en la unidad mínima de la moneda (centavos), igual que en Stripe y en checkout_orders. Se admite 0 para una cortesía o un periodo de gracia.',
  })
  @IsInt()
  @Min(0)
  amount: number;

  @ApiProperty({
    example: 'mxn',
    description:
      'Código ISO de tres letras. Se normaliza a minúsculas para que coincida con lo que entrega Stripe y los reportes no separen "MXN" de "mxn".',
  })
  @IsString()
  @Length(3, 3)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  currency: string;

  @ApiProperty({
    example: '2026-09-01T00:00:00.000Z',
    description: 'Inicio del periodo que cubre el cobro.',
  })
  @Type(() => Date)
  @IsDate()
  periodStart: Date;

  @ApiProperty({
    example: '2026-10-01T00:00:00.000Z',
    description:
      'Fin del periodo. Es la fecha con la que el cron de expiración devolverá el perfil a Free si nadie renueva antes.',
  })
  @Type(() => Date)
  @IsDate()
  periodEnd: Date;

  @ApiPropertyOptional({
    example: 100,
    description:
      'Documentos a acreditar. Si se omite, los que declare el plan — que es lo normal; sólo se manda para un acuerdo particular.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  documentsGranted?: number;

  @ApiPropertyOptional({
    example: '2026-09-02T15:30:00.000Z',
    description:
      'Cuándo entró el dinero. Por omisión, ahora. Se manda cuando la captura es posterior al ingreso, para que el corte de caja no lo cuente en el día equivocado.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  paidAt?: Date;

  @ApiPropertyOptional({
    example: 'TRF-2026-4471',
    description:
      'Folio interno, referencia de la transferencia o número de la factura emitida. Es además la clave que impide registrar dos veces el mismo cobro en este perfil, así que conviene que sea el identificador real del movimiento.',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  externalReference?: string;

  @ApiPropertyOptional({
    description:
      'Usuario interno que registra el cobro. Obligatorio si no se manda `externalReference`: una fila manual sin folio ni autor sería un plan regalado del que nadie responde.',
  })
  @IsOptional()
  @IsUUID()
  createdByUserId?: string;

  @ApiPropertyOptional({
    description: 'Contexto libre del cobro; no se usa para desduplicar.',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
