import { IsNotEmpty, IsString } from 'class-validator';
import { ApiHideProperty, ApiProperty } from '@nestjs/swagger';

export class CreateVerificationCodeDto {
  @ApiProperty({ example: '81ec99ef-a57d-46d9-b3da-1368dfeffb45' })
  @IsString()
  @IsNotEmpty({ message: 'Signer ID is required' })
  signerId: string;

  @ApiProperty({ example: '47acc228-c113-4de5-a7bc-e4a159fb7007' })
  @IsString()
  @IsNotEmpty({ message: 'Document ID is required' })
  documentId: string;

  @ApiProperty({ example: 'VERIFICATION' })
  @IsString()
  @IsNotEmpty({ message: 'Type is required' })
  type: string;
}