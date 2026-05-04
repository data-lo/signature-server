import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { UserService } from './user.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Post()
  create(@Body() createUserDto: CreateUserDto) {
    console.log('Creating user with data:', createUserDto);
    return this.userService.create(createUserDto);
  }

  @Get('email')
  findOneByEmail(@Body() email: string) {
    return this.userService.findOneByEmail(email);
  }

  @Get()
  findAllActiveUsers() {
    return this.userService.findAllActiveUsers();
  }

  @Get(':id')
  findOneActiveUser(@Param('id') id: string) {
    return this.userService.findOneActiveUser(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateUserDto: UpdateUserDto) {
    return this.userService.update(id, updateUserDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.userService.remove(id);
  }
}
