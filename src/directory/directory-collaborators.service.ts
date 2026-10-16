import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Not } from 'typeorm';

import { AccountEntity } from 'src/account/entities/account.entity';
import { ACCOUNT_TYPE_ENUM } from 'src/account/enums/account-type.enum';
import { UserEntity } from 'src/user/entities/user.entity';

import { normalizeContactEmail } from './directory-contacts.service';
import { DirectoryEntity } from './entities/directory.entity';
import { DirectoryContactEntity } from './entities/directory-contact.entity';

/** Identidad con la que se crea un colaborador de documento. */
export interface CollaboratorIdentity {
  firstName: string;
  lastName: string;
  email: string;
}

/** La cuenta activa, con lo justo para saber cuál es su directorio. */
export type DirectoryOwnerAccount = Pick<
  AccountEntity,
  'id' | 'accountType' | 'organizationId'
>;

export const DIRECTORY_COLLABORATOR_NOT_FOUND_MESSAGE =
  'El colaborador del Directorio no existe o no pertenece al directorio de la cuenta activa';

/**
 * El Directorio visto desde la creación de documentos: resuelve a los colaboradores elegidos del
 * Directorio y da de alta a los capturados a mano que piden quedarse en él.
 *
 * El directorio es siempre el de la cuenta activa, que quien llama ya validó: el de su
 * `accounts.id` si es PERSONAL, o el de su `organizationId` si es de una organización.
 */
