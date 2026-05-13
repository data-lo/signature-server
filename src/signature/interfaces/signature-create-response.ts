import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse } from '../../interfaces/api-response.dto';

export class SignatureCreateData {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', description: 'UUID de la firma', format: 'uuid' })
  id: string;
}

export class SignatureCreateResponse extends BaseResponse<SignatureCreateData> {
  @ApiProperty({ type: SignatureCreateData, description: 'Datos de la firma registrada' })
  data: SignatureCreateData;
}