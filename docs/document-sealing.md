# Sellado de documentos: operación y despliegue

Guía interna para quien despliega, diagnostica o recupera el sellado de documentos firmados (sello de tiempo RFC 3161 y constancia NOM-151). No es documentación de la API pública.

## Qué hace

Cuando firma el último firmante, el cierre del documento **no** llama al SAT ni a Seal Service. Registra un trabajo en `document_sealing_jobs`, en la misma transacción que deja el documento en `SIGNED`, y arma la hoja de evidencia sin constancia. Un worker hace el resto:

```text
cierre ──► document_sealing_jobs (PENDING)
               │  cron cada minuto, reclamo con FOR UPDATE SKIP LOCKED
               ▼
         VERIFYING_OCSP ─► GENERATING_SEAL ─► UPDATING_EVIDENCE_PDF ─► COMPLETED
         (sólo avanzada)   (Seal Service,      (hoja con la constancia,
                            Idempotency-Key)    signed_documents → finalized_documents)
```

- **VERIFYING_OCSP** (firma avanzada): consulta al SAT el OCSP de cada firmante que no lo tiene (o que tiene `unknown`) con el certificado público guardado. Guarda cada respuesta en cuanto llega, exige `good` para todos y congela el payload en el bucket privado `sealing-requests`.
- **GENERATING_SEAL**: envía el payload congelado a Seal Service con `Idempotency-Key: signature-server:document:<documentId>:v1` y guarda la constancia en `document_seals`. La firma simple empieza aquí: su payload se congela al cerrar el documento.
- **UPDATING_EVIDENCE_PDF**: lee el PDF de `signed_documents` (sin hoja), comprueba que conserve `signed_hash`, anexa la hoja con la constancia y publica en `finalized_documents`. Repetirlo no acumula hojas.
- **Cierre**: una transacción condicionada al lease deja el trabajo `COMPLETED` y limpia `documents.sealing_pending_at`.

Nunca se vuelve a firmar el documento, no cambia `signed_hash` y no se piden credenciales de e.firma: el OCSP sólo necesita el certificado público.

## Estados y fases