@Injectable()
export class DirectoryCollaboratorsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Resuelve nombre, apellido y correo de los usuarios vinculados a contactos del directorio
   * activo.
   *
   * Un `linkedUserId` sólo es válido si el usuario existe, no está borrado y su cuenta PERSONAL
   * está vinculada a un contacto VIGENTE (no archivado) de ese directorio. Así no se puede usar
   * el flujo del Directorio para notificar a cualquier usuario de la plataforma por su id. Los
   * datos salen de `users`, no del contacto: son los de la cuenta a la que se notifica.
   *
   * @param account - Cuenta activa ya validada.
   * @param linkedUserIds - `users.id` elegidos del Directorio; puede traer repetidos.
   * @returns Un mapa `users.id → identidad`, con una entrada por usuario distinto.
   *
   * @throws {BadRequestException} (400) Si alguno no existe, está borrado o no corresponde a un
   *   contacto vigente del directorio activo. El mensaje es el mismo en los tres casos para no
   *   revelar qué usuarios existen.
   *
   * @example
   * ```ts
   * const identities = await service.resolveLinkedCollaborators(activeAccount, ['user-1']);
   * identities.get('user-1'); // { firstName: 'Ana', lastName: 'García', email: 'ana@example.com' }
   * ```
   */
  async resolveLinkedCollaborators(
    account: DirectoryOwnerAccount,
    linkedUserIds: readonly string[],
  ): Promise<Map<string, CollaboratorIdentity>> {
    const userIds = [...new Set(linkedUserIds)];
    if (userIds.length === 0) return new Map();

    const directory = await this.dataSource
      .getRepository(DirectoryEntity)
      .findOne({ where: ownerWhere(account) });
    if (!directory) {
      throw new BadRequestException(DIRECTORY_COLLABORATOR_NOT_FOUND_MESSAGE);
    }

    const rows = await this.dataSource
      .getRepository(DirectoryContactEntity)
      .createQueryBuilder('contact')
      .innerJoin(
        AccountEntity,
        'account',
        'account.id = contact.linkedPersonalAccountId AND account.accountType = :personal',
        { personal: ACCOUNT_TYPE_ENUM.PERSONAL },
      )
      .innerJoin(UserEntity, 'user', 'user.id = account.userId')
      .where('contact.directoryId = :directoryId', {
        directoryId: directory.id,
      })
      .andWhere('contact.archivedAt IS NULL')
      .andWhere('user.id IN (:...userIds)', { userIds })
      .andWhere('user.isDeleted = false')
      .select([
        'user.id AS "userId"',
        'user.firstName AS "firstName"',
        'user.lastName AS "lastName"',
        'user.email AS "email"',
      ])
      .getRawMany<{ userId: string } & CollaboratorIdentity>();

    const identities = new Map(
      rows.map(({ userId, firstName, lastName, email }) => [
        userId,
        { firstName, lastName, email: normalizeContactEmail(email) },
      ]),
    );

    if (userIds.some((userId) => !identities.has(userId))) {
      throw new BadRequestException(DIRECTORY_COLLABORATOR_NOT_FOUND_MESSAGE);
    }

    return identities;
  }

  /**
   * Crea o reutiliza en el directorio activo un contacto por cada colaborador capturado a mano
   * que pidió `addToDirectory`.
   *
   * Corre dentro de la transacción del documento (`manager`): si el documento no se crea, no queda
   * ningún contacto. Por eso no puede dejar que choque una restricción única —en Postgres eso
   * aborta la transacción entera—, y usa `INSERT … ON CONFLICT DO NOTHING` tanto para el
   * directorio como para el contacto. Un correo que ya tiene contacto vigente se REUTILIZA sin
   * tocarlo: el Directorio es la fuente de verdad, y lo tecleado en un documento no la pisa. Uno
   * archivado se reactiva con los datos nuevos. El contacto nuevo queda vinculado a la cuenta
   * PERSONAL del usuario con ese correo, si existe.
   *
   * @param manager - `EntityManager` de la transacción del documento.
   * @param account - Cuenta activa ya validada; queda como autora del alta.
   * @param collaborators - Identidades a registrar; los correos repetidos cuentan una vez.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si falla la base por una razón distinta a un duplicado.
   *
   * @example
   * ```ts
   * await service.addManualCollaboratorsToDirectory(manager, activeAccount, [
   *   { firstName: 'Ana', lastName: 'García', email: 'Ana@Example.com' },
   * ]);
   * ```
   */
  async addManualCollaboratorsToDirectory(
    manager: EntityManager,
    account: DirectoryOwnerAccount,
    collaborators: readonly CollaboratorIdentity[],
  ): Promise<void> {
    const byEmail = new Map<string, CollaboratorIdentity>();
    for (const collaborator of collaborators) {
      const email = normalizeContactEmail(collaborator.email);
      if (!byEmail.has(email)) byEmail.set(email, { ...collaborator, email });
    }
    if (byEmail.size === 0) return;

    const directory = await this.findOrCreateDirectory(manager, account);
    const contactRepository = manager.getRepository(DirectoryContactEntity);

    for (const { firstName, lastName, email } of byEmail.values()) {
      await contactRepository
        .createQueryBuilder()
        .insert()
        .into(DirectoryContactEntity)
        .values({
          directoryId: directory.id,
          emailNormalized: email,
          firstName,
          lastName,
          linkedPersonalAccountId: await this.findLinkedPersonalAccountId(
            manager,
            email,
          ),
          createdByAccountId: account.id,
          updatedByAccountId: account.id,
        })
        .orIgnore()
        .execute();

      await contactRepository.update(
        {
          directoryId: directory.id,
          emailNormalized: email,
          archivedAt: Not(IsNull()),
        },
        {
          archivedAt: null,
          firstName,
          lastName,
          updatedByAccountId: account.id,
        },
      );
    }
  }

  /**
   * Devuelve el directorio de la cuenta, creándolo si falta, sin carreras ni errores de unicidad.
   *
   * @param manager - `EntityManager` de la transacción.
   * @param account - Cuenta activa.
   * @returns El directorio.
   *
   * @throws {EntityNotFoundError} Sólo si el dueño se borró entre el insert y la lectura.
   *
   * @example
   * ```ts
   * const directory = await this.findOrCreateDirectory(manager, activeAccount);
   * ```
   */
  private async findOrCreateDirectory(
    manager: EntityManager,
    account: DirectoryOwnerAccount,
  ): Promise<DirectoryEntity> {
    const owner = ownerWhere(account);
    await manager
      .createQueryBuilder()
      .insert()
      .into(DirectoryEntity)
      .values(
        'organizationId' in owner
          ? { organizationId: owner.organizationId, personalAccountId: null }
          : {
              personalAccountId: owner.personalAccountId,
              organizationId: null,
            },
      )
      .orIgnore()
      .execute();

    return manager.getRepository(DirectoryEntity).findOneOrFail({
      where: owner,
    });
  }

  /**
   * Cuenta PERSONAL del usuario vigente con ese correo, para vincular un contacto nuevo.
   *
   * @param manager - `EntityManager` de la transacción.
   * @param email - Correo ya normalizado.
   * @returns El `accounts.id`, o `null` si el correo no es de ningún usuario vigente.
   *
   * @throws Nada más allá de los errores de la base.
   *
   * @example
   * ```ts
   * await this.findLinkedPersonalAccountId(manager, 'ana@example.com'); // 'acc-1' | null
   * ```
   */
  private async findLinkedPersonalAccountId(
    manager: EntityManager,
    email: string,
  ): Promise<string | null> {
    const row = await manager
      .getRepository(AccountEntity)
      .createQueryBuilder('account')
      .innerJoin(UserEntity, 'user', 'user.id = account.userId')
      .where('LOWER(user.email) = :email', { email })
      .andWhere('user.isDeleted = false')
      .andWhere('account.accountType = :personal', {
        personal: ACCOUNT_TYPE_ENUM.PERSONAL,
      })
      .select('account.id', 'id')
      .getRawOne<{ id: string }>();

    return row?.id ?? null;
  }
}

/**
 * Filtro de `directories` para la cuenta activa.
 *
 * @param account - Cuenta activa.
 * @returns `{ organizationId }` para una membresía de organización, `{ personalAccountId }` para
 *   una cuenta personal.
 *
 * @throws {BadRequestException} (400) Si una membresía de organización no tiene organización
 *   (dato inconsistente: no hay directorio al que apuntar).
 *
 * @example
 * ```ts
 * ownerWhere({ id: 'acc-1', accountType: ACCOUNT_TYPE_ENUM.PERSONAL, organizationId: null });
 * // { personalAccountId: 'acc-1' }
 * ```
 */
function ownerWhere(
  account: DirectoryOwnerAccount,
): { organizationId: string } | { personalAccountId: string } {
  if (account.accountType === ACCOUNT_TYPE_ENUM.ORGANIZATION) {
    if (!account.organizationId) {
      throw new BadRequestException(DIRECTORY_COLLABORATOR_NOT_FOUND_MESSAGE);
    }
    return { organizationId: account.organizationId };
  }
  return { personalAccountId: account.id };
}
