import {
  ConflictException,
  ForbiddenException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';

/**
 * Códigos estables de error de la administración de API keys. Viajan en `code`, junto al
 * `message` legible, para que el frontend decida qué mostrar sin depender del texto.
 */
export enum API_KEY_ERROR_CODE_ENUM {
  ORGANIZATION_NOT_FOUND = 'ORGANIZATION_NOT_FOUND',
  API_KEY_NOT_FOUND = 'API_KEY_NOT_FOUND',
  API_KEY_ALREADY_ACTIVE = 'API_KEY_ALREADY_ACTIVE',
  API_KEY_ROTATION_CONFLICT = 'API_KEY_ROTATION_CONFLICT',
  API_KEY_PERMISSION_NOT_FOUND = 'API_KEY_PERMISSION_NOT_FOUND',
  API_KEY_PERMISSION_NOT_ALLOWED = 'API_KEY_PERMISSION_NOT_ALLOWED',
  API_KEY_INVALID_EXPIRATION = 'API_KEY_INVALID_EXPIRATION',
  API_KEY_INVALID_BODY = 'API_KEY_INVALID_BODY',
  API_KEY_NOT_CONFIGURED = 'API_KEY_NOT_CONFIGURED',
  API_KEY_INVALID = 'API_KEY_INVALID',
  API_KEY_EXPIRED = 'API_KEY_EXPIRED',
  API_KEY_ORGANIZATION_INACTIVE = 'API_KEY_ORGANIZATION_INACTIVE',
  API_KEY_ACTOR_INACTIVE = 'API_KEY_ACTOR_INACTIVE',
  API_KEY_PERMISSION_DENIED = 'API_KEY_PERMISSION_DENIED',
}

/**
 * Cuerpo de error de estos endpoints: el de Nest más `code`.
 *
 * `code` es texto y no `API_KEY_ERROR_CODE_ENUM` para que la API de integración (que autentica con
 * estas llaves) responda con el mismo cuerpo y sus propios códigos.
 */
export interface ApiKeyErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  code: string;
}

/**
 * Arma el cuerpo de error con su código.
 *
 * @param statusCode - Estado HTTP.
 * @param error - Nombre del estado (`'Conflict'`, `'Not Found'`…).
 * @param message - Mensaje legible, o la lista de errores de validación.
 * @param code - Código estable del error.
 * @returns El cuerpo que recibe el cliente.
 *
 * @example
 * ```ts
 * buildApiKeyErrorBody(409, 'Conflict', 'Ya hay una llave', API_KEY_ERROR_CODE_ENUM.API_KEY_ALREADY_ACTIVE);
 * ```
 */
export function buildApiKeyErrorBody(
  statusCode: number,
  error: string,
  message: string | string[],
  code: string,
): ApiKeyErrorBody {
  return { statusCode, error, message, code };
}

/** La organización de la ruta no existe o está desactivada. */
export class ApiKeyOrganizationNotFoundException extends NotFoundException {
  constructor() {
    super(
      buildApiKeyErrorBody(
        HttpStatus.NOT_FOUND,
        'Not Found',
        'La organización no existe',
        API_KEY_ERROR_CODE_ENUM.ORGANIZATION_NOT_FOUND,
      ),
    );
  }
}

/** No hay llave vigente, o la llave pedida no existe en esta organización. */
export class ApiKeyNotFoundException extends NotFoundException {
  constructor(message = 'La API key no existe') {
    super(
      buildApiKeyErrorBody(
        HttpStatus.NOT_FOUND,
        'Not Found',
        message,
        API_KEY_ERROR_CODE_ENUM.API_KEY_NOT_FOUND,
      ),
    );
  }
}

/**
 * La organización ya tiene una llave `ACTIVE`. También es lo que se responde cuando dos altas
 * simultáneas chocan contra `uq_api_keys_one_active_per_organization`.
 */
export class ApiKeyAlreadyActiveException extends ConflictException {
  constructor() {
    super(
      buildApiKeyErrorBody(
        HttpStatus.CONFLICT,
        'Conflict',
        'La organización ya tiene una API key activa. Rótala o revócala antes de crear otra.',
        API_KEY_ERROR_CODE_ENUM.API_KEY_ALREADY_ACTIVE,
      ),
    );
  }
}

/** Otra rotación o alta de la misma organización está en curso. */
export class ApiKeyRotationConflictException extends ConflictException {
  constructor() {
    super(
      buildApiKeyErrorBody(
        HttpStatus.CONFLICT,
        'Conflict',
        'Hay otra operación sobre la API key de la organización en curso. Vuelve a intentarlo.',
        API_KEY_ERROR_CODE_ENUM.API_KEY_ROTATION_CONFLICT,
      ),
    );
  }
}

/** Alguno de los `permissionIds` no existe en el catálogo. */
export class ApiKeyPermissionNotFoundException extends UnprocessableEntityException {
  constructor(permissionIds: string[]) {
    super(
      buildApiKeyErrorBody(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Unprocessable Entity',
        `Estos permisos no existen: ${permissionIds.join(', ')}`,
        API_KEY_ERROR_CODE_ENUM.API_KEY_PERMISSION_NOT_FOUND,
      ),
    );
  }
}

/** Alguno de los permisos existe pero no se puede conceder a una API key. */
export class ApiKeyPermissionNotAllowedException extends UnprocessableEntityException {
  constructor(permissionKeys: string[]) {
    super(
      buildApiKeyErrorBody(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Unprocessable Entity',
        `Estos permisos no se pueden conceder a una API key: ${permissionKeys.join(', ')}`,
        API_KEY_ERROR_CODE_ENUM.API_KEY_PERMISSION_NOT_ALLOWED,
      ),
    );
  }
}

