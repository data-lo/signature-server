import { ApiProperty } from '@nestjs/swagger';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { BaseResponse } from '../../../interfaces/api-response.dto';

export class SignatureUrlDto {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'UUID de la firma',
    format: 'uuid',
  })
  id: string;

  @ApiProperty({
    example: 'https://storage.example.com/firma.png?token=...',
    description: 'URL segura de la firma',
  })
  secureUrl: string;

  @ApiProperty({
    example: 86400,
    description: 'Tiempo de expiración de la URL en segundos',
  })
  expiresIn: number;
}

export class UserGetData {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'UUID del usuario',
    format: 'uuid',
  })
  id: string;

  @ApiProperty({ example: 'JUAN', description: 'Nombre(s) del usuario' })
  firstName: string;

  @ApiProperty({ example: 'PÉREZ LÓPEZ', description: 'Apellidos del usuario' })
  lastName: string;

  @ApiProperty({
    example: 'juan.perez@empresa.com',
    description: 'Correo electrónico del usuario',
  })
  email: string;

  @ApiProperty({
    example: ['signer'],
    description: 'Roles asignados al usuario',
    type: [String],
  })
  roles: string[];

  @ApiProperty({
    example: 'PELJ850101HDFRNN08',
    description: 'Identificador nacional del usuario (CURP, 18 caracteres)',
    minLength: 18,
    maxLength: 18,
  })
  nationalId: string;

  @ApiProperty({
    example: '5512345678',
    description: 'Número de teléfono de contacto (información personal)',
    nullable: true,
  })
  phoneNumber: string | null;

  @ApiProperty({
    example: 'juan.perez@personal.com',
    description: 'Correo electrónico secundario (información personal)',
    nullable: true,
  })
  secondaryEmail: string | null;

  @ApiProperty({
    example: 'PELJ850101ABC',
    description: 'RFC del usuario (información personal)',
    nullable: true,
  })
  rfc: string | null;

  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'UUID de la firma asociada al usuario, si existe',
    format: 'uuid',
    nullable: true,
  })
  signatureId: string | null;

  /**
   * @deprecated Ya no controla el acceso a nada. Quedó como bandera de onboarding general
   * (datos personales) y ninguna pantalla la consulta para decidir si se puede crear un
   * documento o firmar: eso lo decide `signingCredentialStatus`.
   */
  @ApiProperty({
    example: false,
    deprecated: true,
    description:
      'Obsoleta: marca el fin del onboarding general y ya no habilita ninguna acción. Usa signingCredentialStatus.',
  })
  isConfigured: boolean;

  @ApiProperty({
    enum: SIGNING_CREDENTIAL_STATUS_ENUM,
    example: SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_REQUIRED,
    description:
      'Avance de identidad y firma del usuario, y única fuente de verdad sobre qué acciones de firma tiene habilitadas. Sólo lo escribe el backend.',
  })
  signingCredentialStatus: SIGNING_CREDENTIAL_STATUS_ENUM;

  @ApiProperty({
    example: false,
    description:
      'Derivada de signingCredentialStatus === CONFIGURED. Es la condición para poder firmar con firma Simple.',
  })
  signingCredentialConfigured: boolean;

  @ApiProperty({
    type: SignatureUrlDto,
    description:
      'URL de la firma del usuario, presente solo si se solicita con withSignature=true',
    nullable: true,
    required: false,
  })
  signature?: SignatureUrlDto | null;

  @ApiProperty({
    type: SignatureUrlDto,
    description:
      'URL de la identificación oficial (INE) del usuario, presente solo si se solicita con withSignature=true',
    nullable: true,
    required: false,
  })
  officialFile?: SignatureUrlDto | null;
}

export class UserGetResponse extends BaseResponse {
  @ApiProperty({
    type: UserGetData,
    description: 'Datos del usuario encontrado',
  })
  data: UserGetData;
}

export class UserGetListResponse extends BaseResponse {
  @ApiProperty({
    type: [UserGetData],
    description: 'Lista de usuarios activos',
  })
  data: UserGetData[];
}
