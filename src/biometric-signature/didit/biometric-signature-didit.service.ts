import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DiditApiService } from 'src/identity-verification/didit/didit-api.service';
import { DiditMediaDownloaderService } from 'src/identity-verification/didit/didit-media-downloader.service';
import { DiditConfigurationException } from 'src/identity-verification/exceptions/identity-verification.exceptions';
import { DiditSession } from 'src/identity-verification/interfaces/didit-session.interface';
import { BiometricReferencePortraitUnavailableException } from '../biometric-signature.exceptions';

/** Prefijo del `vendor_data` de las sesiones de firma biométrica. */
export const BIOMETRIC_SIGNATURE_VENDOR_DATA_PREFIX =
  'biometric-signature-attempt:';

/** Tope de `portrait_image` según la API de Didit. */
export const DIDIT_PORTRAIT_MAX_BYTES = 2 * 1024 * 1024;

/** Tipo de firmante: decide el workflow y si hay cara de referencia. */
export type BiometricSignerKind = 'ACCOUNT' | 'GUEST';

/**
 * `vendor_data` de un intento: sólo un identificador no sensible del intento. Ni el correo ni el
 * `userId` viajan a Didit por esta vía.
 *
 * @param attemptId - Id del intento.
 * @returns `biometric-signature-attempt:{attemptId}`.
 *
 * @example
 * ```ts
 * toBiometricVendorData('a-1'); // 'biometric-signature-attempt:a-1'
 * ```
 */
export function toBiometricVendorData(attemptId: string): string {
  return `${BIOMETRIC_SIGNATURE_VENDOR_DATA_PREFIX}${attemptId}`;
}

/**
 * Adaptador de Didit para la firma biométrica: elige el workflow según el tipo de firmante,
 * consigue la cara de referencia del firmante con cuenta y abre la sesión.
 *
 * | Firmante | Workflow | Referencia |
 * |---|---|---|
 * | Con cuenta | Biometric Authentication (`DIDIT_BIOMETRIC_AUTH_WORKFLOW_ID`) | Retrato de su identidad aprobada |
 * | Invitado | KYC (`DIDIT_BIOMETRIC_GUEST_KYC_WORKFLOW_ID`) | La identificación que captura Didit |
 *
 * Nada de lo que pasa por aquí (retrato, veredicto, URLs) se registra en logs.
 */
@Injectable()
export class BiometricSignatureDiditService {
  private readonly logger = new Logger(BiometricSignatureDiditService.name);

