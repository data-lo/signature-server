import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { ApiGetHello } from './docs/api-get-hello.docs';
import { SkipJwtAuth } from './auth/decorators/skip-jwt-auth.decorator';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /**
   * Saludo de sanidad del andamiaje de Nest, ya excluido del Swagger (`ApiGetHello`). Sin datos
   * de negocio, igual que `/health` — `@SkipJwtAuth()` por el mismo motivo: nadie que lo consuma
   * (una probe, un smoke test) tiene JWT ni x-api-key que ofrecer.
   */
  @Get()
  @ApiGetHello()
  @SkipJwtAuth()
  getHello(): string {
    return this.appService.getHello();
  }
}
