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
import { Public } from 'src/auth/decorators/public.decorator';

// Service
import { UserService } from './user.service';

// DTOs
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

// Docs
import { ApiCreateUser } from './docs/api-create-user.docs';
import { ApiGetUsers } from './docs/api-get-users.docs';
import { ApiGetUser } from './docs/api-get-user.docs';
import { ApiUpdateUser } from './docs/api-update-user.docs';
import { ApiDeleteUser } from './docs/api-delete-user.docs';

@ApiTags('User')
@ApiBearerAuth('access-token')
@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  //EXPUESTOS AL API
  @Public()
  @Post()
  @ApiCreateUser()
  create(@Body() createUserDto: CreateUserDto) {
    return this.userService.create(createUserDto);
  }

  @Get()
  @ApiGetUsers()
  findAll(@Query('withSignature') withSignature?: string) {
    return this.userService.findAllActiveUsers(withSignature === 'true');
  }

  @Public()
  @Get(':id')
  @ApiGetUser()
  findOne(
    @Param('id') id: string,
    @Query('withSignature') withSignature?: string,
  ) {
    return this.userService.findOneActiveUser(id, withSignature === 'true');
  }

  @Public()
  @Patch(':id')
  @ApiUpdateUser()
  update(@Param('id') id: string, @Body() updateUserDto: UpdateUserDto) {
    return this.userService.update(id, updateUserDto);
  }

  @Public()
  @Delete(':id')
  @ApiDeleteUser()
  remove(@Param('id') id: string) {
    return this.userService.remove(id);
  }
}
