import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository, SelectQueryBuilder } from 'typeorm';

import { AccountMemberService } from 'src/account/account-member.service';
import { MinioService } from 'src/common/minio/minio.service';
import { UserService } from 'src/user/user.service';

import { GetDocumentsQueryDto } from '../dto/get-documents-query.dto';
import { DocumentEntity } from '../entities/document.entity';
import { DocumentUserPreferenceEntity } from '../preferences/document-user-preference.entity';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { SIGNEE_STATUS_ENUM } from '../enum/signee-status.enum';
import {
  DOCUMENT_SORT_FIELD_ENUM,
  SORT_DIRECTION_ENUM,
} from '../enum/document-sort-field.enum';
import { DOCUMENT_VIEW_ENUM } from '../enum/document-view.enum';
import { DOCUMENT_PARTICIPATION_ENUM } from '../enum/document-participation.enum';
import { collaboratorDisplayName } from '../utils/collaborator-display.util';
import { DocumentService } from '../document.service';

/** Lo que el caso de uso necesita: quién pregunta, desde qué cuenta, y qué quiere ver. */
export interface GetDocumentsParams {
  /** Usuario autenticado. De él sale también el correo con el que se busca su participación. */
  userId: string;
  /** Cuenta activa (`X-Account-Id`): acota lo visible al contexto en el que está trabajando. */
  accountId: string;
  /**
   * Recorte, búsqueda, orden y paginación.
   *
   * `view` escoge un subconjunto de lo visible y NUNCA lo amplía; el acceso lo decide la cuenta
   * activa, no el filtro.
   */
  filters: GetDocumentsQueryDto;
}

export interface DocumentsPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * Los roles que tienen algo que HACER con un documento.
 *
 * `WATCHER` queda fuera: un observador recibe copia y puede consultarlo, pero no se le pide
 * nada, así que un documento nunca "requiere su firma o revisión" y meterlo en esa vista sería
 * darle una tarea que no existe.
 */
const ACTING_COLLABORATOR_TYPES = [
  COLABORATOR_TYPE_ENUM.SIGNER,
  COLABORATOR_TYPE_ENUM.REVIEWER,
];

/**
 * De qué campo del enum sale cada columna del `ORDER BY`.
 *
 * El mapa es lo que convierte la lista cerrada del DTO en SQL. Es la única forma en que un valor
 * del cliente llega al ordenamiento, y llega como CLAVE de este objeto, nunca como texto: el
 * `ORDER BY` no admite parámetros preparados, así que lo que se interpola tiene que salir de acá.
 */
const SORT_COLUMNS: Record<DOCUMENT_SORT_FIELD_ENUM, string> = {
  [DOCUMENT_SORT_FIELD_ENUM.CREATED_AT]: 'document.createdAt',
  [DOCUMENT_SORT_FIELD_ENUM.SIGNED_AT]: 'document.signedAt',
  [DOCUMENT_SORT_FIELD_ENUM.FILE_NAME]: 'document.fileName',
  [DOCUMENT_SORT_FIELD_ENUM.STATUS]: 'document.status',
};

/**
 * Lista los documentos que la cuenta activa puede ver, con búsqueda, recorte, orden y paginación.
 *
 * @remarks
 * Flujo:
 *
 * 1. Exige el header de cuenta activa y comprueba que quien pregunta sea miembro de ella, antes
 *    de mirar un solo filtro.
 * 2. Valida los rangos de fecha.
 * 3. Resuelve el correo del usuario en el servidor, que es con el que se busca su participación.
 * 4. Aplica la VISIBILIDAD: el contexto dueño del documento —la organización activa, o la cuenta
 *    personal más aquello en lo que participa fuera de sus organizaciones— (ver
 *    `applyVisibility`).
 * 5. Aplica el `view` pedido y excluye lo que este usuario archivó.
 * 6. Suma los filtros opcionales: id, estados, búsqueda, participante y rangos de fecha.
 * 7. Pagina, ordena con desempate estable y arma la respuesta; opcionalmente firma URLs de MinIO.
 *
 * **`view` no decide el acceso.** El orden de los pasos 4 y 5 es la garantía: primero se acota lo
 * que el usuario puede ver y sólo después se escoge un subconjunto. Un `view` distinto no puede
 * ampliar lo visible; en el peor caso lo deja vacío.
 *
 * Sustituye a las tres consultas que se repartían la bandeja, cada una con su propia receta de
 * parámetros. Aquello dejaba la definición de cada sección en el cliente —el servidor no sabía
 * qué era "por firmar"—, hacía las tres incombinables entre sí y ninguna se podía ordenar.
 */
