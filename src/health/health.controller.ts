import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  MongooseHealthIndicator,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { RedisHealthIndicator } from './redis.health';
import { SkipJwtAuth } from 'src/auth/decorators/skip-jwt-auth.decorator';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly mongoose: MongooseHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  /**
   * Sin autenticación a propósito: lo consumen probes de infraestructura
   * (healthcheck de Docker, liveness/readiness de k8s, monitoreo externo)
   * que no tienen JWT ni x-api-key. @Public() no sirve aquí porque sigue
   * exigiendo x-api-key (ver ApiKeyGuard) — @SkipJwtAuth() es la única
   * combinación que deja la ruta sin ninguna credencial.
   */
  @Get()
  @HealthCheck()
  @SkipJwtAuth()
  check() {
    return this.health.check([
      () => this.db.pingCheck('postgres'),
      () => this.mongoose.pingCheck('mongodb'),
      () => this.redis.isHealthy('redis'),
    ]);
  }
}
