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
 * Adaptador HTTP hacia la API de verificación de Didit.
 *
 * No es el "servicio de dominio" del módulo: no decide nada sobre identidades ni conoce la
 * entidad local. Traduce entre nuestro dominio y el contrato del proveedor, y es el único
 * archivo que hay que tocar si Didit cambia su API. Los casos de uso dependen de él, nunca al
 * revés.
 *
 * La API key vive sólo aquí: viaja en el header `x-api-key`, jamás se registra en logs ni se
 * persiste en `provider_metadata`, y nunca llega al frontend — el cliente sólo recibe la URL
 * hospedada.
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
   * Crea una sesión de firma biométrica con la API V3 de Didit.
   *
   * Va aparte de `createSession` (V2, onboarding) porque sólo la V3 documenta `portrait_image`:
   * la cara de referencia contra la que el workflow de Biometric Authentication hace el face
   * match. Para el KYC de invitados se omite y Didit compara contra la identificación capturada.
   *
   * @param params.workflowId Workflow de Didit (Biometric Authentication o KYC).
   * @param params.vendorData Identificador no sensible que Didit devuelve en el webhook.
   * @param params.callbackUrl A dónde regresa el firmante. Sólo navegación: no aprueba nada.
   * @param params.portraitImageBase64 Cara de referencia en base64 (máx. 2 MB), o `undefined`.
   * @returns La sesión normalizada: id, URL hospedada, workflow y vencimiento.
   *
   * @throws {DiditConfigurationException} Si falta la API key o el workflow.
   * @throws {DiditResponseException} Si Didit responde con error o sin `session_id`/`url`.
   * @throws {DiditTimeoutException} Si Didit no responde a tiempo.
   * @throws {DiditUnavailableException} Si no se puede conectar con Didit.
   *
   * @example
   * ```ts
   * await diditApiService.createBiometricSession({
   *   workflowId: 'wf-auth', vendorData: 'biometric-signature-attempt:a-1',
   *   callbackUrl: 'https://app/dashboard/documents/d-1', portraitImageBase64: '/9j/4AAQ…',
   * });
   * ```
   */
  async createBiometricSession(params: {
    workflowId: string;
    vendorData: string;
    callbackUrl: string;
    portraitImageBase64?: string;
  }): Promise<DiditSession> {
    const { apiUrl, apiKey } = this.resolveApiAccess();

    if (!params.workflowId) {
      this.logger.error(
        'Falta el workflow de firma biométrica de Didit: no es posible crear la sesión.',
      );
      throw new DiditConfigurationException();
    }

    try {
      const response = await axios.post<Record<string, unknown>>(
        `${apiUrl}/v3/session/`,
        {
          workflow_id: params.workflowId,
          vendor_data: params.vendorData,
          callback: params.callbackUrl,
          ...(params.portraitImageBase64
            ? { portrait_image: params.portraitImageBase64 }
            : {}),
        },
        {
          headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
          timeout: DIDIT_REQUEST_TIMEOUT_MS,
        },
      );

      return this.toDiditSession(response.data, params.workflowId);
    } catch (error) {
      throw this.translate(error, params.vendorData);
    }
  }

  /**
   * Obtiene el veredicto actual de una sesión de Didit (API V3), con URLs de media recién firmadas.
   *
   * Lo usa la firma biométrica para recuperar el retrato de la identidad aprobada en el onboarding:
   * las URLs guardadas en `identity_verifications.decision` vencen a las pocas horas, así que hay
   * que pedirlas de nuevo en el momento de usarlas. El cuerpo NUNCA se registra en logs.
   *
   * @param sessionId `session_id` de Didit.
   * @returns El veredicto crudo de Didit.
   *
   * @throws {DiditConfigurationException} Si falta la API key.
   * @throws {DiditResponseException} Si Didit responde con error o un cuerpo que no es objeto.
   * @throws {DiditTimeoutException} Si Didit no responde a tiempo.
   * @throws {DiditUnavailableException} Si no se puede conectar con Didit.
   *
   * @example
   * ```ts
   * const decision = await diditApiService.getSessionDecision('didit-session-1');
   * ```
   */
  async getSessionDecision(
    sessionId: string,
  ): Promise<Record<string, unknown>> {
    const { apiUrl, apiKey } = this.resolveApiAccess();

    try {
      const response = await axios.get<unknown>(
        `${apiUrl}/v3/session/${encodeURIComponent(sessionId)}/decision/`,
        {
          headers: { 'x-api-key': apiKey },
          timeout: DIDIT_REQUEST_TIMEOUT_MS,
        },
      );

      const body = response.data;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new DiditResponseException();
      }
      return body as Record<string, unknown>;
    } catch (error) {
      throw this.translate(error, `sesión ${sessionId}`);
    }
  }

  /** API key y URL base, sin exigir el workflow del onboarding. */
  private resolveApiAccess(): { apiUrl: string; apiKey: string } {
    const apiKey = this.configService.get<string>('DIDIT_API_KEY');

    if (!apiKey) {
      this.logger.error(
        'Falta DIDIT_API_KEY: no es posible llamar a la API de Didit.',
      );
      throw new DiditConfigurationException();
    }

    const apiUrl = (
      this.configService.get<string>('DIDIT_API_URL') || DIDIT_DEFAULT_API_URL
    ).replace(/\/+$/, '');

    return { apiUrl, apiKey };
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
   * Sin `session_id` o sin `url` la respuesta es inservible: el frontend no tendría a dónde
   * mandar al usuario y el webhook no tendría con qué encontrar el intento. Mejor fallar acá,
   * con un error explícito, que persistir una fila rota.
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
   * flujo del usuario. Se descarta antes de persistir para que no termine copiada en
   * `provider_metadata` y, de ahí, en cualquier respaldo de la base.
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
