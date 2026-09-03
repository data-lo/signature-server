import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MinioService } from 'src/shared/minio/minio.service';
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';
import { DocumentEntity } from '../../entities/document.entity';
import { CollaboratorEntity } from '../../entities/collaborator.entity';
import { VerificationCodeEntity } from '../../entities/verification-code.entity';
import { COLABORATOR_TYPE_ENUM } from '../../enum/colaborator-type.enum';
import { SIGNATURE_TYPE_ENUM } from '../../enum/signature-type.enum';
import { SIGNEE_STATUS_ENUM } from '../../enum/signee-status.enum';
import { VERIFICATION_EVENT_ENUM } from '../../enum/verification-event.enum';
import {
  SimpleSignatureDTO,
  SimpleSignerSignature,
} from '../dto/simple-signature.dto';
import { IncompleteSimpleSignatureDataException } from '../exceptions/seal.exceptions';
import { SealApiService } from '../services/seal-api.service';
import { SealEntity } from '../entities/seal.entity';
import { SealMapper } from '../mappers/seal.mapper';
import { SealDocumentResponse } from '../interfaces/seal-document-response.interface';

/**
 * Firma de archivo PNG (89 50 4E 47 0D 0A 1A 0A). Se compara contra los primeros bytes del objeto
 * descargado y no contra su extensión o el mimetype con el que se subió: el nombre lo eligió
 * quien subió el archivo, los bytes no.
 */
const PNG_MAGIC_NUMBER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * Único canal por el que hoy se entrega un código de verificación de firma (ver
 * `DocumentService.requestVerificationCode` -> `EmailService.sendVerificationCodeNotification`).
 *
 * Es una constante y no una columna porque `verification_codes` no registra el canal: mientras el
 * correo sea el único, derivarlo acá es exacto. El día que exista un segundo (SMS, push), este
 * valor tiene que salir de la fila y no de este archivo.
 */
const EMAIL_OTP_VERIFICATION_METHOD = 'EMAIL_OTP';

/**
 * Manda a Seal Service la evidencia de un documento de FIRMA SIMPLE firmado por todos.
 *
 * Es el hermano de `SealDocumentUseCase`, y la separación no es cosmética: en firma avanzada el
 * certificado del SAT prueba quién firmó, mientras que en firma simple la prueba de identidad son
 * justamente estos datos —quién es la persona, con qué código se acreditó y qué rúbrica estampó—,
 * que sin este envío sólo existen en nuestra base.
 *
 * Corre una sola vez por documento, cuando terminó el último firmante: antes el conjunto está
 * incompleto y describiría un documento que todavía no existe.
 */
