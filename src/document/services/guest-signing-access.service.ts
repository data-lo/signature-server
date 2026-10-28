import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, MoreThan, Repository } from 'typeorm';

import { GuestSigningAccessEntity } from '../entities/guest-signing-access.entity';
import { GUEST_SIGNING_ACCESS_PURPOSE_ENUM } from '../enum/guest-signing-access-purpose.enum';

/** Datos con los que se emite un acceso, una vez validado el código del correo. */
export interface IssueGuestSigningAccessInput {
  documentId: string;
  collaboratorId: string;
  /** Correo GUARDADO del colaborador (al que se envió el código), no el de la petición. */
  email: string;
  purpose: GUEST_SIGNING_ACCESS_PURPOSE_ENUM;
  /** IP desde la que se validó el código. */
  ipAddress: string | null;
  /** Vigencia del acceso, en segundos. */
  ttlSeconds: number;
}

/**
 * Hash con el que un acceso recuerda a qué correo se emitió, sin guardar el correo.
 *
 * Se normaliza igual que se comparan los correos en el resto del flujo (sin espacios y en
 * minúsculas), así que dos escrituras del mismo correo dan el mismo hash.
 *
 * @param email - Correo de la invitación.
 * @returns SHA-256 en hexadecimal (64 caracteres).
 *
 * @example
 * ```ts
 * hashInvitationEmail(' Ana@Correo.mx '); // igual a hashInvitationEmail('ana@correo.mx')
 * ```
 */
export function hashInvitationEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

/**
 * Revoca los accesos abiertos (sin consumir ni revocar) de un colaborador para un propósito.
 *
 * Función suelta y no sólo método del servicio para que `DocumentService` —que vincula cuentas
 * dentro de su propia transacción— la use con su `EntityManager` sin inyectar el servicio: así
 * hay un solo lugar que decide qué es un acceso "abierto".
 *
 * @param manager - Conexión o transacción en la que se escribe.
 * @param collaboratorId - Colaborador.
 * @param purpose - Propósito de los accesos que se revocan.
 * @returns Cuántos accesos revocó.
 *
 * @example
 * ```ts
 * await revokeOpenGuestSigningAccesses(manager, 'c-1', GUEST_SIGNING_ACCESS_PURPOSE_ENUM.GUEST_ADVANCED_SIGNATURE_ACCESS);
 * ```
 */
