import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AccountMemberService } from 'src/account/account-member.service';
import { MinioService } from 'src/shared/minio/minio.service';

import { GetDocumentsQueryDto } from '../dto/get-documents-query.dto';
import { DocumentEntity } from '../entities/document.entity';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { collaboratorDisplayName } from '../utils/collaborator-display.util';
import { DocumentService } from '../document.service';

/**
 * `GET /document`: la bandeja del usuario dentro de la cuenta activa.
 *
 * Lo que se ve depende de las dos cosas a la vez: el usuario —que puede ser creador o
 * firmante— y la cuenta desde la que mira. Un mismo documento no aparece indistintamente en la
 * bandeja personal de alguien y en la de su organización, porque cada documento pertenece a la
 * cuenta con la que se creó.
 */
@Injectable()
export class GetDocumentsUseCase {
  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    private readonly minioService: MinioService,
    private readonly accountMemberService: AccountMemberService,
    private readonly documentService: DocumentService,
  ) {}

  async execute(
    callerId: string,
    accountId: string,
    query: GetDocumentsQueryDto,
  ) {
    if (!accountId) {
      throw new BadRequestException(
        'Falta el header X-Account-Id de la cuenta activa',
      );
    }
    const activeAccount = await this.accountMemberService.assertIsActiveMember(
      callerId,
      accountId,
    );

    const {
      id,
      participantEmail: participantEmailRaw,
      email: emailRaw,
      status,
      dateFrom,
      dateTo,
      signedDateFrom,
      signedDateTo,
      fileName,
      participantName,
      myTurnOnly,
      page,
      limit,
      withUrl,
    } = query;

    /**
     * Bug corregido ("las solicitudes FIEL sin 2FA no aparecen en Por firmar"): este listado era
     * el único punto del flujo que comparaba correos con `=` exacto. `users.email` se guarda
     * siempre en minúsculas (ver UserService), pero `collaborators.email` conserva tal cual lo
     * que tecleó quien invitó — así que a un firmante invitado como "Juan.Perez@mail.com" el
     * listado no le mostraba nada, aunque el detalle (`resolveMyCollaborator`), la vinculación
     * (`linkPendingCollaboratorAccount`) y `sign()`/`reject()` sí lo reconocen (todos comparan
     * sin distinguir mayúsculas).
     *
     * El síntoma se veía solo en documentos FIEL sin 2FA porque en todos los demás casos algo
     * termina vinculando la cuenta al colaborador y el emparejamiento pasa a hacerse por
     * `users.email` (ya normalizado): la firma SIMPLE siempre exige 2FA, y pedir el código
     * (`requestVerificationCode` → `findMySignerCollaborator`) vincula la cuenta antes de firmar.
     * Sin 2FA no existe ese paso previo, así que la fila se queda sin `accountId` y el documento
     * permanece invisible en "Por firmar" hasta que el firmante entra por el enlace del correo.
     */
    const participantEmail = participantEmailRaw?.toLowerCase();
    const email = emailRaw?.toLowerCase();

    const qb = this.documentRepository
      .createQueryBuilder('document')
      .leftJoinAndSelect('document.requestedBy', 'requester')
      // El RFC no vive en `users` sino en `personal_information` (ver UserEntity): el listado lo
      // muestra como texto secundario bajo el nombre en la columna "Creado por", así que se trae
      // en el mismo query en vez de resolverlo documento por documento.
      .leftJoinAndSelect(
        'requester.personalInformation',
        'requesterPersonalInfo',
      )
      .leftJoinAndSelect('document.collaborators', 'collaborator')
      .leftJoinAndSelect('collaborator.account', 'collaboratorAccount')
      .leftJoinAndSelect('collaboratorAccount.user', 'collaboratorUser')
      .orderBy('document.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (!participantEmail) {
      qb.andWhere(
        activeAccount.organizationId
          ? 'document.organizationId = :organizationId'
          : 'document.accountId = :accountId',
        activeAccount.organizationId
          ? { organizationId: activeAccount.organizationId }
          : { accountId },
      );
    }

    if (id) {
      qb.andWhere('document.id = :id', { id });
    }

    if (participantEmail) {
      qb.andWhere(
        `document.id IN (
          SELECT c.document_id FROM collaborators c
          LEFT JOIN accounts a ON a.id = c.account_id
          LEFT JOIN users u ON u.id = a.user_id
          WHERE LOWER(u.email) = :participantEmail
             OR LOWER(c.email) = :participantEmail
        )`,
        { participantEmail },
      );
    }

    if (email) {
      qb.andWhere(
        `(LOWER(requester.email) = :email OR document.id IN (
          SELECT c.document_id FROM collaborators c
          LEFT JOIN accounts a ON a.id = c.account_id
          LEFT JOIN users u ON u.id = a.user_id
          WHERE LOWER(u.email) = :email OR LOWER(c.email) = :email
        ))`,
        { email },
      );
    }

    if (status) {
      qb.andWhere('document.status = :status', { status });
    }

    if (dateFrom) {
      qb.andWhere('document.createdAt >= :dateFrom', {
        dateFrom: new Date(dateFrom),
      });
    }

    if (dateTo) {
      qb.andWhere('document.createdAt <= :dateTo', {
        dateTo: new Date(dateTo),
      });
    }

    if (signedDateFrom) {
      qb.andWhere('document.signedAt >= :signedDateFrom', {
        signedDateFrom: new Date(signedDateFrom),
      });
    }

    if (signedDateTo) {
      qb.andWhere('document.signedAt <= :signedDateTo', {
        signedDateTo: new Date(signedDateTo),
      });
    }

    if (fileName) {
      qb.andWhere('document.fileName ILIKE :fileName', {
        fileName: `%${fileName}%`,
      });
    }

    if (participantName) {
      qb.andWhere(
        `document.id IN (
          SELECT c.document_id FROM collaborators c
          LEFT JOIN accounts a ON a.id = c.account_id
          LEFT JOIN users u ON u.id = a.user_id
          WHERE u.first_name ILIKE :participantName
             OR u.last_name ILIKE :participantName
             OR u.email ILIKE :participantName
             OR c.email ILIKE :participantName
        )`,
        { participantName: `%${participantName}%` },
      );
    }

    if (myTurnOnly && participantEmail) {
      // LEFT JOIN a propósito (antes INNER): un colaborador invitado solo por email todavía no
      // tiene account_id (ver CreateDocumentSignatureFlowUseCase, accountId siempre null al
      // crear), así que el INNER JOIN lo excluía de "me toca firmar" hasta que alguien completara
      // la vinculación perezosa de cuenta — que hoy en día solo ocurre al firmar/rechazar/pedir
      // el código, es decir, nunca antes de ver esta misma lista.
      qb.andWhere(
        `document.id IN (
          SELECT c.document_id FROM collaborators c
          LEFT JOIN accounts a ON a.id = c.account_id
          LEFT JOIN users u ON u.id = a.user_id
          WHERE (LOWER(u.email) = :participantEmail
                 OR LOWER(c.email) = :participantEmail)
            AND c.colaborator_type = 'signer'
            AND c.status = 'pending'
            AND c.signing_order = (
              SELECT MIN(c2.signing_order) FROM collaborators c2
              WHERE c2.document_id = c.document_id
                AND c2.colaborator_type = 'signer'
                AND c2.status = 'pending'
            )
        )`,
        { participantEmail },
      );
    }

    const [documents, total] = await qb.getManyAndCount();

    const data = await Promise.all(
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

    return {
      success: true,
      message: 'Documentos obtenidos correctamente',
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page < Math.ceil(total / limit),
        hasPrevPage: page > 1,
      },
    };
  }
}
