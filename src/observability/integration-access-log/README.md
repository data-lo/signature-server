# Log de acceso de la API de integración (`integration.http_request`)

Una línea JSON por cada petición a `/api/v1/integration/*`, escrita en la salida estándar al cerrarse la respuesta. Sirve para que soporte e ingeniería encuentren una petición de un cliente por su `X-Request-Id`, su API key o su documento, también cuando fue rechazada antes del controller.

Lo escribe `IntegrationAccessLogMiddleware`, montado en `main.ts` justo después del contexto de petición (`applyRequestContext`). No cambia las métricas de Prometheus ni los demás logs del servidor.

## Ejemplo

```json
{"timestamp":"2026-11-14T18:03:12.418Z","level":"info","event":"integration.http_request","requestId":"erp-20261114-7f3c2a9d","method":"POST","route":"/api/v1/integration/documents","statusCode":201,"durationMs":842,"outcome":"success","apiKeyId":"0b3f7c2e-9a51-4f0e-8d2c-1e6b5a4c3d2f","organizationId":"7d1e2f3a-4b5c-4d6e-8f90-a1b2c3d4e5f6","documentId":"2be3b9d7-4c5d-4e6f-8a9b-0c1d2e3f4a5b","ip":"203.0.113.7","errorCode":null,"idempotencyReplayed":false}
```

## Esquema

Los campos obligatorios aparecen siempre; si un valor no se conoce o no cumple su formato, va `null`. Los opcionales se omiten cuando no aplican.

| Campo | Tipo | Origen | Notas |
|---|---|---|---|
| `timestamp` | ISO 8601 UTC | logger | Momento en que se escribe la línea, al cerrarse la respuesta. |
| `level` | `info` \| `warn` \| `error` | logger | `error` para 5xx, `warn` para `client_closed` e `info` para el resto, 4xx incluidos. |
| `event` | `"integration.http_request"` | fijo | Clave para filtrar. |
| `requestId` | string | `RequestContextService` | Igual al header `X-Request-Id` de la respuesta. |
| `method` | string | Express | |
| `route` | string | `request.route.path` | Plantilla de la ruta (`/api/v1/integration/documents/:documentId/signing-access`), nunca la URL real. `unmatched` si la ruta no existe. |
| `statusCode` | number | respuesta | 499 si el cliente cortó antes de recibirla. |
| `durationMs` | number entero | middleware | Desde la entrada al servidor hasta el cierre de la respuesta. |
| `outcome` | `success` \| `client_error` \| `server_error` \| `client_closed` | `statusCode` | |
| `apiKeyId` | UUID \| null | `request.apiClient` | `null` si la llave no autenticó (401). |
| `organizationId` | UUID \| null | `request.apiClient` | Ídem. |
| `documentId` | UUID \| null | `:documentId` de la ruta o documento creado por `POST /documents` | Nunca se lee del body. |
| `ip` | IP \| null | `request.clientIp`; en un rechazo temprano, el socket | Ver «Limitaciones». |
| `errorCode` | string \| null | `IntegrationErrorFilter` | El `error.code` que recibió el cliente (`API_KEY_INVALID`, `INVALID_PAYLOAD`…). |
| `idempotencyReplayed` | boolean, opcional | `POST /documents` | `true` si se devolvió un documento ya creado con el mismo `Idempotency-Key`. |
| `errorType` | string, opcional | `IntegrationErrorFilter` o métricas | Clase de la excepción (`InvalidApiKeyException`). Sólo en respuestas ≥ 400, sin mensaje ni stack. |

`kafkaEventId` no se registra: el alta no lo devuelve hasta el controller, y obtenerlo acoplaría el log a la outbox. Para seguir un documento hasta sus eventos se usa `documentId`.

## Qué nunca se registra

Ni `X-API-Key` (ni su `publicId` ni fragmentos del secreto), `Authorization`, cookies, `Idempotency-Key`, query string, body, campos multipart, PDF, nombres de archivo, correos, nombres de firmantes, mensajes de excepción ni stack traces.

Dos capas lo garantizan:

