import { createHash, randomUUID } from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

/** Fallo que el stub aplica a la siguiente petición de sellado. */
export type SealProviderFault =
  /** `500` sin emitir. */
  | 'http500'
  /** `429` con `Retry-After: 120`, sin emitir. */
  | 'http429'
  /** `400`: payload rechazado. */
  | 'http400'
  /** Emite (cuenta como emisión ante el PSC) y corta la conexión sin responder. */
  | 'emitAndDropResponse'
  /** Resultado incierto ante el PSC: `409 SEAL_RECONCILIATION_REQUIRED`. */
  | 'reconciliation';

type OperationStatus = 'COMPLETED' | 'FAILED' | 'RECONCILIATION_REQUIRED';

interface StoredOperation {
  path: string;
  requestHash: string;
  status: OperationStatus;
  evidence?: Record<string, unknown>;
}

/** Una petición recibida, para las aserciones. */
export interface RecordedSealRequest {
  method: string;
  path: string;
  idempotencyKey: string | null;
  body: Record<string, unknown> | null;
}

export const STUB_SEAL_API_KEY = 'stub-seal-api-key';

/**
 * Servidor HTTP de prueba con el contrato idempotente de Seal Service (ver seal-service
 * `SealOperationRunnerService`), para que la suite no dependa del PSC:
 *
 * - `POST /seal/signature` y `/seal/simple-signature` con `Idempotency-Key`:
 *   - clave nueva o con un intento `FAILED` → emite (cuenta en `emissions`) y responde `200`;
 *   - misma clave y mismo payload ya emitido → `200` con LA MISMA evidencia y
 *     `Idempotent-Replayed: true`, sin emitir;
 *   - misma clave con otro payload o en el otro endpoint → `409 IDEMPOTENCY_KEY_REUSED`;
 *   - operación en conciliación → `409 SEAL_RECONCILIATION_REQUIRED`, sin emitir.
 * - `GET /seal/operations/:key` → estado y evidencia, o `404 NOT_FOUND`.
 *
 * `fail(...)` programa fallos para las siguientes peticiones de sellado.
 *
 * @example
 * ```ts
 * const provider = await SealProviderStub.start();
 * provider.fail('http500');
 * // … SEAL_SERVICE_URL = provider.url
 * await provider.stop();
 * ```
 */
export class SealProviderStub {
  readonly requests: RecordedSealRequest[] = [];
  emissions = 0;
  private readonly operations = new Map<string, StoredOperation>();
  private readonly faults: SealProviderFault[] = [];
  private server!: Server;
  url = '';