@Injectable()
export class SendCompletedSimpleSignatureToSealUseCase {
  private readonly logger = new Logger(
    SendCompletedSimpleSignatureToSealUseCase.name,
  );

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(VerificationCodeEntity)
    private readonly verificationCodeRepository: Repository<VerificationCodeEntity>,
    @InjectRepository(SealEntity)
    private readonly sealRepository: Repository<SealEntity>,
    private readonly minioService: MinioService,
    private readonly sealApiService: SealApiService,
  ) {}

  /**
   * @returns La constancia persistida, o `null` si el documento no califica para este flujo
   *   (firma avanzada, firmas pendientes, o sin hashes todavía).
   * @throws {IncompleteSimpleSignatureDataException} Si el documento sí califica pero a algún
   *   firmante le falta un dato obligatorio. Se lanza ANTES de llamar al proveedor: un envío a
   *   medias es peor que ninguno, porque queda del otro lado como la evidencia completa del
   *   documento.
   */
  async execute(documentId: string): Promise<SealEntity | null> {
    const document = await this.findDocumentWithSigners(documentId);

    if (!document || !this.isCompletedSimpleSignature(document)) {
      return null;
    }

    const signers = this.signerCollaborators(document);
    const dto: SimpleSignatureDTO = {
      documentId: document.id,
      originalHash: document.originalHash,
      signedHash: document.signedHash,
      signatures: await Promise.all(
        signers.map((signer) => this.toSignerSignature(document.id, signer)),
      ),
    };

    const response = await this.sealApiService.sendSimpleSignatures(dto);

    // Sólo el documento, el número de firmantes y el resultado: nada del contenido del DTO.
    this.logger.log(
      `Firmas simples del documento ${document.id} enviadas a Seal Service (${dto.signatures.length} firmante(s)).`,
    );

    /**
     * La constancia se persiste con el MISMO mapper que la avanzada: la respuesta del proveedor
     * tiene idéntica forma, así que interpretarla dos veces sólo abriría la puerta a que las dos
     * lecturas se separaran. De aquí sale lo que la hoja imprime en su tabla NOM-151.
     */
    return this.persistSeal(dto, response);
  }

  /**
   * Guarda la constancia, tolerando que ya exista.
   *
   * Un documento se sella una sola vez, pero el flujo de firma puede reintentarse tras un fallo
   * posterior al sellado; en ese caso el índice único de `document_id` salta y lo correcto es
   * releer la fila que ya está, no perder la constancia ni tumbar la firma.
   */
  private async persistSeal(
    dto: SimpleSignatureDTO,
    response: SealDocumentResponse,
  ): Promise<SealEntity | null> {
    try {
      return await this.sealRepository.save(
        this.sealRepository.create(
          SealMapper.toEntity({ documentId: dto.documentId }, response),
        ),
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo persistir la constancia del documento ${dto.documentId}; se relee la existente: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return this.sealRepository.findOneBy({ documentId: dto.documentId });
    }
  }

  /**
   * Trae el documento con todo lo que el DTO necesita en una sola consulta: sus colaboradores, la
   * cuenta de cada uno, el usuario de esa cuenta, su información personal y su firma vigente.
   *
   * El filtro por rol va en el `ON` del join y no en un `WHERE`: con el filtro en el `WHERE`, un
   * documento que además tuviera observadores se descartaría entero en vez de devolverse sin
   * ellos.
   */
  private findDocumentWithSigners(
    documentId: string,
  ): Promise<DocumentEntity | null> {
    return this.documentRepository
      .createQueryBuilder('document')
      .leftJoinAndSelect(
        'document.collaborators',
        'collaborator',
        'collaborator.colaborator_type = :signerType',
        { signerType: COLABORATOR_TYPE_ENUM.SIGNER },
      )
      .leftJoinAndSelect('collaborator.account', 'account')
      .leftJoinAndSelect('account.user', 'user')
      .leftJoinAndSelect('user.personalInformation', 'personalInformation')
      .leftJoinAndSelect('user.signature', 'signature')
      .where('document.id = :documentId', { documentId })
      .getOne();
  }

  /**
   * Comprueba las condiciones del disparador, en el orden en que descartan más rápido.
   *
   * Ninguna es un error: un documento de firma avanzada, uno a medio firmar o uno que todavía no
   * tiene `signedHash` simplemente no son asunto de este flujo. Se distinguen así de los datos
   * faltantes, que sí lo son y por eso lanzan.
   */
  private isCompletedSimpleSignature(document: DocumentEntity): boolean {
    const signers = this.signerCollaborators(document);

    if (signers.length === 0) {
      return false;
    }

    /**
     * `!== FIEL` y no `=== SIMPLE`: `signature_type` es nullable y las filas anteriores a que
     * existiera la firma avanzada lo tienen en NULL siendo firma simple. Es el mismo criterio con
     * el que `DocumentService.sign` decide por qué rama firmar, y los dos tienen que coincidir o
     * habría documentos que se firman como simples y no se envían como tales.
     */
    const isSimpleSignature = signers.every(
      (signer) => signer.signatureType !== SIGNATURE_TYPE_ENUM.FIEL,
    );

    const allSigned = signers.every(
      (signer) => signer.status === SIGNEE_STATUS_ENUM.SIGNED,
    );

    return (
      isSimpleSignature &&
      allSigned &&
      Boolean(document.originalHash) &&
      Boolean(document.signedHash)
    );
  }

  private signerCollaborators(document: DocumentEntity): CollaboratorEntity[] {
    return (document.collaborators ?? []).filter(
      (collaborator) =>
        collaborator.colaboratorType === COLABORATOR_TYPE_ENUM.SIGNER,
    );
  }

  private async toSignerSignature(
    documentId: string,
    signer: CollaboratorEntity,
  ): Promise<SimpleSignerSignature> {
    const user = signer.account?.user;

    if (!user) {
      throw new IncompleteSimpleSignatureDataException(
        'la cuenta de plataforma',
        signer.id,
      );
    }

    /**
     * La CURP, el nombre y el apellido salen de `personal_information` —la información personal
     * canónica— y no de las copias que `users` guarda del registro. Se cae a esas copias sólo si
     * la canónica falta, para no perder un envío por una fila incompleta.
     */
    const personalInformation = user.personalInformation;
    const curp = personalInformation?.curp || user.nationalId;
    const name = personalInformation?.name || user.firstName;
    const lastName = personalInformation?.lastName || user.lastName;

    this.assertPresent(curp, 'la CURP', signer.id);
    this.assertPresent(user.email, 'el correo', signer.id);
    this.assertPresent(name, 'el nombre', signer.id);
    this.assertPresent(lastName, 'el apellido', signer.id);

    if (!signer.signedAt) {
      throw new IncompleteSimpleSignatureDataException(
        'la fecha de firma',
        signer.id,
      );
    }

    return {
      curp,
      email: user.email,
      name,
      lastName,
      /**
       * Pasa por `new Date(...)` en vez de llamar a `.toISOString()` directo porque el mismo
       * campo llega como `Date` cuando la fila se acaba de escribir en esta petición y como
       * string cuando se releyó de la base. Mismo criterio que el sellado de firma avanzada.
       */
      signedAt: new Date(signer.signedAt).toISOString(),
      verificationData: await this.resolveVerificationData(documentId, signer),
      signatureMedia: {
        signatureImage: await this.resolveSignatureImage(signer),
        /**
         * Anverso y reverso de la INE: todavía no se descargan de Didit, así que se omiten. Su
         * ausencia no bloquea el envío — ver `SimpleSignatureMedia`.
         */
      },
    };
  }

  /**
   * Resuelve el código de un solo uso que este firmante consumió para firmar ESTE documento.
   *
   * Toma el más reciente por `used_at`: un firmante puede haber consumido varios si un intento
   * anterior no completó la firma, y el que la sustenta es el último. Mismo criterio que
   * `VerificationCodeService.findConsumedCode`, que alimenta la vista pública; si difirieran, la
   * evidencia enviada y la mostrada no serían la misma.
   */
  private async resolveVerificationData(
    documentId: string,
    signer: CollaboratorEntity,
  ): Promise<SimpleSignerSignature['verificationData']> {
    const consumedCode = await this.verificationCodeRepository
      .createQueryBuilder('verificationCode')
      .where('verificationCode.document_id = :documentId', { documentId })
      .andWhere('verificationCode.signer_id = :signerId', {
        signerId: signer.id,
      })
      .andWhere('verificationCode.event = :event', {
        event: VERIFICATION_EVENT_ENUM.SIGN_DOCUMENT,
      })
      .andWhere('verificationCode.is_used = true')
      .orderBy('verificationCode.used_at', 'DESC')
      .getOne();

    if (!consumedCode?.usedAt) {
      throw new IncompleteSimpleSignatureDataException(
        'el código de verificación consumido',
        signer.id,
      );
    }

    return {
      code: consumedCode.code,
      verificationMethod: EMAIL_OTP_VERIFICATION_METHOD,
      usedAt: new Date(consumedCode.usedAt).toISOString(),
    };
  }

  /**
   * Descarga de MinIO la rúbrica del firmante y la devuelve en Base64.
   *
   * Prefiere `signatureSnapshotObjectKey` —la copia inmutable del instante de firmar— sobre la firma
   * en vivo del perfil: la evidencia tiene que ser la que realmente se estampó en el PDF, no la que
   * el usuario tenga hoy. La firma en vivo queda como respaldo para las filas anteriores al snapshot.
   */
  private async resolveSignatureImage(
    signer: CollaboratorEntity,
  ): Promise<string> {
    const objectKey =
      signer.signatureSnapshotObjectKey ??
      signer.account?.user?.signature?.signatureObjectKey;

    if (!objectKey) {
      throw new IncompleteSimpleSignatureDataException(
        'la imagen de firma PNG',
        signer.id,
      );
    }

    const image = await this.minioService.getFileInBytesFormat(
      objectKey,
      BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
    );

    if (!this.isPng(image)) {
      throw new IncompleteSimpleSignatureDataException(
        'una imagen de firma en formato PNG (el archivo almacenado no lo es)',
        signer.id,
      );
    }

    // Base64 y no bytes crudos: el cuerpo del envío es JSON. Ver `SimpleSignatureMedia`.
    return image.toString('base64');
  }

  private isPng(image: Buffer): boolean {
    return (
      image.length > PNG_MAGIC_NUMBER.length &&
      image.subarray(0, PNG_MAGIC_NUMBER.length).equals(PNG_MAGIC_NUMBER)
    );
  }

  private assertPresent(
    value: string | null | undefined,
    missingData: string,
    collaboratorId: string,
  ): asserts value is string {
    if (!value) {
      throw new IncompleteSimpleSignatureDataException(
        missingData,
        collaboratorId,
      );
    }
  }
}
