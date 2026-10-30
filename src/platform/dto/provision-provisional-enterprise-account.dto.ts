import { Transform, Type } from 'class-transformer';
import {
  IsDate,
  IsDefined,
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import {
  API_KEY_NAME_MAX_LENGTH,
  trimText,
} from 'src/api-key/dto/create-organization-api-key.dto';

import { MAX_PROVISIONED_DOCUMENTS_GRANTED } from '../constants/provisioning-billing.constants';

/** Largo máximo de los textos libres del aprovisionamiento. */
const TEXT_MAX_LENGTH = 255;

/**
 * Normaliza un correo: sin espacios y en minúsculas, como se guarda en `users.email`.
 *
 * @param params - El valor recibido, envuelto por `class-transformer`.
 * @returns El correo normalizado, o el valor original si no es texto.
 *
 * @example
 * ```ts
 * normalizeEmail({ value: ' Ana@Acme.TEST ' }); // 'ana@acme.test'
 * ```
 */
export function normalizeEmail({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

/** La organización que se crea. */
export class ProvisionOrganizationDto {
  /** Nombre de visualización (`organizations.display_name`). */
  @Transform(trimText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(TEXT_MAX_LENGTH)
  name: string;

  /** Razón social (`organizations.name`). */
  @Transform(trimText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(TEXT_MAX_LENGTH)
  organizationName: string;

  /** Identificador fiscal (en México, el RFC). */
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(20)
  taxId?: string;

  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(TEXT_MAX_LENGTH)
  domainAllowed?: string;
}

/** El propietario: se crea (o se reutiliza) como usuario `PROVISIONED`, sin contraseña. */
export class ProvisionOwnerDto {
  @Transform(trimText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(TEXT_MAX_LENGTH)
  firstName: string;

  @Transform(trimText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(TEXT_MAX_LENGTH)
  lastName: string;

  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(TEXT_MAX_LENGTH)
  email: string;
}

/**
 * El periodo manual. Plan (`enterprise`), importe (0) y moneda (`mxn`) los fija el backend.
 */
export class ProvisionBillingDto {
  /** Documentos a acreditar; 1600 si se omite. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PROVISIONED_DOCUMENTS_GRANTED)
  documentsGranted?: number;

  @Type(() => Date)
  @IsDate()
  periodStart: Date;

  @Type(() => Date)
  @IsDate()
  periodEnd: Date;

  /** Folio del periodo; único en todos los periodos manuales de la plataforma. */
  @Transform(trimText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(TEXT_MAX_LENGTH)
  externalReference: string;
}

/**
 * `POST /api/v1/platform/organizations/provision`.
 *
 * No declara `planType`, `permissionIds` ni nada que decida el backend: el controller rechaza esos
 * campos con 400 (`ProvisioningReservedFieldsException`) en vez de dejar que `whitelist` los
 * descarte en silencio.
 */
export class ProvisionProvisionalEnterpriseAccountDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => ProvisionOrganizationDto)
  organization: ProvisionOrganizationDto;

  @IsDefined()
  @ValidateNested()
  @Type(() => ProvisionOwnerDto)
  owner: ProvisionOwnerDto;

  @IsDefined()
  @ValidateNested()
  @Type(() => ProvisionBillingDto)
  billing: ProvisionBillingDto;

  /** Nombre administrativo de la API key. */
  @Transform(trimText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(API_KEY_NAME_MAX_LENGTH)
  apiKeyName: string;
}
