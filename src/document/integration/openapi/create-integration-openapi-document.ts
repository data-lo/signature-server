import { OpenAPIObject } from '@nestjs/swagger';
import {
  ParameterObject,
  ReferenceObject,
} from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

import {
  INTEGRATION_API_KEY_SECURITY,
  INTEGRATION_API_KEY_SECURITY_SCHEME,
  INTEGRATION_DOCUMENTS_TAG,
} from '../docs/api-integration-documents-common.docs';
import {
  EXAMPLE_IDEMPOTENCY_KEY,
  EXAMPLE_INTEGRATION_API_KEY,
} from '../docs/api-integration-examples.docs';

/** Prefijo de las rutas que se publican: sólo la API de integración. */
export const INTEGRATION_OPENAPI_PATH_PREFIX = '/api/v1/integration/';

/** Título del contrato para clientes. */
export const INTEGRATION_OPENAPI_TITLE = 'Firmalo Integration API';

/** Métodos HTTP de un `PathItemObject`; lo demás (`parameters`, `summary`…) no es una operación. */
const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

const SCHEMA_REF_PREFIX = '#/components/schemas/';

/**
 * Headers que Nest documenta solo por leerlos con `@Headers()` y que el cliente no elige: los pone
 * su cliente HTTP. Swagger los marca obligatorios, así que se quitan del contrato.
 */
const TRANSPORT_HEADERS = new Set(['user-agent']);

/** Descripción del contrato: lo que un cliente necesita antes de la primera llamada. */
const INTEGRATION_OPENAPI_DESCRIPTION = [
  'API para que tu sistema cree documentos PDF con su flujo de firmas, consulte su estado y gestione el acceso de los firmantes en Firmalo.',
  '**Autenticación.** Todas las rutas usan la API key de tu organización en el header `X-API-Key`, con formato `fma_live_<publicId>_<secret>`. Pégala en «Authorize» para probar desde esta página. Ejemplo (no es una llave real):',
  `\`X-API-Key: ${EXAMPLE_INTEGRATION_API_KEY}\``,
  '**Idempotencia.** `POST /integration/documents` exige `Idempotency-Key`: repetir la petición con la misma clave y el mismo contenido devuelve el documento original, sin crear ni cobrar otro. Ejemplo:',
  `\`Idempotency-Key: ${EXAMPLE_IDEMPOTENCY_KEY}\``,
  '**Errores.** Todos tienen la forma `{ "success": false, "error": { "code", "message", "details" } }`, con un `code` estable para decidir qué hacer sin depender del texto.',
].join('\n\n');

/**
 * Crea el contrato OpenAPI que se publica a los clientes de la API de integración a partir del
 * documento Swagger general.
 *
 * Es una función pura: no toca `source` (trabaja sobre una copia) y el resultado sólo depende de
 * él. Del documento general conserva:
 * - los `paths` que empiezan con `/api/v1/integration/`;
 * - en cada operación, sólo el tag `Integration Documents` y la seguridad `integration-api-key`
 *   (cualquier otra —JWT, `x-api-key` interna— se descarta), y un solo parámetro por header (ver
 *   `cleanHeaderParameters`);
 * - en `components`, sólo el esquema de seguridad `X-API-Key` y los esquemas alcanzables desde
 *   esas operaciones (DTOs y respuestas de integración, con sus dependencias).
 *
 * El título, la descripción y la seguridad global son los del contrato de clientes, no los del
 * documento general. No lleva `servers`: Swagger UI usa el host desde el que se abre.
 *
 * @param source - Documento generado por `SwaggerModule.createDocument`.
 * @returns El contrato OpenAPI de integración, listo para `SwaggerModule.setup`.
 *
 * @example
 * ```ts
 * const integrationDocument = createIntegrationOpenApiDocument(publicDocument);
 * SwaggerModule.setup(`${GLOBAL_API_PREFIX}/integration/docs`, app, integrationDocument);
 * ```
 */
