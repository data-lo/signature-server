import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { ApiGetHello } from './docs/api-get-hello.docs';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @ApiGetHello()
  getHello(): string {
    return this.appService.getHello();
  }
}
