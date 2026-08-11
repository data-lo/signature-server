import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { DocumentSealEntity } from './entities/document-seal.entity';
import {
  SealSignature,
  SealSignatureRequest,
  SealSignatureResponse,
} from './interfaces/seal-signature.interface';

/** Timeout de la llamada al Seal Service: emite sellos de tiempo contra un PSC externo, así que no es instantánea. */
const SEAL_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Cliente del Seal Service (repositorio `seal-service`), que emite el sello de tiempo y la
 * constancia NOM-151 sobre el conjunto de firmas avanzadas de un documento.
 *
 * Se invoca UNA sola vez por documento, cuando la firma avanzada queda completa (ver
 * DocumentEventsConsumer): el Seal Service espera el arreglo con TODAS las firmas, no una por
 * firmante, y su hash canónico se calcula sobre ese conjunto ordenado.
 *
 * Autenticación por API key en el header `x-api-key` — misma convención que el propio
 * `ApiKeyGuard` de este servicio. Se usa `fetch` nativo (Node 18+) en vez de agregar axios:
 * es una sola llamada HTTP y no justifica una dependencia nueva.
 */
@Injectable()
export class SealClientService {
  private readonly logger = new Logger(SealClientService.name);

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(DocumentSealEntity)
    private readonly documentSealRepository: Repository<DocumentSealEntity>,
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
  ) {}

  /**
   * Construye el arreglo de firmas avanzadas del documento, lo manda a sellar y guarda la
   * respuesta. Idempotente: si el documento ya tiene un sello guardado no vuelve a llamar al
   * servicio (la emisión de un sello de tiempo tiene costo y no debe repetirse por un reintento
   * del consumer de Kafka).
   *
   * Devuelve `null` cuando no hay nada que sellar o cuando la integración no está configurada,
   * para que el caller distinga "no aplicaba" de una excepción real.
   */
  async sealDocumentSignatures(
    documentId: string,
    originalHash: string,
  ): Promise<DocumentSealEntity | null> {
    const existing = await this.documentSealRepository.findOne({
      where: { documentId },
    });
    if (existing) {
      this.logger.log(
        `El documento ${documentId} ya tiene un sello registrado; no se vuelve a solicitar.`,
      );
      return existing;
    }

    const signatures = await this.buildSignatures(documentId);
    if (signatures.length === 0) {
      this.logger.warn(
        `No hay firmas avanzadas con evidencia en el documento ${documentId}; no se solicita sello.`,
      );
      return null;
    }

    const response = await this.requestSeal({
      documentId,
      originalHash,
      signatures,
    });
    if (!response) return null;

    const saved = await this.documentSealRepository.save(
      this.documentSealRepository.create({
        documentId,
        hashHex: response.hashHex,
        response: response as unknown as Record<string, unknown>,
      }),
    );

    this.logger.log(
      `Sello registrado para el documento ${documentId} (hashHex=${response.hashHex}).`,
    );
    return saved;
  }

  /**
   * Toma la evidencia criptográfica ya persistida de cada firmante FIEL
   * (`CollaboratorEntity.advancedSignature`, escrita por EfirmaService al firmar) y la traduce al
   * contrato del Seal Service. No se recalcula ni se vuelve a firmar nada: se reenvía lo que
   * quedó registrado en el momento real de cada firma.
   */
  private async buildSignatures(documentId: string): Promise<SealSignature[]> {
    const collaborators = await this.collaboratorRepository.find({
      where: { documentId },
    });

    return collaborators
      .filter((collaborator) => collaborator.advancedSignature != null)
      .map((collaborator) => {
        const signature = collaborator.advancedSignature!;
        return {
          signatureBase64: String(signature.signatureBase64),
          algorithm: signature.algorithm,
          // `signedAt` es Date en la entidad, pero jsonb lo devuelve como string ISO — se
          // normaliza para que el hash canónico del Seal Service sea reproducible.
          signedAt: new Date(signature.signedAt).toISOString(),
          certificate: { ...signature.certificate },
        };
      });
  }

  /** Llamada HTTP al Seal Service. Devuelve null si la integración no está configurada. */
  private async requestSeal(
    request: SealSignatureRequest,
  ): Promise<SealSignatureResponse | null> {
    const baseUrl = this.config.get<string>('SEAL_SERVICE_BASE_URL')?.trim();
    const apiKey = this.config.get<string>('SEAL_SERVICE_API_KEY')?.trim();

    if (!baseUrl || !apiKey) {
      // No se lanza excepción: un entorno sin la integración configurada (local, CI) debe poder
      // completar una firma avanzada. Queda el aviso para que no pase inadvertido.
      this.logger.warn(
        `SEAL_SERVICE_BASE_URL o SEAL_SERVICE_API_KEY no están configuradas; se omite el sellado del documento ${request.documentId}.`,
      );
      return null;
    }

    const url = `${baseUrl.replace(/\/+$/, '')}/seal/signature`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(SEAL_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `El Seal Service respondió ${response.status} para el documento ${request.documentId}: ${body.slice(0, 300)}`,
      );
    }

    return (await response.json()) as SealSignatureResponse;
  }
}