export function createIntegrationOpenApiDocument(
  source: OpenAPIObject,
): OpenAPIObject {
  const copy: OpenAPIObject = structuredClone(source);

  const paths: OpenAPIObject['paths'] = {};
  for (const [path, pathItem] of Object.entries(copy.paths ?? {})) {
    if (!path.startsWith(INTEGRATION_OPENAPI_PATH_PREFIX)) continue;

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;
      operation.tags = [INTEGRATION_DOCUMENTS_TAG];
      operation.security = [{ [INTEGRATION_API_KEY_SECURITY]: [] }];
      if (operation.parameters) {
        operation.parameters = cleanHeaderParameters(operation.parameters);
      }
    }
    paths[path] = pathItem;
  }

  const sourceTag = copy.tags?.find(
    (tag) => tag.name === INTEGRATION_DOCUMENTS_TAG,
  );

  return {
    openapi: copy.openapi,
    info: {
      title: INTEGRATION_OPENAPI_TITLE,
      description: INTEGRATION_OPENAPI_DESCRIPTION,
      version: copy.info?.version ?? '1.0',
    },
    tags: [
      sourceTag ?? {
        name: INTEGRATION_DOCUMENTS_TAG,
        description:
          'Documentos, firmantes y accesos de firma de tu organización',
      },
    ],
    security: [{ [INTEGRATION_API_KEY_SECURITY]: [] }],
    paths,
    components: {
      securitySchemes: {
        [INTEGRATION_API_KEY_SECURITY]: INTEGRATION_API_KEY_SECURITY_SCHEME,
      },
      schemas: collectReferencedSchemas(paths, copy.components?.schemas ?? {}),
    },
  };
}

/**
 * Deja un parámetro por header y quita los de transporte.
 *
 * `@Headers('idempotency-key')` hace que Nest documente el header por su cuenta, en minúsculas y
 * sin descripción, además del `@ApiHeader` que sí lo explica: el cliente vería dos campos
 * obligatorios. Los nombres de header no distinguen mayúsculas, así que se conserva el documentado
 * (el que tiene descripción) y se descarta el otro.
 *
 * @param parameters - Parámetros de la operación.
 * @returns Los mismos, sin headers repetidos ni de transporte.
 *
 * @example
 * ```ts
 * cleanHeaderParameters([{ name: 'idempotency-key', in: 'header' }, { name: 'Idempotency-Key', in: 'header', description: '…' }]);
 * // [{ name: 'Idempotency-Key', in: 'header', description: '…' }]
 * ```
 */
function cleanHeaderParameters(
  parameters: (ParameterObject | ReferenceObject)[],
): (ParameterObject | ReferenceObject)[] {
  const documented = new Map<string, ParameterObject>();
  for (const parameter of parameters) {
    if (!isHeader(parameter)) continue;
    const name = parameter.name.toLowerCase();
    const current = documented.get(name);
    if (!current || (!current.description && parameter.description)) {
      documented.set(name, parameter);
    }
  }

  return parameters.filter((parameter) => {
    if (!isHeader(parameter)) return true;
    const name = parameter.name.toLowerCase();
    return !TRANSPORT_HEADERS.has(name) && documented.get(name) === parameter;
  });
}

function isHeader(
  parameter: ParameterObject | ReferenceObject,
): parameter is ParameterObject {
  return 'in' in parameter && parameter.in === 'header';
}

/**
 * Los esquemas que alcanzan las operaciones conservadas, siguiendo los `$ref` de esquema en esquema.
 *
 * @param paths - Operaciones ya filtradas.
 * @param schemas - Todos los esquemas del documento general.
 * @returns Sólo los referenciados, directa o transitivamente.
 *
 * @example
 * ```ts
 * collectReferencedSchemas(paths, document.components.schemas);
 * ```
 */
function collectReferencedSchemas(
  paths: OpenAPIObject['paths'],
  schemas: NonNullable<OpenAPIObject['components']>['schemas'],
): NonNullable<OpenAPIObject['components']>['schemas'] {
  const kept: NonNullable<OpenAPIObject['components']>['schemas'] = {};
  const pending = [...findSchemaRefs(paths)];

  while (pending.length > 0) {
    const name = pending.pop()!;
    if (name in kept || !(name in schemas)) continue;
    kept[name] = schemas[name];
    pending.push(...findSchemaRefs(schemas[name]));
  }

  return Object.fromEntries(
    Object.keys(kept)
      .sort()
      .map((name) => [name, kept[name]]),
  );
}

/**
 * Nombres de los esquemas referenciados (`#/components/schemas/<Nombre>`) dentro de un valor.
 *
 * @param value - Cualquier parte del documento.
 * @param found - Acumulador de la recursión; se omite al llamar.
 * @returns Los nombres encontrados, sin repetir.
 *
 * @example
 * ```ts
 * findSchemaRefs({ $ref: '#/components/schemas/IntegrationErrorResponseDto' }); // Set { 'IntegrationErrorResponseDto' }
 * ```
 */
export function findSchemaRefs(
  value: unknown,
  found = new Set<string>(),
): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) findSchemaRefs(item, found);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (
        key === '$ref' &&
        typeof child === 'string' &&
        child.startsWith(SCHEMA_REF_PREFIX)
      ) {
        found.add(child.slice(SCHEMA_REF_PREFIX.length));
      } else {
        findSchemaRefs(child, found);
      }
    }
  }
  return found;
}