  /**
   * Arranca el servidor en un puerto libre de localhost.
   *
   * @returns El stub, con `url` lista.
   */
  static async start(): Promise<SealProviderStub> {
    const stub = new SealProviderStub();
    stub.server = createServer((req, res) => {
      void stub.handle(req, res);
    });
    await new Promise<void>((resolve) =>
      stub.server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = stub.server.address() as AddressInfo;
    stub.url = `http://127.0.0.1:${port}`;
    return stub;
  }

  /** Detiene el servidor. */
  async stop(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Olvida operaciones, peticiones, fallos y emisiones. */
  reset(): void {
    this.requests.length = 0;
    this.faults.length = 0;
    this.operations.clear();
    this.emissions = 0;
  }

  /**
   * Programa fallos para las siguientes peticiones de sellado (no para las consultas).
   *
   * @param faults - Fallos en orden.
   * @returns El propio stub.
   */
  fail(...faults: SealProviderFault[]): this {
    this.faults.push(...faults);
    return this;
  }

  /**
   * Evidencia que el "PSC" emitió para una clave, aunque la respuesta se haya perdido.
   *
   * @param idempotencyKey - Clave de la operación.
   * @returns La evidencia, o `undefined` si no se emitió.
   */
  evidenceFor(idempotencyKey: string): Record<string, any> | undefined {
    return this.operations.get(idempotencyKey)?.evidence;
  }

  /** Peticiones de sellado (POST) recibidas. */
  sealRequests(): RecordedSealRequest[] {
    return this.requests.filter((request) => request.method === 'POST');
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const raw = await readBody(req);
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    const path = (req.url ?? '').split('?')[0];
    const idempotencyKey = header(req, 'idempotency-key');
    this.requests.push({
      method: req.method ?? '',
      path,
      idempotencyKey,
      body,
    });

    if (header(req, 'x-api-key') !== STUB_SEAL_API_KEY) {
      return json(res, 401, { message: 'Unauthorized' });
    }

    if (req.method === 'GET' && path.startsWith('/seal/operations/')) {
      const key = decodeURIComponent(path.slice('/seal/operations/'.length));
      const operation = this.operations.get(key);
      if (!operation) {
        return json(res, 404, { idempotencyKey: key, status: 'NOT_FOUND' });
      }
      return json(res, 200, {
        idempotencyKey: key,
        status: operation.status,
        ...(operation.status === 'COMPLETED' && {
          evidence: operation.evidence,
        }),
        ...(operation.status === 'RECONCILIATION_REQUIRED' && {
          error: { code: 'PSC_UNCERTAIN_RESULT', message: null },
        }),
      });
    }

    if (
      req.method !== 'POST' ||
      (path !== '/seal/signature' && path !== '/seal/simple-signature')
    ) {
      return json(res, 404, { message: 'Not found' });
    }
    if (!idempotencyKey || !body) {
      return json(res, 400, { code: 'INVALID_IDEMPOTENCY_KEY' });
    }

    const requestHash = sha256(canonical(body));
    const existing = this.operations.get(idempotencyKey);

    if (existing) {
      if (existing.path !== path || existing.requestHash !== requestHash) {
        return json(res, 409, { code: 'IDEMPOTENCY_KEY_REUSED' });
      }
      if (existing.status === 'COMPLETED') {
        res.setHeader('Idempotent-Replayed', 'true');
        return json(res, 200, existing.evidence!);
      }
      if (existing.status === 'RECONCILIATION_REQUIRED') {
        return reconciliation(res, idempotencyKey);
      }
    }

    const fault = this.faults.shift();
    if (fault === 'http500') {
      this.operations.set(idempotencyKey, {
        path,
        requestHash,
        status: 'FAILED',
      });
      return json(res, 500, { message: 'PSC caído' });
    }
    if (fault === 'http429') {
      res.setHeader('Retry-After', '120');
      return json(res, 429, { message: 'Too Many Requests' });
    }
    if (fault === 'http400') {
      return json(res, 400, { message: 'payload inválido' });
    }
    if (fault === 'reconciliation') {
      this.operations.set(idempotencyKey, {
        path,
        requestHash,
        status: 'RECONCILIATION_REQUIRED',
      });
      return reconciliation(res, idempotencyKey);
    }

    const evidence = this.emit(body, path);
    this.operations.set(idempotencyKey, {
      path,
      requestHash,
      status: 'COMPLETED',
      evidence,
    });

    if (fault === 'emitAndDropResponse') {
      // El PSC emitió, pero la respuesta nunca llega al cliente.
      req.socket.destroy();
      return;
    }
    res.setHeader('Idempotent-Replayed', 'false');
    return json(res, 200, evidence);
  }

  /** Emite una constancia nueva: cada emisión tiene sus propios uuid del PSC. */
  private emit(body: Record<string, unknown>, path: string) {
    this.emissions += 1;
    const canonicalString = `<seal path="${path}">${canonical(body)}</seal>`;
    const hashHex = sha256(canonicalString);
    return {
      documentId: body.documentId,
      hashHex,
      hashAlgorithm: 'sha256',
      hashVersion: 'v1',
      canonicalString: Buffer.from(canonicalString).toString('base64'),
      sealedAt: new Date().toISOString(),
      timeStamp: {
        status: true,
        hashProcessed: hashHex,
        fileBase64: Buffer.from(`tsr-${this.emissions}`).toString('base64'),
        uuid: `ts-${randomUUID()}`,
      },
      nom151: {
        status: true,
        hashProcessed: hashHex,
        file: Buffer.from(`nom151-${this.emissions}`).toString('base64'),
        uuid: `nom-${randomUUID()}`,
        pdfFile: Buffer.from(`pdf-${this.emissions}`).toString('base64'),
      },
    };
  }
}

function reconciliation(res: ServerResponse, idempotencyKey: string) {
  return json(res, 409, {
    code: 'SEAL_RECONCILIATION_REQUIRED',
    status: 'RECONCILIATION_REQUIRED',
    idempotencyKey,
    reasonCode: 'PSC_UNCERTAIN_RESULT',
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** JSON con llaves ordenadas: dos payloads iguales dan el mismo hash. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
