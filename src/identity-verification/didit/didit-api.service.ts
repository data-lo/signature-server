import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { DiditSession } from '../interfaces/didit-session.interface';
import {
  DiditConfigurationException,
  DiditResponseException,
  DiditTimeoutException,
  DiditUnavailableException,
} from '../exceptions/identity-verification.exceptions';

const DIDIT_DEFAULT_API_URL = 'https://verification.didit.me';

/** El alta de sesión es una llamada barata; si tarda más que esto, algo está mal del otro lado. */
const DIDIT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Adapta la API de verificación de Didit.
 *
 * No es el servicio de dominio del módulo: no decide nada sobre identidades ni conoce la entidad
 * local. Traduce entre nuestro dominio y el contrato del proveedor, y es el único archivo que hay
 * que tocar si Didit cambia su API. Los casos de uso dependen de él, nunca al revés.
 *
 * La API key vive sólo acá: viaja en el header `x-api-key`, jamás se registra en logs ni se persiste
 * en `provider_metadata`, y nunca llega al frontend, que sólo recibe la URL hospedada.
 */
@Injectable()
export class DiditApiService {
  private readonly logger = new Logger(DiditApiService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Crea una sesión de verificación con el workflow ya configurado en el panel de Didit.
   *
   * @param vendorData Identificador nuestro que Didit devuelve intacto en el webhook. Se manda
   *   el `userId`, de modo que el resultado sea atribuible aunque el `session_id` se pierda.
   * @param callbackUrl A dónde regresa el usuario al terminar. Es sólo navegación: el veredicto
   *   llega por webhook firmado, nunca por este retorno.
   */
  async createSession(
    vendorData: string,
    callbackUrl: string,
  ): Promise<DiditSession> {
    const { apiUrl, apiKey, workflowId } = this.resolveConfiguration();

    try {
      const response = await axios.post<Record<string, unknown>>(
        `${apiUrl}/v2/session/`,
        {
          workflow_id: workflowId,
          vendor_data: vendorData,
          callback: callbackUrl,
        },
        {
          headers: {
            'x-api-key': apiKey,
            'Content-Type': 'application/json',
          },
          timeout: DIDIT_REQUEST_TIMEOUT_MS,
        },
      );

      return this.toDiditSession(response.data, workflowId);
    } catch (error) {
      throw this.translate(error, vendorData);
    }
  }

  /**
   * La configuración se resuelve al invocar y NO en el constructor: este provider vive en un
   * módulo que carga la aplicación entera, así que lanzar desde el constructor impediría
   * arrancar el servidor completo por una integración que la mayoría de los entornos de
   * desarrollo no usa. Mismo criterio que `SealApiService`.
   */
  private resolveConfiguration(): {
    apiUrl: string;
    apiKey: string;
    workflowId: string;
  } {
    const apiKey = this.configService.get<string>('DIDIT_API_KEY');
    const workflowId = this.configService.get<string>('DIDIT_WORKFLOW_ID');

    if (!apiKey || !workflowId) {
      this.logger.error(
        'Faltan DIDIT_API_KEY o DIDIT_WORKFLOW_ID: no es posible crear sesiones de verificación.',
      );
      throw new DiditConfigurationException();
    }

    const apiUrl = (
      this.configService.get<string>('DIDIT_API_URL') || DIDIT_DEFAULT_API_URL
    ).replace(/\/+$/, '');

    return { apiUrl, apiKey, workflowId };
  }

  /**
   * Exige `session_id` y `url`: sin ellos la respuesta es inservible —el frontend no tendría a dónde
   * mandar al usuario y el webhook no tendría con qué encontrar el intento—, y es mejor fallar acá
   * con un error explícito que persistir una fila rota.
   */
  private toDiditSession(
    body: Record<string, unknown>,
    workflowId: string,
  ): DiditSession {
    const sessionId = this.asString(body.session_id);
    const url = this.asString(body.url) ?? this.asString(body.session_url);

    if (!sessionId || !url) {
      this.logger.error(
        `Didit respondió sin session_id o sin url (claves recibidas: ${Object.keys(body).join(', ')}).`,
      );
      throw new DiditResponseException();
    }

    return {
      sessionId,
      url,
      workflowId: this.asString(body.workflow_id) ?? workflowId,
      expiresAt: this.asDate(body.expires_at),
      raw: this.withoutSecrets(body),
    };
  }

  /**
   * `session_token` es una credencial de acceso a la sesión: quien la tiene puede operar el
   * Descarta la clave antes de persistir, para que no termine copiada en `provider_metadata` y, de
   * ahí, en cualquier respaldo de la base.
   */
  private withoutSecrets(
    body: Record<string, unknown>,
  ): Record<string, unknown> {
    const { session_token, token, ...safe } = body;
    void session_token;
    void token;
    return safe;
  }

  private translate(error: unknown, vendorData: string): Error {
    if (!axios.isAxiosError(error)) {
      return error instanceof Error ? error : new DiditResponseException();
    }

    const upstreamStatus = error.response?.status;

    if (upstreamStatus) {
      // El cuerpo del error de Didit puede traer datos del usuario: se registra el estado y el
      // identificador propio, no la respuesta completa.
      this.logger.error(
        `Didit respondió HTTP ${upstreamStatus} al crear la sesión de ${vendorData}.`,
      );
      return new DiditResponseException();
    }

    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      this.logger.error(
        `Timeout al crear la sesión de Didit de ${vendorData}.`,
      );
      return new DiditTimeoutException();
    }

    this.logger.error(
      `No se pudo conectar con Didit para crear la sesión de ${vendorData} (code=${error.code ?? 'unknown'}).`,
    );
    return new DiditUnavailableException();
  }

  private asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  private asDate(value: unknown): Date | null {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return null;
    }

    const parsed = new Date(typeof value === 'number' ? value * 1000 : value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
}
