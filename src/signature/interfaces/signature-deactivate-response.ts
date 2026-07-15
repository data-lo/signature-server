import { ApiProperty } from '@nestjs/swagger';
import { SignatureResponse } from './signature-response';
import { BaseResponse } from '../../interfaces/api-response.dto';

export class SignatureDeactivateResponse extends BaseResponse<SignatureResponse> {
  @ApiProperty({
    type: SignatureResponse,
    example: null,
    description: 'No retorna datos',
  })
  data: SignatureResponse;
}
