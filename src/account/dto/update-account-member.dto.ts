import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateAccountMemberDto } from './create-account-member.dto';

export class UpdateAccountMemberDto extends PartialType(
  OmitType(CreateAccountMemberDto, ['accountId', 'userId'] as const),
) {}
