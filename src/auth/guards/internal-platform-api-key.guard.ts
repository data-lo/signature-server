import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';

/** Variable con la llave de las operaciones internas de plataforma. */
export const INTERNAL_PLATFORM_API_KEY_ENV = 'INTERNAL_PLATFORM_API_KEY';

/** Largo mínimo de la llave interna: por debajo se trata como no configurada. */
export const MIN_INTERNAL_PLATFORM_API_KEY_LENGTH = 32;

/** Header con el que el operador interno presenta la llave. Express lo entrega en minúsculas. */
const INTERNAL_PLATFORM_API_KEY_HEADER = 'x-api-key';

/**
 * Autentica las operaciones internas de plataforma (aprovisionamiento de cuentas de prueba) con la
 * llave `INTERNAL_PLATFORM_API_KEY`. Se aplica con `@InternalPlatformAuth()`, nunca a mano.
 *
 * Es otra frontera que la de `@Public()`: aquélla compara `x-api-key` contra `API_KEY`, la llave
 * que comparten los servicios del ecosistema (seal-service, el panel), y aquí se exige una llave
 * PROPIA, para que filtrar la de los servicios no permita crear organizaciones con créditos.
 *
 * - **Falla cerrado**: sin la variable (o con menos de 32 caracteres) responde 503 a todo, en vez de
 *   aceptar una llave vacía.
 * - Compara en tiempo constante (SHA-256 de ambos lados, para igualar largos).
 * - **No registra la llave recibida** en ningún caso; sólo que faltó la configuración.
 */
@Injectable()
export class InternalPlatformApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(InternalPlatformApiKeyGuard.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Deja pasar la petición sólo si trae la llave interna de plataforma.
   *
   * @param context - Contexto de ejecución de Nest.
   * @returns `true` si `x-api-key` coincide con `INTERNAL_PLATFORM_API_KEY`.
   *
   * @throws {ServiceUnavailableException} (503) Si `INTERNAL_PLATFORM_API_KEY` falta o es corta.
   * @throws {UnauthorizedException} (401) Si el header falta o no coincide.
   *
   * @example
   * ```ts
   * @InternalPlatformAuth()
   * @Controller('internal/organizations')
   * export class InternalOrganizationProvisioningController {}
   * ```
   */
  canActivate(context: ExecutionContext): boolean {
    const expected = this.configService.get<string>(
      INTERNAL_PLATFORM_API_KEY_ENV,
    );
    if (!expected || expected.length < MIN_INTERNAL_PLATFORM_API_KEY_LENGTH) {
      this.logger.error(
        `${INTERNAL_PLATFORM_API_KEY_ENV} no está configurada (o tiene menos de ${MIN_INTERNAL_PLATFORM_API_KEY_LENGTH} caracteres); se rechazan las operaciones internas de plataforma.`,
      );
      throw new ServiceUnavailableException(
        'Las operaciones internas de plataforma no están habilitadas en este entorno',
      );
    }

    const request = context.switchToHttp().getRequest();
    const received = request.headers?.[INTERNAL_PLATFORM_API_KEY_HEADER];

    if (typeof received !== 'string' || !matches(received, expected)) {
      throw new UnauthorizedException('Llave interna de plataforma requerida');
    }

    return true;
  }
}

/**
 * Compara dos llaves en tiempo constante.
 *
 * @param received - Lo que llegó en el header.
 * @param expected - La llave configurada.
 * @returns `true` si son iguales.
 *
 * @example
 * ```ts
 * matches('abc', 'abc'); // true
 * ```
 */
function matches(received: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(received), digest(expected));
}
