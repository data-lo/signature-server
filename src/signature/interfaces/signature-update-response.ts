import { ApiProperty } from "@nestjs/swagger";
import { BaseResponse } from "src/interfaces/api-response.dto";

export class SignatureUpdateData {
    @ApiProperty({ example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", description: 'UUID de la firma', format: 'uuid' })
    id: string
}

export class SignatureUpdateReponse extends BaseResponse<SignatureUpdateData> {
    @ApiProperty({ type: SignatureUpdateData })
    data: SignatureUpdateData
}