/** `expiresAt` no es posterior al momento de la petición. */
export class ApiKeyInvalidExpirationException extends UnprocessableEntityException {
  constructor() {
    super(
      buildApiKeyErrorBody(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Unprocessable Entity',
        'La fecha de expiración debe ser futura',
        API_KEY_ERROR_CODE_ENUM.API_KEY_INVALID_EXPIRATION,
      ),
    );
  }
}

/**
 * Falta `API_KEY_PEPPER` en el servidor. Es un error de despliegue, no del cliente, y el mensaje
 * no dice cuál es la variable.
 */
export class ApiKeyNotConfiguredException extends InternalServerErrorException {
  constructor() {
    super(
      buildApiKeyErrorBody(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'Internal Server Error',
        'La emisión de API keys no está disponible en este momento',
        API_KEY_ERROR_CODE_ENUM.API_KEY_NOT_CONFIGURED,
      ),
    );
  }
}

/**
 * `X-API-Key` falta, no tiene el formato de una llave de la plataforma, no existe, su secreto no
 * coincide o está revocada. Un solo mensaje para todos: distinguirlos ayudaría a quien prueba
 * llaves a ciegas.
 */
export class InvalidApiKeyException extends UnauthorizedException {
  constructor() {
    super(
      buildApiKeyErrorBody(
        HttpStatus.UNAUTHORIZED,
        'Unauthorized',
        'API key inválida o revocada',
        API_KEY_ERROR_CODE_ENUM.API_KEY_INVALID,
      ),
    );
  }
}

/**
 * La llave es auténtica pero pasó su `expiresAt`. Se dice aparte del caso inválido porque quien
 * llega aquí ya demostró tener el secreto, y lo que necesita saber es que debe rotarla.
 */
export class ExpiredApiKeyException extends UnauthorizedException {
  constructor() {
    super(
      buildApiKeyErrorBody(
        HttpStatus.UNAUTHORIZED,
        'Unauthorized',
        'La API key venció. Genera una nueva desde Integraciones.',
        API_KEY_ERROR_CODE_ENUM.API_KEY_EXPIRED,
      ),
    );
  }
}

/** La organización de la llave está desactivada. */
export class ApiKeyOrganizationInactiveException extends ForbiddenException {
  constructor() {
    super(
      buildApiKeyErrorBody(
        HttpStatus.FORBIDDEN,
        'Forbidden',
        'La organización de esta API key está desactivada',
        API_KEY_ERROR_CODE_ENUM.API_KEY_ORGANIZATION_INACTIVE,
      ),
    );
  }
}

/**
 * La membresía que emitió la llave —su actor— ya no está activa en la organización. La llave deja
 * de servir sin revocarse: lo que crea en nombre de alguien no puede sobrevivir a que esa persona
 * salga de la organización.
 */
export class ApiKeyActorInactiveException extends ForbiddenException {
  constructor() {
    super(
      buildApiKeyErrorBody(
        HttpStatus.FORBIDDEN,
        'Forbidden',
        'La cuenta asociada a esta API key ya no está activa en la organización',
        API_KEY_ERROR_CODE_ENUM.API_KEY_ACTOR_INACTIVE,
      ),
    );
  }
}

/** La llave no tiene concedido el permiso (recurso, acción y alcance) que exige el endpoint. */
export class ApiKeyPermissionDeniedException extends ForbiddenException {
  constructor(requiredPermission: string) {
    super(
      buildApiKeyErrorBody(
        HttpStatus.FORBIDDEN,
        'Forbidden',
        `La API key no tiene el permiso requerido: ${requiredPermission}`,
        API_KEY_ERROR_CODE_ENUM.API_KEY_PERMISSION_DENIED,
      ),
    );
  }
}

/** Índice que garantiza una sola llave `ACTIVE` por organización. */
const ONE_ACTIVE_PER_ORGANIZATION_INDEX =
  'uq_api_keys_one_active_per_organization';

/**
 * Reconoce el choque contra `uq_api_keys_one_active_per_organization`.
 *
 * Mira el SQLSTATE y el nombre del índice, no el texto, igual que
 * `isDuplicateMembershipError`: el texto depende del idioma de Postgres.
 *
 * @param error - Lo que haya lanzado el driver.
 * @returns `true` si es una segunda llave activa para la misma organización.
 *
 * @example
 * ```ts
 * if (isOneActiveApiKeyViolation(error)) throw new ApiKeyAlreadyActiveException();
 * ```
 */
export function isOneActiveApiKeyViolation(error: unknown): boolean {
  const driverError = (error as { driverError?: Record<string, unknown> })
    ?.driverError;

  return (
    driverError?.code === '23505' &&
    driverError?.constraint === ONE_ACTIVE_PER_ORGANIZATION_INDEX
  );
}

/**
 * Reconoce que `FOR UPDATE NOWAIT` no pudo tomar el bloqueo (SQLSTATE `55P03`): otra transacción
 * tiene tomada la fila.
 *
 * @param error - Lo que haya lanzado el driver.
 * @returns `true` si la fila estaba bloqueada.
 *
 * @example
 * ```ts
 * if (isLockNotAvailableError(error)) throw new ApiKeyRotationConflictException();
 * ```
 */
export function isLockNotAvailableError(error: unknown): boolean {
  return (
    (error as { driverError?: { code?: string } })?.driverError?.code ===
    '55P03'
  );
}
