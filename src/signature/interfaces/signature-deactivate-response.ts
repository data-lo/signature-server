import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse } from '../../interfaces/api-response.dto';

export class SignatureDeactivateResponse extends BaseResponse<null> {
    @ApiProperty({ nullable: true, example: null, description: 'No retorna datos' })
    data: null;
}