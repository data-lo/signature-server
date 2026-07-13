import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse } from 'src/interfaces/api-response.dto';

export class SubmitForAuthorizationResponse extends BaseResponse<null> {
  @ApiProperty({ example: null, nullable: true })
  data: null;
}