  constructor(
    private readonly diditApiService: DiditApiService,
    private readonly mediaDownloader: DiditMediaDownloaderService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Workflow de Didit que corresponde al tipo de firmante.
   *
   * Se resuelve ANTES de crear el intento, porque el intento guarda el workflow desde el inicio.
   *
   * @param kind - Firmante con cuenta o invitado.
   * @returns El id del workflow configurado.
   *
   * @throws {DiditConfigurationException} Si la variable del workflow no está configurada.
   *
   * @example
   * ```ts
   * const workflowId = diditService.workflowFor('GUEST');
   * ```
   */
  workflowFor(kind: BiometricSignerKind): string {
    const variable =
      kind === 'ACCOUNT'
        ? 'DIDIT_BIOMETRIC_AUTH_WORKFLOW_ID'
        : 'DIDIT_BIOMETRIC_GUEST_KYC_WORKFLOW_ID';
    const workflowId = this.configService.get<string>(variable);

    if (!workflowId) {
      this.logger.error(
        `Falta ${variable}: no es posible abrir sesiones de firma biométrica.`,
      );
      throw new DiditConfigurationException();
    }

    return workflowId;
  }

  /**
   * Abre la sesión de Biometric Authentication de un firmante con cuenta, usando como referencia
   * el retrato de su identidad Didit aprobada.
   *
   * @param params.attemptId - Intento local (va en `vendor_data`).
   * @param params.workflowId - Workflow resuelto con `workflowFor('ACCOUNT')`.
   * @param params.callbackUrl - Pantalla a la que regresa el firmante.
   * @param params.identitySessionId - `session_id` de la verificación de identidad aprobada.
   * @returns La sesión creada en Didit.
   *
   * @throws {BiometricReferencePortraitUnavailableException} Si no hay retrato utilizable.
   * @throws {DiditResponseException} Si Didit rechaza la consulta o el alta.
   * @throws {DiditTimeoutException} Si Didit no responde a tiempo.
   * @throws {DiditUnavailableException} Si no se puede conectar con Didit.
   *
   * @example
   * ```ts
   * await diditService.openAccountSession({ attemptId, workflowId, callbackUrl, identitySessionId });
   * ```
   */
  async openAccountSession(params: {
    attemptId: string;
    workflowId: string;
    callbackUrl: string;
    identitySessionId: string;
  }): Promise<DiditSession> {
    const portraitImageBase64 = await this.fetchReferencePortrait(
      params.identitySessionId,
    );

    return this.diditApiService.createBiometricSession({
      workflowId: params.workflowId,
      vendorData: toBiometricVendorData(params.attemptId),
      callbackUrl: params.callbackUrl,
      portraitImageBase64,
    });
  }

  /**
   * Abre la sesión de KYC de un invitado sin cuenta. Sin cara de referencia: Didit compara la
   * selfie viva contra la identificación que captura en la misma sesión.
   *
   * @param params.attemptId - Intento local (va en `vendor_data`).
   * @param params.workflowId - Workflow resuelto con `workflowFor('GUEST')`.
   * @param params.callbackUrl - Pantalla a la que regresa el invitado.
   * @returns La sesión creada en Didit.
   *
   * @throws {DiditResponseException} Si Didit rechaza el alta.
   * @throws {DiditTimeoutException} Si Didit no responde a tiempo.
   * @throws {DiditUnavailableException} Si no se puede conectar con Didit.
   *
   * @example
   * ```ts
   * await diditService.openGuestSession({ attemptId, workflowId, callbackUrl });
   * ```
   */
  openGuestSession(params: {
    attemptId: string;
    workflowId: string;
    callbackUrl: string;
  }): Promise<DiditSession> {
    return this.diditApiService.createBiometricSession({
      workflowId: params.workflowId,
      vendorData: toBiometricVendorData(params.attemptId),
      callbackUrl: params.callbackUrl,
    });
  }

  /**
   * Recupera el retrato de la identidad aprobada y lo devuelve en base64.
   *
   * Las URLs de media del veredicto vencen a las pocas horas, así que se pide el veredicto de
   * nuevo a Didit. Se prefiere la cara de una prueba de vida aprobada —es una captura en vivo de
   * la persona— y, si no hay, el retrato recortado de la identificación: el mismo orden con el que
   * Didit busca una cara guardada.
   *
   * @param identitySessionId - `session_id` de la verificación de identidad aprobada.
   * @returns El retrato en base64.
   *
   * @throws {BiometricReferencePortraitUnavailableException} Si no hay imagen aprobada, no se pudo
   *   descargar o supera 2 MB.
   * @throws {DiditResponseException} Si Didit no entrega el veredicto.
   *
   * @example
   * ```ts
   * const base64 = await this.fetchReferencePortrait('identity-session');
   * ```
   */
  private async fetchReferencePortrait(
    identitySessionId: string,
  ): Promise<string> {
    const decision =
      await this.diditApiService.getSessionDecision(identitySessionId);
    const url = pickReferencePortraitUrl(decision);

    if (!url) {
      throw new BiometricReferencePortraitUnavailableException(
        'la verificación de identidad no tiene una imagen del rostro',
      );
    }

    let image: { content: Buffer };
    try {
      image = await this.mediaDownloader.download(url, 'retrato');
    } catch {
      // El mensaje del descargador puede describir el host; al usuario sólo le sirve el motivo.
      throw new BiometricReferencePortraitUnavailableException(
        'la imagen del rostro no se pudo descargar',
      );
    }

    if (image.content.length > DIDIT_PORTRAIT_MAX_BYTES) {
      throw new BiometricReferencePortraitUnavailableException(
        'la imagen del rostro supera el tamaño que admite la comparación',
      );
    }

    return image.content.toString('base64');
  }
}

/**
 * Elige la URL del retrato de referencia dentro de un veredicto de Didit.
 *
 * Primero la `reference_image` de una prueba de vida aprobada; si no hay, el `portrait_image` de
 * una lectura de identificación aprobada. Acepta las formas V3 (arreglos) y V2 (objetos).
 *
 * @param decision - Veredicto crudo de Didit.
 * @returns La URL elegida, o `null` si ninguna prueba aprobada trae imagen del rostro.
 *
 * @example
 * ```ts
 * pickReferencePortraitUrl({ liveness_checks: [{ status: 'Approved', reference_image: 'https://…' }] });
 * ```
 */
export function pickReferencePortraitUrl(
  decision: Record<string, unknown>,
): string | null {
  const candidates: [string[], string][] = [
    [['liveness_checks', 'liveness'], 'reference_image'],
    [['id_verifications', 'id_verification'], 'portrait_image'],
  ];

  for (const [aliases, field] of candidates) {
    for (const alias of aliases) {
      for (const entry of toEntries(decision[alias])) {
        const approved =
          typeof entry.status === 'string' &&
          entry.status.toLowerCase() === 'approved';
        const url = entry[field];
        if (approved && typeof url === 'string' && url.length > 0) {
          return url;
        }
      }
    }
  }

  return null;
}

/**
 * Normaliza un bloque del veredicto a una lista: V3 trae un arreglo, V2 un objeto.
 *
 * @param section - Valor del bloque.
 * @returns Las entradas que son objetos; vacío si el bloque no tiene esa forma.
 *
 * @example
 * ```ts
 * toEntries({ status: 'Approved' }); // [{ status: 'Approved' }]
 * ```
 */
function toEntries(section: unknown): Record<string, unknown>[] {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

  if (Array.isArray(section)) {
    return section.filter(isObject);
  }
  return isObject(section) ? [section] : [];
}