export async function revokeOpenGuestSigningAccesses(
  manager: EntityManager,
  collaboratorId: string,
  purpose: GUEST_SIGNING_ACCESS_PURPOSE_ENUM,
): Promise<number> {
  const result = await manager
    .getRepository(GuestSigningAccessEntity)
    .update(
      { collaboratorId, purpose, consumedAt: IsNull(), revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
  return result.affected ?? 0;
}

/**
 * Ciclo de vida de los accesos temporales de invitado (`guest_signing_accesses`): emitirlos,
 * comprobar que sigan activos, consumirlos al firmar y revocarlos.
 *
 * Vive en `DocumentModule` y no en el módulo de la firma de invitado porque lo REVOCAN flujos de
 * documentos que no saben nada de invitados: vincular una cuenta al colaborador, firmar por el
 * dashboard, rechazar o cancelar el documento.
 *
 * Todas las escrituras aceptan un `EntityManager` para correr dentro de la transacción del
 * llamador. Las revocaciones y el consumo son `UPDATE` condicionados: dos peticiones simultáneas
 * nunca consumen el mismo acceso.
 */
@Injectable()
export class GuestSigningAccessService {
  constructor(
    @InjectRepository(GuestSigningAccessEntity)
    private readonly accessRepository: Repository<GuestSigningAccessEntity>,
  ) {}

  /**
   * Emite un acceso nuevo, revocando antes todos los abiertos del mismo documento, colaborador y
   * propósito.
   *
   * Se revocan también los ya vencidos: siguen ocupando el lugar del índice único parcial
   * `UQ_guest_signing_accesses_open`, que no puede mirar la hora.
   *
   * @param manager - Transacción del llamador (la misma que consume el código del correo).
   * @param input - Documento, colaborador, correo, propósito, IP y vigencia.
   * @returns El acceso creado; su `id` es el `jti` del token.
   *
   * @throws {QueryFailedError} (23505) Si otra transacción emitió un acceso para el mismo
   *   colaborador al mismo tiempo.
   *
   * @example
   * ```ts
   * const access = await accesses.issue(manager, { documentId: 'd-1', collaboratorId: 'c-1',
   *   email: 'ana@correo.mx', purpose, ipAddress: '10.0.0.1', ttlSeconds: 1800 });
   * ```
   */
  async issue(
    manager: EntityManager,
    input: IssueGuestSigningAccessInput,
  ): Promise<GuestSigningAccessEntity> {
    const repository = manager.getRepository(GuestSigningAccessEntity);
    const issuedAt = new Date();

    await repository.update(
      {
        documentId: input.documentId,
        collaboratorId: input.collaboratorId,
        purpose: input.purpose,
        consumedAt: IsNull(),
        revokedAt: IsNull(),
      },
      { revokedAt: issuedAt },
    );

    return repository.save(
      repository.create({
        documentId: input.documentId,
        collaboratorId: input.collaboratorId,
        emailHash: hashInvitationEmail(input.email),
        purpose: input.purpose,
        issuedAt,
        expiresAt: new Date(issuedAt.getTime() + input.ttlSeconds * 1000),
        consumedAt: null,
        revokedAt: null,
        issuedIpAddress: input.ipAddress,
      }),
    );
  }

  /**
   * Acceso vigente con ese id, aunque ya se haya consumido: sin vencer y sin revocar. Lo usa la
   * sesión pública de firma, que tiene que seguir respondiendo después de firmar —para el reintento
   * idempotente de la firma y para mostrar el estado final—. Firmar otra vez con un acceso consumido
   * no es posible: el claim exige consumirlo (`consume`).
   *
   * @param accessId - `jti` del token.
   * @returns El acceso, o `null` si no existe, venció o se revocó.
   *
   * @throws Nada propio; errores de la base.
   *
   * @example
   * ```ts
   * const access = await accesses.findUsable('a-1');
   * ```
   */
  async findUsable(accessId: string): Promise<GuestSigningAccessEntity | null> {
    return this.accessRepository.findOne({
      where: {
        id: accessId,
        revokedAt: IsNull(),
        expiresAt: MoreThan(new Date()),
      },
    });
  }

  /**
   * Acceso activo con ese id: sin vencer, sin consumir y sin revocar.
   *
   * @param accessId - `jti` del token.
   * @returns El acceso, o `null` si no existe o ya no está activo.
   *
   * @example
   * ```ts
   * const access = await accesses.findActive('a-1');
   * ```
   */
  async findActive(accessId: string): Promise<GuestSigningAccessEntity | null> {
    return this.accessRepository.findOne({
      where: {
        id: accessId,
        consumedAt: IsNull(),
        revokedAt: IsNull(),
        expiresAt: MoreThan(new Date()),
      },
    });
  }

  /**
   * Marca el acceso como consumido, sólo si sigue activo.
   *
   * Es el punto sin retorno del lado del acceso: corre en la misma transacción que reclama la
   * firma del colaborador, así que o quedan las dos cosas o ninguna.
   *
   * @param manager - Transacción del llamador.
   * @param accessId - Acceso que se usa para firmar.
   * @returns `true` si lo consumió esta llamada; `false` si ya no estaba activo.
   *
   * @example
   * ```ts
   * if (!(await accesses.consume(manager, 'a-1'))) throw new InvalidAccessError();
   * ```
   */
  async consume(manager: EntityManager, accessId: string): Promise<boolean> {
    const now = new Date();
    const result = await manager.getRepository(GuestSigningAccessEntity).update(
      {
        id: accessId,
        consumedAt: IsNull(),
        revokedAt: IsNull(),
        expiresAt: MoreThan(now),
      },
      { consumedAt: now },
    );
    return result.affected === 1;
  }

  /**
   * Revoca los accesos abiertos de un colaborador para un propósito.
   *
   * Lo llaman la vinculación de una cuenta (el colaborador deja de ser invitado) y el registro de
   * su firma (cualquier otro acceso suyo sobra).
   *
   * @param collaboratorId - Colaborador.
   * @param purpose - Propósito de los accesos que se revocan.
   * @param manager - Transacción del llamador; sin ella, usa el repositorio inyectado.
   * @returns Cuántos accesos revocó.
   *
   * @example
   * ```ts
   * await accesses.revokeOpenForCollaborator('c-1', GUEST_SIGNING_ACCESS_PURPOSE_ENUM.GUEST_ADVANCED_SIGNATURE_ACCESS);
   * ```
   */
  async revokeOpenForCollaborator(
    collaboratorId: string,
    purpose: GUEST_SIGNING_ACCESS_PURPOSE_ENUM,
    manager?: EntityManager,
  ): Promise<number> {
    return revokeOpenGuestSigningAccesses(
      manager ?? this.accessRepository.manager,
      collaboratorId,
      purpose,
    );
  }

  /**
   * Revoca todos los accesos abiertos de un documento, de cualquier colaborador y propósito.
   *
   * Lo llaman los flujos que sacan al documento de la firma: completarse, rechazarse o
   * cancelarse. Los accesos se revalidan igualmente contra el estado del documento al usarse; esto
   * deja además constancia de cuándo dejaron de valer.
   *
   * @param documentId - Documento.
   * @param manager - Transacción del llamador; sin ella, usa el repositorio inyectado.
   * @returns Cuántos accesos revocó.
   *
   * @example
   * ```ts
   * await accesses.revokeOpenForDocument('d-1');
   * ```
   */
  async revokeOpenForDocument(
    documentId: string,
    manager?: EntityManager,
  ): Promise<number> {
    const repository = manager
      ? manager.getRepository(GuestSigningAccessEntity)
      : this.accessRepository;

    const result = await repository.update(
      { documentId, consumedAt: IsNull(), revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
    return result.affected ?? 0;
  }
}
