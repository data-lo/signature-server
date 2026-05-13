import { ApiProperty } from '@nestjs/swagger';
import { SignatureResponse } from './signature-response';
import { BaseResponse } from '../../interfaces/api-response.dto';

export class SignatureCreateResponse extends BaseResponse<SignatureResponse> {
  @ApiProperty({ type: SignatureResponse, description: 'Datos de la firma registrada' })
  data: SignatureResponse;
}