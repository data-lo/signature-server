import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse } from '../../../interfaces/api-response.dto';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from '../../enums/signing-credential-status.enum';

export class UserMePersonalInformationData {
  @ApiProperty({ example: 'PELJ850101ABC', nullable: true })
  rfc: string | null;

  @ApiProperty({ example: '5512345678', nullable: true })
  phoneNumber: string | null;

  @ApiProperty({ example: 'juan.perez@personal.com', nullable: true })
  secondaryEmail: string | null;
}

export class UserMeData {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Juan' })
  firstName: string;

  @ApiProperty({ example: 'Pérez López' })
  lastName: string;

  @ApiProperty({ example: 'juan.perez@empresa.com' })
  email: string;

  @ApiProperty({ example: ['signer'], isArray: true })
  roles: string[];

  @ApiProperty({ example: 'PELJ850101HDFRNN08' })
  nationalId: string;

  @ApiProperty({
    example: false,
    description: 'true cuando el usuario completó el onboarding',
  })
  isConfigured: boolean;

  @ApiProperty({ format: 'uuid', nullable: true })
  signatureId: string | null;

  @ApiProperty({
    enum: SIGNING_CREDENTIAL_STATUS_ENUM,
    example: SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_REQUIRED,
    description:
      'Avance de identidad y firma. Sólo lo escribe el backend: el frontend lo usa para habilitar o deshabilitar la UI.',
  })
  signingCredentialStatus: SIGNING_CREDENTIAL_STATUS_ENUM;

  @ApiProperty({
    example: false,
    description:
      'Derivada de signingCredentialStatus === CONFIGURED. La credencial está lista para firmar.',
  })
  signingCredentialConfigured: boolean;

  @ApiProperty({
    example: null,
    nullable: true,
    description: 'Momento en que el proveedor aprobó la identidad del usuario.',
  })
  identityVerifiedAt: Date | null;

  @ApiProperty({ type: UserMePersonalInformationData })
  personalInformation: UserMePersonalInformationData;

  @ApiProperty({ example: '2026-07-15T12:00:00.000Z' })
  updatedAt: string;
}

export class UserMeResponse extends BaseResponse<UserMeData> {
  @ApiProperty({ type: UserMeData })
  data: UserMeData;
}
