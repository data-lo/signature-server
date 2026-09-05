import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

const SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Siteverify es una llamada corta contra Cloudflare; no vale la pena dejar colgado un registro. */
const SITEVERIFY_TIMEOUT_MS = 5_000;

/** Mensaje único para el usuario: token ausente, inválido, expirado o ya usado son el mismo caso desde su lado — rehacer el CAPTCHA. */
const INVALID_TOKEN_MESSAGE =
  'La verificación del CAPTCHA no es válida o expiró. Vuelve a completarla e intenta de nuevo.';

/** Cloudflare no pudo responder (red, timeout, 5xx) o falta la configuración: no es culpa del usuario, pero tampoco se puede dar por válido. */
const UNAVAILABLE_MESSAGE =
  'No se pudo verificar el CAPTCHA en este momento. Intenta de nuevo en unos segundos.';

/** Códigos que indican un problema NUESTRO, no del usuario (ver docs de Siteverify) — se distinguen solo para el log. */
const SERVER_SIDE_ERROR_CODES = [
  'missing-input-secret',
  'invalid-input-secret',
  'internal-error',
];

interface SiteverifyResponse {
  success: boolean;
  'error-codes'?: string[];
}

/**
 * Canjea contra Siteverify el token de un solo uso que Cloudflare Turnstile genera cuando el usuario
 * resuelve el CAPTCHA en `/signup`, antes de que el registro toque la base de datos.
 *
 * Falla cerrado a propósito: si `TURNSTILE_SECRET_KEY` no está configurada, o Cloudflare no responde,
 * el registro se rechaza en vez de dejarse pasar. Un control anti-abuso que se autodesactiva cuando
 * algo va mal no protege de nada, y el modo "sin configurar" es justo el que llegaría a producción
 * por descuido.
 *
 * Ni la clave secreta ni el token entran nunca a los logs ni a la respuesta: de Siteverify sólo se
 * registran los `error-codes`, que no son sensibles.
 */
@Injectable()
export class TurnstileService {
  private readonly logger = new Logger(TurnstileService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Lanza si el token no es válido; retorna sin valor si lo es.
   *
   * No se manda `remoteip` a Siteverify aunque el parámetro exista: el frontend habla con este
   * servidor a través del proxy de Next (`/api/:path*` → backend, ver `next.config.ts`), así que
   * la IP que veríamos acá es la del proxy y no la del navegador que resolvió el reto —
   * mandarla haría fallar validaciones legítimas.
   */
  async verifyToken(token: string): Promise<void> {
    const secretKey = this.resolveSecretKey();

    // Siteverify responde `missing-input-response` a un token vacío, pero eso gasta un viaje de
    // red por cada bot que ni se molesta en mandarlo.
    if (!token?.trim()) {
      throw new BadRequestException(INVALID_TOKEN_MESSAGE);
    }

    let response: SiteverifyResponse;

    try {
      const httpResponse = await axios.post<SiteverifyResponse>(
        SITEVERIFY_URL,
        // Siteverify acepta JSON o form-urlencoded; se usa el segundo porque es el formato
        // documentado por Cloudflare y no depende de que el endpoint siga aceptando JSON.
        new URLSearchParams({ secret: secretKey, response: token }),
        { timeout: SITEVERIFY_TIMEOUT_MS },
      );
      response = httpResponse.data;
    } catch (error) {
      this.logger.error(
        `No se pudo consultar Siteverify: ${
          axios.isAxiosError(error)
            ? `HTTP ${error.response?.status ?? 'sin respuesta'} (code=${error.code ?? 'unknown'})`
            : 'error inesperado'
        }`,
      );
      throw new ServiceUnavailableException(UNAVAILABLE_MESSAGE);
    }

    if (response?.success) {
      return;
    }

    const errorCodes = response?.['error-codes'] ?? [];

    // `invalid-input-secret` o `internal-error` no los puede arreglar el usuario reintentando el
    // CAPTCHA: son configuración nuestra o una caída de Cloudflare. Se separan para que el log
    // diga qué revisar y para no mandar al usuario a un bucle de retos que siempre van a fallar.
    if (errorCodes.some((code) => SERVER_SIDE_ERROR_CODES.includes(code))) {
      this.logger.error(
        `Siteverify rechazó la petición por configuración del servidor (${errorCodes.join(', ')}). Revisa TURNSTILE_SECRET_KEY.`,
      );
      throw new ServiceUnavailableException(UNAVAILABLE_MESSAGE);
    }

    this.logger.warn(
      `Token de Turnstile rechazado (${errorCodes.join(', ') || 'sin código'}).`,
    );
    throw new BadRequestException(INVALID_TOKEN_MESSAGE);
  }

  /**
   * La clave se resuelve al invocar y no en el constructor, igual que en `SealApiService`: este
   * provider se exporta desde `SharedModule`, que carga la aplicación entera, así que lanzar
   * desde el constructor tumbaría el arranque completo del servidor por una variable faltante.
   */
  private resolveSecretKey(): string {
    const secretKey = this.configService.get<string>('TURNSTILE_SECRET_KEY');

    if (!secretKey) {
      this.logger.error(
        'Falta TURNSTILE_SECRET_KEY: no se puede verificar el CAPTCHA y el registro queda bloqueado (ver .env.example).',
      );
      throw new ServiceUnavailableException(UNAVAILABLE_MESSAGE);
    }

    return secretKey;
  }
}
