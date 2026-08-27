// NestJS core
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

// Swagger
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

// Auth
import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';

// Use cases
import { GrantAccountAccessUseCase } from './applications/grant-account-access.use-case';
import { GetOrganizationMembersUseCase } from './applications/get-organization-members.use-case';
import { GetAccountMemberUseCase } from './applications/get-account-member.use-case';
import { UpdateAccountMemberUseCase } from './applications/update-account-member.use-case';
import { RevokeAccountAccessUseCase } from './applications/revoke-account-access.use-case';

// DTOs
import { CreateAccountMemberDto } from './dto/create-account-member.dto';
import { UpdateAccountMemberDto } from './dto/update-account-member.dto';

// Docs
import { ApiGrantAccountAccess } from './docs/api-grant-account-access.docs';
import { ApiGetOrganizationMembers } from './docs/api-get-organization-members.docs';
import { ApiGetAccountMember } from './docs/api-get-account-member.docs';
import { ApiUpdateAccountMember } from './docs/api-update-account-member.docs';
import { ApiRevokeAccountAccess } from './docs/api-revoke-account-access.docs';

@ApiTags('Account Member')
@ApiBearerAuth('access-token')
@Controller('account-member')
export class AccountMemberController {
  constructor(
    private readonly grantAccountAccess: GrantAccountAccessUseCase,
    private readonly getOrganizationMembers: GetOrganizationMembersUseCase,
    private readonly getAccountMember: GetAccountMemberUseCase,
    private readonly updateAccountMember: UpdateAccountMemberUseCase,
    private readonly revokeAccountAccess: RevokeAccountAccessUseCase,
  ) {}

  @Post()
  @ApiGrantAccountAccess()
  create(
    @CurrentUser() user: JwtPayload,
    @Body() createAccountMemberDto: CreateAccountMemberDto,
  ) {
    return this.grantAccountAccess.execute(user.sub, createAccountMemberDto);
  }

  @Get()
  @ApiGetOrganizationMembers()
  findByOrganization(
    @CurrentUser() user: JwtPayload,
    @Query('organizationId') organizationId: string,
  ) {
    return this.getOrganizationMembers.execute(user.sub, organizationId);
  }

  @Get(':id')
  @ApiGetAccountMember()
  findOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.getAccountMember.execute(user.sub, id);
  }

  @Patch(':id')
  @ApiUpdateAccountMember()
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() updateAccountMemberDto: UpdateAccountMemberDto,
  ) {
    return this.updateAccountMember.execute(
      user.sub,
      id,
      updateAccountMemberDto,
    );
  }

  @Delete(':id')
  @ApiRevokeAccountAccess()
  remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.revokeAccountAccess.execute(user.sub, id);
  }
}
