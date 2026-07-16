import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse } from '../../../interfaces/api-response.dto';

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

  @ApiProperty({ example: 'Gerente de TI' })
  position: string;

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

  @ApiProperty({ type: UserMePersonalInformationData })
  personalInformation: UserMePersonalInformationData;

  @ApiProperty({ example: '2026-07-15T12:00:00.000Z' })
  updatedAt: string;
}

export class UserMeResponse extends BaseResponse<UserMeData> {
  @ApiProperty({ type: UserMeData })
  data: UserMeData;
}