| `status`                  | Significado                                                  | ¿El worker lo toma?                                |
| ------------------------- | ------------------------------------------------------------ | -------------------------------------------------- |
| `PENDING`                 | Recién registrado.                                           | Sí, cuando llega `next_attempt_at`.                |
| `PROCESSING`              | Lo tiene un worker (`lease_token`) hasta `lease_expires_at`. | Sólo si el lease venció (recuperación).            |
| `RETRY_SCHEDULED`         | Falló por algo transitorio; espera su backoff.               | Sí, cuando llega `next_attempt_at`.                |
| `COMPLETED`               | Tiene constancia y el PDF final la muestra.                  | No.                                                |
| `DEAD`                    | Fallo terminal o intentos agotados.                          | No. Ver [Reactivar trabajos](#reactivar-trabajos). |
| `RECONCILIATION_REQUIRED` | Resultado incierto o datos que no corresponden.              | No. Ver [Conciliación](#conciliación).             |

`phase` (`VERIFYING_OCSP`, `GENERATING_SEAL`, `UPDATING_EVIDENCE_PDF`) es el paso pendiente y nunca retrocede. Un trabajo `DEAD` o en conciliación conserva su fase, su payload (`request_object_key`, `request_hash`) y la evidencia ya obtenida.

La vista pública expone `sealingStatus` (`NOT_REQUIRED`, `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED` = `DEAD`, `RECONCILIATION_REQUIRED`) sin detalles del error. Abrirla no dispara ningún proceso.

### Política de errores

| Condición                                                                                                   | Resultado                                                                               |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Timeout o red con Seal Service                                                                              | Reintento. El siguiente intento consulta `GET /seal/operations/:key` antes de reenviar. |
| Seal Service `429` o `5xx`                                                                                  | Reintento, respetando `Retry-After` (máximo 12 h).                                      |
| SAT no disponible o respuesta OCSP inválida                                                                 | Reintento.                                                                              |
| OCSP `unknown`                                                                                              | Reintento acotado: 3 ejecuciones y después `DEAD`. Nunca cuenta como `good`.            |
| Certificado revocado o cadena inválida                                                                      | `DEAD`, sin emisión.                                                                    |
| Seal Service `400`/`422`, evidencia incompleta                                                              | `DEAD`: el payload requiere corrección.                                                 |
| Seal Service `401`/`403`/`404`, falta configuración                                                         | `DEAD`: intervención operativa.                                                         |
| `409 SEAL_RECONCILIATION_REQUIRED`, `409 IDEMPOTENCY_KEY_REUSED`, payload o PDF firmado que no corresponden | `RECONCILIATION_REQUIRED`.                                                              |
| BD, MinIO o error no clasificado                                                                            | Reintento hasta el tope general.                                                        |

Backoff tras cada fallo reintentable: 1 min, 5 min, 15 min, 1 h, 4 h, 12 h, 12 h (±20 %). Con `SEALING_MAX_ATTEMPTS=8` el octavo fallo deja el trabajo `DEAD`.

## Configuración

| Variable                                   | Por omisión        | Uso                                                                                          |
| ------------------------------------------ | ------------------ | -------------------------------------------------------------------------------------------- |
| `SEALING_WORKER_ENABLED`                   | `false`            | Activa el cron. Apagarlo detiene ejecuciones nuevas sin perder pendientes.                   |
| `SEALING_BATCH_SIZE`                       | `10`               | Trabajos como máximo por pasada.                                                             |
| `SEALING_CONCURRENCY`                      | `2`                | Trabajos en paralelo por instancia. Sólo se reclaman los que se van a ejecutar de inmediato. |
| `SEALING_MAX_ATTEMPTS`                     | `8`                | Ejecuciones totales, incluida la primera.                                                    |
| `SEALING_LEASE_SECONDS`                    | `120`              | Duración del reclamo.                                                                        |
| `SEALING_HEARTBEAT_SECONDS`                | `30`               | Renovación del reclamo; debe ser menor que el lease.                                         |
| `SEAL_SERVICE_URL`, `SEAL_SERVICE_API_KEY` | —                  | Seal Service.                                                                                |
| `MINIO_SEALING_REQUESTS_BUCKET`            | `sealing-requests` | Bucket privado de payloads congelados.                                                       |

Un valor inválido detiene el arranque. Varias instancias pueden tener el worker activo: Postgres reparte los trabajos.

En **seal-service**: `SEAL_DB_URL` (obligatoria, su propia base), `PSC_CODEX_MODE` (`mock` por omisión; `live` llama al PSC), `PSC_CODEX_TIMEOUT_MS`, `API_CLIENT_ID`.

## Despliegue y activación

El orden importa: el worker reintenta, y sin el contrato idempotente un reintento podría pedir otra constancia.

1. **Seal Service con idempotencia**: desplegarlo con su base (`SEAL_DB_URL`) y comprobar `GET /seal/operations/<clave>` (debe responder `404 NOT_FOUND` para una clave desconocida). En producción, `PSC_CODEX_MODE=live`.
2. **signature-server con `SEALING_WORKER_ENABLED=false`**: aplica las migraciones al arrancar (`document_sealing_jobs`). Desde aquí los cierres ya registran trabajos; esperan sin perderse.
3. **Recuperación histórica** en modo prueba y después real (ver abajo).
4. **Activar el worker** en una instancia (`SEALING_WORKER_ENABLED=true`), vigilar los primeros `sealing_job.*` en los logs y después en el resto.

Para pausarlo, `SEALING_WORKER_ENABLED=false` y reiniciar. Un trabajo que quedó en `PROCESSING` se recupera cuando vence su lease.

## Diagnóstico

### Logs

Una línea JSON por evento, sin datos personales ni cuerpos del proveedor:

| `event`                            | Cuándo                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `sealing_job.completed`            | Trabajo terminado (`durationMs`).                                                                        |
| `sealing_job.failed`               | Intento fallido: `phase`, `kind`, `errorCode`, `upstreamStatus`, `status`, `exhausted`, `nextAttemptAt`. |
| `sealing_job.lease_lost`           | El trabajo pasó a otro worker; éste dejó de escribir.                                                    |
| `sealing_job.failure_not_recorded` | No se pudo registrar el fallo (BD); el lease vencerá y otro lo recuperará.                               |
| `sealing_worker.run`               | Resumen de una pasada con trabajos.                                                                      |
| `sealing_backfill.*`               | Recuperación histórica.                                                                                  |

### Consultas

```sql
-- Panorama
SELECT status, phase, count(*) FROM document_sealing_jobs GROUP BY 1, 2 ORDER BY 1, 2;

-- Pendientes y su próximo intento
SELECT id, document_id, status, phase, attempt_count, next_attempt_at, last_error_code
  FROM document_sealing_jobs
 WHERE status IN ('PENDING', 'RETRY_SCHEDULED')
 ORDER BY next_attempt_at;

-- Terminales y en conciliación, con su diagnóstico
SELECT id, document_id, status, phase, attempt_count, last_error_code,
       last_upstream_status, last_error_message, updated_at
  FROM document_sealing_jobs
 WHERE status IN ('DEAD', 'RECONCILIATION_REQUIRED')
 ORDER BY updated_at DESC;

-- En proceso con el lease vencido (deberían recuperarse en el siguiente minuto)
SELECT id, document_id, phase, attempt_count, lease_expires_at
  FROM document_sealing_jobs
 WHERE status = 'PROCESSING' AND lease_expires_at < now();

-- Documentos esperando constancia sin trabajo (candidatos de la recuperación histórica)
SELECT d.id, d.sealing_pending_at
  FROM documents d
 WHERE d.status = 'SIGNED' AND d.sealing_pending_at IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM document_sealing_jobs j WHERE j.document_id = d.id)
   AND NOT EXISTS (SELECT 1 FROM document_seals s WHERE s.document_id = d.id);
```

## Recuperación histórica

Registra el trabajo de los documentos firmados antes de `document_sealing_jobs` que siguen esperando constancia.

```bash
npm run sealing:backfill -- --dry-run            # sólo informa
npm run sealing:backfill -- --limit=200          # registra
npm run sealing:backfill:prod -- --dry-run       # en la imagen, sobre dist/
```

- Sólo toma documentos `SIGNED` con `sealing_pending_at`, sin trabajo y sin constancia. Un documento sin sello y sin esa marca no se toca: puede no ser elegible.
- Biométricos o sin hash: `NOT_ELIGIBLE`, sin registrar nada.
- Firma simple sin evidencia completa: el trabajo nace en `RECONCILIATION_REQUIRED` (`SIMPLE_EVIDENCE_INCOMPLETE`).
- Repetirlo es seguro: un documento con trabajo deja de ser candidato.
- Sale con código 1 si algún documento falló; el resumen va en `sealing_backfill.summary`.

## Reactivar trabajos

Para un trabajo `DEAD` cuya causa ya se corrigió (credenciales, configuración, un `400` de un payload que se arregló en Seal Service):

**Nunca borres el trabajo para "empezar de cero".** Perderías la fase, la referencia y el hash del payload congelado, y el diagnóstico. En firma simple, un registro nuevo congelaría otro payload, y Seal Service lo rechazaría como `IDEMPOTENCY_KEY_REUSED` porque la clave del documento ya se usó. La clave deriva del `documentId`, así que reactivar el mismo trabajo la conserva.

Procedimiento, uno por uno y con el motivo:

```sql
BEGIN;
UPDATE document_sealing_jobs
   SET status = 'RETRY_SCHEDULED',
       next_attempt_at = now(),
       -- Deja N ejecuciones más (aquí 3) si se agotaron; si no, no lo toques.
       attempt_count = LEAST(attempt_count, 8 - 3),
       -- Conserva el diagnóstico anterior y deja constancia de la reactivación.
       last_error_message = format('[Reactivado %s por %s: %s] %s',
                                   now()::date, '<persona>', '<motivo>', last_error_message)
 WHERE id = '<job-id>' AND status = 'DEAD';
-- Verifica que tocó exactamente una fila antes de confirmar.
COMMIT;
```

`last_error_code` se deja como estaba: lo reemplaza el siguiente fallo, si lo hay. No reactives trabajos `OCSP_CERTIFICATE_REVOKED`: el certificado no se va a des-revocar.

## Conciliación

`RECONCILIATION_REQUIRED` significa que repetir a ciegas podría duplicar una constancia o sellar datos equivocados. Según `last_error_code`:

**`SEAL_RECONCILIATION_REQUIRED`**: Seal Service no sabe si el PSC emitió (timeout, `5xx` o respuesta perdida a mitad de un paso). Consulta la operación:

```bash
curl -s "$SEAL_SERVICE_URL/seal/operations/signature-server:document:<documentId>:v1" \
  -H "x-api-key: $SEAL_SERVICE_API_KEY"
```

| `status` en Seal Service  | Qué hacer                                                                                                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPLETED`               | Reactiva el trabajo: el reenvío devuelve la misma evidencia sin emitir.                                                                                                                                                                                                         |
| `PROCESSING`              | Espera a que termine o venza su lease, y vuelve a consultar.                                                                                                                                                                                                                    |
| `FAILED` o `NOT_FOUND`    | No se emitió: reactiva el trabajo.                                                                                                                                                                                                                                              |
| `RECONCILIATION_REQUIRED` | Usa `provider.timeStampUuid` / `nom151Uuid`, si los hay, para consultar al PSC si emitió. Seal Service todavía **no tiene herramienta** para cerrar esa operación: se resuelve sobre su tabla `seal_operations` con un procedimiento revisado y después se reactiva el trabajo. |

**`SEAL_PAYLOAD_CONFLICT`**: la clave ya se usó con otro payload. Compara el payload congelado (`request_object_key`) con lo que recibió Seal Service; no cambies la clave ni borres el trabajo.

**`SEALING_REQUEST_UNAVAILABLE`**: el payload congelado no existe o no coincide con `request_hash`. **`SIGNED_PDF_INTEGRITY_MISMATCH`**: el PDF de `signed_documents` ya no tiene `signed_hash`. Ambos son incidentes de integridad: investigar antes de cualquier acción.

**`SIMPLE_EVIDENCE_INCOMPLETE`** (al cerrar o en la recuperación histórica): a un firmante le falta CURP, INE, rúbrica o código consumido. No se corrige reintentando.

## Limitaciones del contrato con el PSC

- El PSC no acepta claves de idempotencia ni permite buscar por hash: sólo se consulta por el `uuid` que devuelve al emitir. Si la respuesta se pierde antes de conocer el `uuid`, la operación queda en conciliación.
- El PSC responde `409` cuando un hash ya se registró; Seal Service lo trata como resultado incierto, no como éxito.
- La consulta `GET /seal/operations/:key` no devuelve la cadena canónica (en firma simple contiene datos personales). Para persistirla, el worker reenvía el mismo payload y Seal Service la reconstruye.
- `PSC_CODEX_MODE=mock` (por omisión en seal-service) emite evidencia simulada: en producción debe ser `live`.

## Pruebas

```bash
npm run build
npm test -- --runInBand --watchman=false src/document/seal
npm run test:e2e -- --runInBand --watchman=false \
  test/document-sealing.e2e-spec.ts \
  test/document-sealing-concurrency.e2e-spec.ts
```

- Las e2e crean una **base aislada** con nombre único en el servidor de `POSTGRES_DB_URL`, le aplican todas las migraciones y la borran al terminar. El usuario necesita permiso para `CREATE DATABASE`. No usan datos existentes.
- Ni el SAT ni el PSC participan. `test/fixtures/sealing/` trae un servidor HTTP con el contrato idempotente de Seal Service y fallos programables (`seal-provider.stub.ts`), un adaptador OCSP programable (`ocsp.stub.ts`), MinIO en memoria y certificados autofirmados de prueba sin llave privada.
- `document-sealing.e2e-spec.ts` cubre la matriz de recuperación (SAT caído y recuperado, firmante sin evidencia, revocación, Seal Service caído, respuesta perdida, BD caída tras emitir, PDF caído, reinicio, dos workers, intentos agotados, resultado incierto, firma simple reintentada) y la hoja, `signed_hash` y la vista pública.
- `document-sealing-concurrency.e2e-spec.ts` usa conexiones independientes (un pool por "instancia") para unicidad, rollback, `FOR UPDATE SKIP LOCKED`, expiración de lease y escrituras condicionadas al propietario.
- La idempotencia del propio Seal Service se prueba en su repositorio (`seal-service/test/seal-operations.e2e-spec.ts`).
