import { ApiProperty } from '@nestjs/swagger';
import { SignatureResponse } from './signature-response';
import { BaseResponse } from 'src/interfaces/api-response.dto';

export class SignatureUpdateReponse extends BaseResponse<SignatureResponse> {
  @ApiProperty({ type: SignatureResponse })
  data: SignatureResponse;
}
