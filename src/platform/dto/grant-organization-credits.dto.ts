import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { trimText } from 'src/api-key/dto/create-organization-api-key.dto';

import {
  CREDIT_GRANT_NOTES_MAX_LENGTH,
  MAX_CREDIT_GRANT_DOCUMENTS,
} from '../constants/credit-grant.constants';

/** `POST /api/v1/platform/organizations/:organizationId/credits`. */
export class GrantOrganizationCreditsDto {
  /** Documentos a acreditar. */
  @IsInt()
  @Min(1)
  @Max(MAX_CREDIT_GRANT_DOCUMENTS)
  documentsGranted: number;

  /** Folio de la recarga; único en todas las recargas de la plataforma. */
  @Transform(trimText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  externalReference: string;

  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(CREDIT_GRANT_NOTES_MAX_LENGTH)
  notes?: string;
}