@Injectable()
export class GetDocumentsUseCase {
  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    private readonly minioService: MinioService,
    private readonly accountMemberService: AccountMemberService,
    private readonly userService: UserService,
    private readonly documentService: DocumentService,
  ) {}

  /**
   * Ejecuta el caso de uso.
   *
   * @param params Quién pregunta, desde qué cuenta y con qué filtros.
   * @returns La página de documentos con su paginación.
   * @throws {BadRequestException} Cuando falta el header de cuenta activa o un rango de fechas
   *   termina antes de empezar.
   * @throws {ForbiddenException} Cuando el usuario no es miembro activo de la cuenta.
   */
  async execute({ userId, accountId, filters }: GetDocumentsParams) {
    if (!accountId) {
      throw new BadRequestException(
        'Falta el header X-Account-Id de la cuenta activa',
      );
    }

    const activeAccount = await this.accountMemberService.assertIsActiveMember(
      userId,
      accountId,
    );

    const {
      view = DOCUMENT_VIEW_ENUM.REQUIRES_MY_SIGNATURE,
      search,
      statuses,
      participant,
      createdFrom,
      createdTo,
      signedFrom,
      signedTo,
      sortBy = DOCUMENT_SORT_FIELD_ENUM.CREATED_AT,
      sortDirection = SORT_DIRECTION_ENUM.DESC,
      page = 1,
      limit = 25,
      id,
      withUrl,
    } = filters;

    this.assertValidDateRange(createdFrom, createdTo, 'creación');
    this.assertValidDateRange(signedFrom, signedTo, 'firma');

    /**
     * El correo sale del servidor y no de la query: pedírselo al cliente sería confiarle de quién
     * es la bandeja. Hace falta porque un firmante invitado por correo no tiene cuenta vinculada
     * todavía, así que su fila en `collaborators` sólo tiene el email.
     *
     * En minúsculas: `users.email` se guarda normalizado, pero `collaborators.email` conserva lo
     * que tecleó quien invitó.
     */
    const caller = await this.userService.findOne(userId);
    const callerEmail = caller.email?.toLowerCase() ?? null;

    const qb = this.documentRepository
      .createQueryBuilder('document')
      .leftJoinAndSelect('document.requestedBy', 'requester')
      // El RFC vive en `personal_information`, y el listado lo muestra bajo el nombre del creador.
      .leftJoinAndSelect(
        'requester.personalInformation',
        'requesterPersonalInfo',
      )
      .leftJoinAndSelect('document.collaborators', 'collaborator')
      .leftJoinAndSelect('collaborator.account', 'collaboratorAccount')
      .leftJoinAndSelect('collaboratorAccount.user', 'collaboratorUser')
      .orderBy(SORT_COLUMNS[sortBy], sortDirection)
      // Desempate estable: sin él, un documento se repite entre páginas mientras otro no sale.
      .addOrderBy('document.id', sortDirection)
      .skip((page - 1) * limit)
      .take(limit);

    this.applyVisibility(qb, { userId, callerEmail, activeAccount, accountId });
    this.applyView(qb, view, { userId, callerEmail });
    this.excludeArchived(qb, userId);

    if (id) {
      qb.andWhere('document.id = :id', { id });
    }

    if (statuses?.length) {
      qb.andWhere('document.status IN (:...statuses)', { statuses });
    }

    if (search) {
      // Una caja para nombre y participantes: es lo que la persona tiene en la cabeza al buscar.
      qb.andWhere(
        new Brackets((where) => {
          where
            .where('document.fileName ILIKE :search')
            .orWhere(this.participantMatchSubquery('search'));
        }),
        { search: `%${search}%` },
      );
    }

    if (participant) {
      qb.andWhere(this.participantMatchSubquery('participant'), {
        participant: `%${participant}%`,
      });
    }

    if (createdFrom) {
      qb.andWhere('document.createdAt >= :createdFrom', {
        createdFrom: new Date(createdFrom),
      });
    }

    if (createdTo) {
      qb.andWhere('document.createdAt <= :createdTo', {
        createdTo: new Date(createdTo),
      });
    }

    if (signedFrom) {
      qb.andWhere('document.signedAt >= :signedFrom', {
        signedFrom: new Date(signedFrom),
      });
    }

    if (signedTo) {
      qb.andWhere('document.signedAt <= :signedTo', {
        signedTo: new Date(signedTo),
      });
    }

    const [documents, total] = await qb.getManyAndCount();

    const items = await Promise.all(
      documents.map(async (doc) => {
        const byType = (type: COLABORATOR_TYPE_ENUM) =>
          (doc.collaborators ?? [])
            .filter((c) => c.colaboratorType === type)
            .sort((a, b) => (a.signingOrder ?? 0) - (b.signingOrder ?? 0))
            .map(collaboratorDisplayName);

        const base = {
          id: doc.id,
          fileName: doc.fileName,
          fileType: doc.fileType,
          signers: byType(COLABORATOR_TYPE_ENUM.SIGNER),
          watchers: byType(COLABORATOR_TYPE_ENUM.WATCHER),
          reviewers: byType(COLABORATOR_TYPE_ENUM.REVIEWER),
          creator: `${doc.requestedBy.firstName} ${doc.requestedBy.lastName}`,
          creatorRfc: doc.requestedBy.personalInformation?.rfc ?? null,
          totalPages: doc.totalPages,
          status: doc.status,
          signatureType: this.documentService.resolveDocumentSignatureType(
            doc.collaborators,
          ),
          /**
           * Qué papel juega el usuario en ESTE documento, resuelto en el servidor.
           *
           * La columna "Participación" del listado unificado lo necesita en cada fila, y antes no
           * hacía falta porque la sección ya lo decía: en "Por firmar" todo requería mi firma y
           * en "Enviados para firma" todo lo había mandado yo. Sin secciones, cada fila tiene que
           * explicarse sola.
           */
          participation: this.resolveParticipation(doc, userId, callerEmail),
          createdAt: doc.createdAt,
          /**
           * Fecha en que el documento quedó firmado por completo (`document.signedAt`, que solo
           * se fija cuando la última firma cierra el flujo), no la de una firma individual. Null
           * mientras eso no ocurra: el listado lo muestra como "No disponible".
           */
          signedAt: doc.signedAt ?? null,
        };

        if (!withUrl) {
          return base;
        }

        const bucket = this.documentService.resolveDocumentBucket(doc);
        const { secureUrl, expiresIn } = await this.minioService.getFile(
          doc.objectKey,
          bucket,
        );

        return { ...base, secureUrl, expiresIn };
      }),
    );

    const pagination: DocumentsPagination = {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };

    return { items, pagination };
  }

  /**
   * Lo que este usuario puede ver desde la cuenta activa, y que ningún filtro puede ensanchar.
   *
   * **Cada documento tiene UN solo contexto dueño** —la organización que lo creó, o la cuenta
   * personal— y se lista en ese contexto y en ningún otro. La participación no es un contexto:
   * `collaborators.account_id` ancla siempre a la cuenta PERSONAL de quien firma (ver
   * `CollaboratorEntity`), nunca a una membresía de organización, así que "me toca firmarlo" es
   * una relación de la persona y se resuelve en su bandeja personal.
   *
   * De ahí las dos ramas:
   *
   * - **Organización**: sólo `document.organizationId`. Nada más entra, ni siquiera un documento
   *   que este miembro tenga que firmar: si es de otra organización o de una cuenta personal, no
   *   es de ésta.
   * - **Personal**: los documentos de la cuenta, más aquellos en los que participa cuyo contexto
   *   dueño NO puede alcanzar (ver `documentOutsideMyOrganizationsSubquery`). Esa segunda vía no
   *   sobra: casi ningún documento que me toca firmar pertenece a mi cuenta, sino a la de quien
   *   lo mandó, y sin ella un firmante externo no vería nunca lo que se le pidió firmar.
   *
   * Bug corregido: **"El listado de documentos no se actualiza al cambiar de cuenta activa"**. La
   * participación se aplicaba en las DOS ramas y no dependía de la cuenta, así que entraba en
   * cualquier contexto: dentro de una organización seguían saliendo los documentos personales del
   * usuario y los de otras organizaciones donde firma, y al volver a la cuenta personal seguían
   * los de la organización. La lista sí se recargaba —la `queryKey` del cliente lleva la cuenta—;
   * lo que no cambiaba era la respuesta del servidor.
   *
   * Antes de eso se había quitado por lo mismo un tercer camino, `document.createdBy = :userId`,
   * que tampoco dependía de la cuenta.
   *
   * **Nada queda inaccesible.** El detalle (`GET /document/:id`) no mira la cuenta activa: pide
   * ser creador o participante (ver `GetDocumentUseCase`), así que el enlace del correo sigue
   * abriendo y firmando igual aunque el documento se liste en otro contexto.
   *
   * El `view` `created_by_me` no se ve afectado: filtra por `createdBy` DENTRO de lo ya visible
   * (ver `applyView`), así que sigue listando lo que el usuario mandó a firmar en esta cuenta.
   */
  private applyVisibility(
    qb: SelectQueryBuilder<DocumentEntity>,
    context: {
      userId: string;
      callerEmail: string | null;
      activeAccount: { organizationId?: string | null };
      accountId: string;
    },
  ): void {
    const { userId, callerEmail, activeAccount, accountId } = context;

    if (activeAccount.organizationId) {
      qb.andWhere('document.organizationId = :organizationId', {
        organizationId: activeAccount.organizationId,
      });
      return;
    }

    /**
     * Las dos vías van en un `OR` dentro de un mismo paréntesis: sueltas, el `AND` de cualquier
     * filtro posterior se mezclaría con ellas y el resultado dejaría de significar lo mismo.
     */
    qb.andWhere(
      new Brackets((where) => {
        where.where('document.accountId = :accountId', { accountId });

        where.orWhere(
          new Brackets((participation) => {
            participation
              .where(this.callerIsParticipantSubquery(), {
                userId,
                callerEmail,
              })
              .andWhere(this.documentOutsideMyOrganizationsSubquery(), {
                userId,
              });
          }),
        );
      }),
    );
  }

  /**
   * "Este documento no es de ninguna organización a la que yo pertenezca."
   *
   * Es lo que evita que la bandeja personal repita lo que ya se lista dentro de la organización:
   * un documento de Acme que este miembro tiene que firmar aparece en el contexto de Acme, que es
   * su dueño, y no también en su cuenta personal. Un documento de una organización ajena —o de
   * la cuenta personal de otra persona— sí entra: no hay otro contexto desde el que verlo.
   *
   * El `IS NOT NULL` del subquery no es cosmético: `NOT IN` contra un conjunto que contenga un
   * `NULL` no devuelve `true` para nada (el resultado es `UNKNOWN`), y una sola membresía sin
   * organización vaciaría la vía de participación entera. Con el filtro, una persona sin ninguna
   * organización compara contra un conjunto vacío, que es `true` para todos.
   *
   * @returns El fragmento SQL, que espera el parámetro `:userId` ligado por quien lo use.
   * @throws Nada: sólo arma texto.
   *
   * @example
   * ```ts
   * participation.andWhere(this.documentOutsideMyOrganizationsSubquery(), { userId });
   * ```
   */
  private documentOutsideMyOrganizationsSubquery(): string {
    return `(document.organizationId IS NULL OR document.organizationId NOT IN (
      SELECT a.organization_id FROM accounts a
      WHERE a.user_id = :userId
        AND a.is_active = true
        AND a.organization_id IS NOT NULL
    ))`;
  }

  /**
   * Recorta lo visible al subconjunto que pide `view`. Nunca amplía: sólo agrega condiciones.
   *
   * **Cada condición liga sus propios parámetros.** `requires_my_signature` usa `:userId` y
   * `:callerEmail`, y durante un tiempo funcionó sin ligarlos porque se los encontraba puestos
   * por la vía de participación de `applyVisibility`. Al dejar de aplicarse esa vía dentro de una
   * organización, los marcadores llegaban a Postgres sin valor y la consulta reventaba con
   * `syntax error at or near ":"` — un acoplamiento invisible entre dos métodos que ningún mock
   * del query builder puede delatar, porque el SQL sólo se arma de verdad contra la base.
   */
  private applyView(
    qb: SelectQueryBuilder<DocumentEntity>,
    view: DOCUMENT_VIEW_ENUM,
    caller: { userId: string; callerEmail: string | null },
  ): void {
    const { userId, callerEmail } = caller;

    switch (view) {
      case DOCUMENT_VIEW_ENUM.REQUIRES_MY_SIGNATURE:
        /**
         * Dos condiciones, y las dos hacen falta: el documento sigue abierto Y mi respuesta sigue
         * pendiente. Sin la primera, un documento cancelado con mi firma sin dar seguiría
         * pidiéndome algo que ya no se puede hacer; sin la segunda, los que ya firmé volverían a
         * aparecer como tarea.
         */
        qb.andWhere('document.status = :pendingStatus', {
          pendingStatus: DOCUMENT_STATUS_ENUM.PENDING,
        }).andWhere(
          `document.id IN (
            SELECT c.document_id FROM collaborators c
            LEFT JOIN accounts a ON a.id = c.account_id
            LEFT JOIN users u ON u.id = a.user_id
            WHERE (u.id = :userId OR LOWER(c.email) = :callerEmail)
              AND c.colaborator_type IN (:...actingTypes)
              AND c.status = :pendingSigneeStatus
          )`,
          {
            userId,
            callerEmail,
            actingTypes: ACTING_COLLABORATOR_TYPES,
            pendingSigneeStatus: SIGNEE_STATUS_ENUM.PENDING,
          },
        );
        return;

      case DOCUMENT_VIEW_ENUM.CREATED_BY_ME:
        qb.andWhere('document.createdBy = :userId', { userId });
        return;

      case DOCUMENT_VIEW_ENUM.COMPLETED:
        qb.andWhere('document.status = :signedStatus', {
          signedStatus: DOCUMENT_STATUS_ENUM.SIGNED,
        });
        return;

      case DOCUMENT_VIEW_ENUM.ALL:
      default:
        return;
    }
  }

  /**
   * Fuera lo que ESTE usuario archivó.
   *
   * `leftJoin` y no `innerJoin`: la mayoría de los documentos no tienen preferencia de nadie, y
   * un `INNER JOIN` vaciaría el listado entero. Sin fila, `archivedAt` es `NULL` y el documento
   * pasa el filtro — que es exactamente lo que significa "no he dicho nada sobre este documento".
   *
   * El `user_id` va en la condición del JOIN y no en el `WHERE`: puesto abajo, un documento
   * archivado por OTRO participante traería su fila y desaparecería también de mi listado, con lo
   * que archivar dejaría de ser una decisión personal.
   */
  private excludeArchived(
    qb: SelectQueryBuilder<DocumentEntity>,
    userId: string,
  ): void {
    qb.leftJoin(
      DocumentUserPreferenceEntity,
      'myPreference',
      'myPreference.documentId = document.id AND myPreference.userId = :preferenceUserId',
      { preferenceUserId: userId },
    ).andWhere('myPreference.archivedAt IS NULL');
  }

  /**
   * "Soy participante de este documento", por cuenta vinculada o por el correo de la invitación.
   *
   * Los dos caminos son necesarios: un firmante invitado por correo no tiene `account_id` hasta
   * que algo lo vincula —y eso ocurre al firmar, rechazar o pedir el código, es decir, nunca
   * antes de ver esta lista— así que emparejar sólo por cuenta lo dejaría sin ver el documento
   * que tiene que firmar.
   */
  private callerIsParticipantSubquery(): string {
    return `document.id IN (
      SELECT c.document_id FROM collaborators c
      LEFT JOIN accounts a ON a.id = c.account_id
      LEFT JOIN users u ON u.id = a.user_id
      WHERE u.id = :userId OR LOWER(c.email) = :callerEmail
    )`;
  }

  /** Documentos con algún participante cuyo nombre o correo case con `:<paramName>`. */
  private participantMatchSubquery(paramName: string): string {
    return `document.id IN (
      SELECT c.document_id FROM collaborators c
      LEFT JOIN accounts a ON a.id = c.account_id
      LEFT JOIN users u ON u.id = a.user_id
      WHERE u.first_name ILIKE :${paramName}
         OR u.last_name ILIKE :${paramName}
         OR u.email ILIKE :${paramName}
         OR c.email ILIKE :${paramName}
    )`;
  }

  /**
   * Qué es el usuario dentro de este documento, con un solo valor por fila.
   *
   * El orden importa cuando alguien es varias cosas a la vez —crear un documento y firmarlo uno
   * mismo es corriente—: gana lo que le pide una acción, porque es lo que explica por qué esa
   * fila está en su lista. Se resuelve sobre los colaboradores YA cargados por el join, sin una
   * consulta extra por documento.
   */
  private resolveParticipation(
    document: DocumentEntity,
    userId: string,
    callerEmail: string | null,
  ): DOCUMENT_PARTICIPATION_ENUM {
    const mine = (document.collaborators ?? []).filter(
      (c) =>
        c.account?.userId === userId ||
        (Boolean(c.email) && c.email?.toLowerCase() === callerEmail),
    );

    const owesAnswer = mine.some(
      (c) =>
        ACTING_COLLABORATOR_TYPES.includes(c.colaboratorType) &&
        c.status === SIGNEE_STATUS_ENUM.PENDING &&
        document.status === DOCUMENT_STATUS_ENUM.PENDING,
    );
    if (owesAnswer) return DOCUMENT_PARTICIPATION_ENUM.REQUIRES_MY_SIGNATURE;

    if (document.createdBy === userId) {
      return DOCUMENT_PARTICIPATION_ENUM.CREATED_BY_ME;
    }

    return DOCUMENT_PARTICIPATION_ENUM.PARTICIPANT;
  }

  /**
   * Un rango al revés (`desde` posterior a `hasta`) no devuelve nada, y en silencio: la lista
   * sale vacía y quien la mira no tiene cómo saber si es que no hay documentos o es que tecleó
   * las fechas cambiadas. Vale más un 400 que lo diga.
   */
  private assertValidDateRange(
    from: string | undefined,
    to: string | undefined,
    label: string,
  ): void {
    if (!from || !to) return;

    if (new Date(from).getTime() > new Date(to).getTime()) {
      throw new BadRequestException(
        `El rango de fechas de ${label} está invertido: la fecha inicial (${from}) es posterior a la final (${to})`,
      );
    }
  }
}