1. El middleware sólo lee datos ya resueltos (`request.apiClient`, `request.clientIp`, `request.params.documentId` y lo anotado con `annotateIntegrationAccess`), nunca headers ni body.
2. `buildIntegrationAccessLogEvent` arma el evento con lista blanca de campos y valida el formato de cada uno: UUID, IP, código en `MAYÚSCULAS_CON_GUIONES`, plantilla de ruta. Lo que no cumple se registra como `null`.

Los stack traces de los 5xx siguen en el log de `IntegrationErrorFilter`, como antes; se correlacionan por hora y ruta. Ese log no lleva `requestId` todavía.

## Retención recomendada

El evento no lleva datos de firmantes, pero `ip`, junto con `organizationId`, es un dato personal para la LFPDPPP.

- **30 días** consultables en el agregador, que cubren los reclamos de soporte y los incidentes.
- **Hasta 180 días** archivados (almacenamiento frío) si auditoría o un cliente lo piden, con acceso restringido.
- Después, borrar. Si hace falta tráfico histórico, conservar sólo agregados sin `ip` ni `requestId`, o usar las métricas de Prometheus.

El plazo se configura en el agregador (Loki, CloudWatch, Datadog…), no en el servidor.

## Consultas recomendadas

Con Loki (LogQL), suponiendo la etiqueta `container="signature-server"`:

```logql
# Una petición reportada por un cliente
{container="signature-server"} | json | event="integration.http_request" | requestId="erp-20261114-7f3c2a9d"

# Errores de servidor de una organización
{container="signature-server"} | json | event="integration.http_request" | organizationId="7d1e2f3a-4b5c-4d6e-8f90-a1b2c3d4e5f6" | outcome="server_error"

# Todo lo que pasó con un documento
{container="signature-server"} | json | event="integration.http_request" | documentId="2be3b9d7-4c5d-4e6f-8a9b-0c1d2e3f4a5b"

# Llaves inválidas por IP en la última hora (posible abuso)
sum by (ip) (count_over_time({container="signature-server"} | json | event="integration.http_request" | errorCode="API_KEY_INVALID" [1h]))

# p95 de duración por ruta
quantile_over_time(0.95, {container="signature-server"} | json | event="integration.http_request" | unwrap durationMs [5m]) by (route)
```

Sin agregador, desde el host:

```bash
docker logs signature-server 2>/dev/null \
  | grep '"event":"integration.http_request"' \
  | jq 'select(.requestId == "erp-20261114-7f3c2a9d")'
```

Para volumen, latencia y tasa de error, usar Prometheus (`http_requests_total`, `http_request_duration_seconds`). Este log es para buscar peticiones concretas, no para paneles.

## Limitaciones

- **IP en rechazos tempranos.** Si la petición no llega a `RequestIpInterceptor` (401/403 del guard, ruta inexistente, body mal formado), `ip` es la dirección del socket. Detrás del proxy es la IP del proxy: no se leen `X-Forwarded-For` ni otros headers que el cliente controla. `RequestIpInterceptor` sí lee `X-Forwarded-For` sin validar el proxy; corregirlo es otra historia.
- **`errorCode` fuera de los filtros.** Un 404 de ruta inexistente o un 400 de JSON mal formado no pasan por `IntegrationErrorFilter`: llevan `errorCode: null`.
- **Documentación Swagger.** `/api/v1/integration/docs`, `/docs-json`, `/docs-yaml` y sus estáticos no se registran: no son la API y no llevan API key.

## Agregar un dato

1. Agrega el campo a `IntegrationAccessLogEvent` y, si lo anota otra pieza, a `IntegrationAccessAnnotations`.
2. Valida su formato en `buildIntegrationAccessLogEvent`. Nunca lo copies sin validar.
3. Anótalo con `annotateIntegrationAccess(request, …)` donde se conozca. No lo agregues al `Request`.
4. Agrega el caso a las pruebas de no filtración (`integration-access-log.sanitizer.spec.ts` y `test/integration-access-log.e2e-spec.ts`).
