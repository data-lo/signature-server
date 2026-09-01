import { Test, TestingModule } from '@nestjs/testing';
import { DocumentController } from './document.controller';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';
import { SEAL_ARTIFACT_ENUM } from './seal/seal-artifacts';
import type { Response } from 'express';

import { GetDocumentFileUrlUseCase } from './applications/get-document-file-url.use-case';
import { GetPublicDocumentUseCase } from './applications/get-public-document.use-case';
import { GetPublicSealArtifactUseCase } from './applications/get-public-seal-artifact.use-case';
import { GetPublicDocumentAuditXmlUseCase } from './applications/get-public-document-audit-xml.use-case';
import { GetPublicAdvancedSignatureUseCase } from './applications/get-public-advanced-signature.use-case';
import { CreateDocumentUseCase } from './applications/create-document.use-case';
import { GetDocumentsUseCase } from './applications/get-documents.use-case';
import { GetDocumentUseCase } from './applications/get-document.use-case';
import { SubmitDocumentForAuthorizationUseCase } from './applications/submit-document-for-authorization.use-case';
import { SignDocumentUseCase } from './applications/sign-document.use-case';
import { LinkDocumentCollaboratorUseCase } from './applications/link-document-collaborator.use-case';
import { RequestDocumentVerificationCodeUseCase } from './applications/request-document-verification-code.use-case';
import { VerifyDocumentCodeUseCase } from './applications/verify-document-code.use-case';
import { RejectDocumentUseCase } from './applications/reject-document.use-case';
import { SubmitDocumentForCancellationUseCase } from './applications/submit-document-for-cancellation.use-case';
import { ConfirmDocumentCancellationUseCase } from './applications/confirm-document-cancellation.use-case';
import { UpdateDocumentUseCase } from './applications/update-document.use-case';
import { DeleteDocumentUseCase } from './applications/delete-document.use-case';

type Mocked = { execute: jest.Mock };

const USE_CASES = [
  GetDocumentFileUrlUseCase,
  GetPublicDocumentUseCase,
  GetPublicSealArtifactUseCase,
  GetPublicDocumentAuditXmlUseCase,
  GetPublicAdvancedSignatureUseCase,
  CreateDocumentUseCase,
  GetDocumentsUseCase,
  GetDocumentUseCase,
  SubmitDocumentForAuthorizationUseCase,
  SignDocumentUseCase,
  LinkDocumentCollaboratorUseCase,
  RequestDocumentVerificationCodeUseCase,
  VerifyDocumentCodeUseCase,
  RejectDocumentUseCase,
  SubmitDocumentForCancellationUseCase,
  ConfirmDocumentCancellationUseCase,
  UpdateDocumentUseCase,
  DeleteDocumentUseCase,
];

describe('DocumentController', () => {
  let controller: DocumentController;
  let module: TestingModule;

  const useCase = (token: unknown) => module.get(token as never) as Mocked;

  const user: JwtPayload = {
    sub: 'user-1',
    email: 'juan@empresa.com',
    roles: ['signer'],
    nationalId: 'PELJ850101HDFRNN08',
    jti: 'jti-1',
  };

  beforeEach(async () => {
    module = await Test.createTestingModule({
      controllers: [DocumentController],
      providers: USE_CASES.map((provide) => ({
        provide,
        useValue: { execute: jest.fn() },
      })),
    }).compile();

    controller = module.get<DocumentController>(DocumentController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('create delega en CreateDocumentUseCase con el userId y el X-Account-Id', async () => {
    const dto = { signerIds: ['user-2'], watcherIds: [] } as any;
    const file = { originalname: 'contrato.pdf' } as Express.Multer.File;

    await controller.create(user, 'account-1', dto, file, '127.0.0.1');

    expect(useCase(CreateDocumentUseCase).execute).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      dto,
      file,
      '127.0.0.1',
    );
  });

  /**
   * El control de acceso a la descarga es su propio paso y vive en el caso de uso: la pantalla
   * de detalle y el archivo se comprueban por separado, y cuando sólo se validaba la primera el
   * visor pedía este endpoint y recibía 403.
   */
  it('getDocumentUrl delega en GetDocumentFileUrlUseCase con el userId autenticado', async () => {
    await controller.getDocumentUrl(user, 'doc-1');

    expect(useCase(GetDocumentFileUrlUseCase).execute).toHaveBeenCalledWith(
      'doc-1',
      'user-1',
      { asAttachment: false },
    );
  });

  /**
   * Historia "Descargar documentos usando el nombre del archivo en lugar del ID": `?download=true`
   * es lo único que separa bajar el archivo —con el nombre del documento— de mostrarlo en el
   * visor. Se compara contra la cadena `'true'` y no por presencia: un query sin valor no debe
   * convertir en descarga la petición del visor.
   */
  it.each([
    ['true', true],
    ['false', false],
    [undefined, false],
    ['', false],
    ['1', false],
  ])('con download=%s pide asAttachment=%s', async (download, expected) => {
    await controller.getDocumentUrl(user, 'doc-1', download);

    expect(useCase(GetDocumentFileUrlUseCase).execute).toHaveBeenCalledWith(
      'doc-1',
      'user-1',
      { asAttachment: expected },
    );
  });

  // Historia "Visualización pública de documentos firmados mediante MinIO": esta ruta va
  // marcada @SkipJwtAuth() (sin JWT ni x-api-key) — a diferencia del resto del controller, no
  // recibe @CurrentUser(), así que el único contrato que le toca verificar a este test es la
  // delegación directa por id.
  it('getPublicDocumentView delega en GetPublicDocumentUseCase solo con el id', async () => {
    const response = {
      success: true,
      message: 'Documento obtenido correctamente',
      data: {
        id: 'doc-1',
        fileName: 'contrato.pdf',
        status: 'signed',
        secureUrl: 'https://minio/signed-documents/doc-1',
        expiresIn: 86400,
      },
    };
    useCase(GetPublicDocumentUseCase).execute.mockResolvedValue(response);

    const result = await controller.getPublicDocumentView('doc-1');

    expect(useCase(GetPublicDocumentUseCase).execute).toHaveBeenCalledWith(
      'doc-1',
    );
    expect(result).toBe(response);
  });

  /**
   * Descarga de un artefacto de la constancia (historia "Actualizar vista pública de verificación
   * de documentos según estado y tipo de firma"). Es de los pocos endpoints que escriben en la
   * respuesta a mano en vez de devolver un objeto, así que lo que hay que verificar son las
   * cabeceras: sin `Content-Disposition: attachment` el navegador intentaría renderizar el token
   * del PSC en vez de guardarlo.
   */
  it('getPublicSealArtifact sirve el archivo como adjunto', async () => {
    const content = Buffer.from('%PDF-1.4 constancia');
    useCase(GetPublicSealArtifactUseCase).execute.mockResolvedValue({
      content,
      contentType: 'application/pdf',
      fileName: 'constancia-nom151-doc-1.pdf',
    });
    const response = { setHeader: jest.fn(), send: jest.fn() };

    await controller.getPublicSealArtifact(
      'doc-1',
      SEAL_ARTIFACT_ENUM.NOM151,
      response as unknown as Response,
    );

    expect(useCase(GetPublicSealArtifactUseCase).execute).toHaveBeenCalledWith(
      'doc-1',
      SEAL_ARTIFACT_ENUM.NOM151,
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'application/pdf',
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="constancia-nom151-doc-1.pdf"',
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Length',
      String(content.length),
    );
    expect(response.send).toHaveBeenCalledWith(content);
  });

  /**
   * El XML de auditoría se genera en el momento y no está guardado en ningún lado, pero se sirve
   * igual que la constancia: como adjunto. Sin `Content-Disposition` el navegador abriría el XML
   * en una pestaña —con los PDFs en Base64 dentro— en vez de guardarlo.
   */
  it('getPublicDocumentAuditXml sirve el XML como adjunto', async () => {
    const content = Buffer.from('<?xml version="1.0" encoding="UTF-8"?>');
    useCase(GetPublicDocumentAuditXmlUseCase).execute.mockResolvedValue({
      content,
      contentType: 'application/xml',
      fileName: 'auditoria-doc-1.xml',
    });
    const response = { setHeader: jest.fn(), send: jest.fn() };

    await controller.getPublicDocumentAuditXml(
      'doc-1',
      response as unknown as Response,
    );

    expect(
      useCase(GetPublicDocumentAuditXmlUseCase).execute,
    ).toHaveBeenCalledWith('doc-1');
    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'application/xml',
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="auditoria-doc-1.xml"',
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Length',
      String(content.length),
    );
    expect(response.send).toHaveBeenCalledWith(content);
  });

  it('findAll delega en GetDocumentsUseCase con el userId y el X-Account-Id', () => {
    const query = { page: 1, limit: 10 } as any;

    controller.findAll(user, 'account-1', query);

    expect(useCase(GetDocumentsUseCase).execute).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      query,
    );
  });

  it('findOne delega en GetDocumentUseCase con el userId autenticado', () => {
    controller.findOne(user, 'doc-1');

    expect(useCase(GetDocumentUseCase).execute).toHaveBeenCalledWith(
      'doc-1',
      'user-1',
    );
  });

  /**
   * El controller aplana los arreglos de multer: el caso de uso recibe "la llave" y "el
   * certificado", no la forma que impone el multipart.
   */
  it('sign aplana los archivos de e.firma y pasa la geolocalizacion del DTO', () => {
    const keyFile = { originalname: 'clave.key' } as Express.Multer.File;
    const cerFile = { originalname: 'cert.cer' } as Express.Multer.File;
    const geolocation = { latitude: 19.4326, longitude: -99.1332 } as any;

    controller.sign(
      user,
      'doc-1',
      { password: 'secreto', geolocation } as any,
      {
        key: [keyFile],
        cer: [cerFile],
      },
    );

    expect(useCase(SignDocumentUseCase).execute).toHaveBeenCalledWith(
      'doc-1',
      'user-1',
      { password: 'secreto', keyFile, cerFile },
      geolocation,
    );
  });

  it('sign tolera una firma simple, sin archivos ni contrasena', () => {
    controller.sign(user, 'doc-1', {} as any, {});

    expect(useCase(SignDocumentUseCase).execute).toHaveBeenCalledWith(
      'doc-1',
      'user-1',
      { password: undefined, keyFile: undefined, cerFile: undefined },
      undefined,
    );
  });

  it('submitForAuthorization delega en su caso de uso con el userId autenticado', () => {
    controller.submitForAuthorization(user, 'doc-1');

    expect(
      useCase(SubmitDocumentForAuthorizationUseCase).execute,
    ).toHaveBeenCalledWith('doc-1', 'user-1');
  });

  it('linkCollaborator delega en LinkDocumentCollaboratorUseCase con el userId autenticado', async () => {
    await controller.linkCollaborator(user, 'doc-1');

    expect(
      useCase(LinkDocumentCollaboratorUseCase).execute,
    ).toHaveBeenCalledWith('doc-1', 'user-1');
  });

  it('requestVerificationCode pasa la IP del cliente al caso de uso', () => {
    controller.requestVerificationCode(user, 'doc-1', '127.0.0.1');

    expect(
      useCase(RequestDocumentVerificationCodeUseCase).execute,
    ).toHaveBeenCalledWith('doc-1', 'user-1', '127.0.0.1');
  });

  it('verifyCode pasa solo el codigo del body', () => {
    controller.verifyCode(user, 'doc-1', { code: '123456' });

    expect(useCase(VerifyDocumentCodeUseCase).execute).toHaveBeenCalledWith(
      'doc-1',
      'user-1',
      '123456',
    );
  });

  it('reject pasa solo el motivo del body', () => {
    controller.reject(user, 'doc-1', { reason: 'No estoy de acuerdo' } as any);

    expect(useCase(RejectDocumentUseCase).execute).toHaveBeenCalledWith(
      'doc-1',
      'user-1',
      'No estoy de acuerdo',
    );
  });

  it('submitForCancellation delega en su caso de uso con el userId autenticado', () => {
    controller.submitForCancellation(user, 'doc-1');

    expect(
      useCase(SubmitDocumentForCancellationUseCase).execute,
    ).toHaveBeenCalledWith('doc-1', 'user-1');
  });

  it('confirmCancellation delega en su caso de uso con el userId autenticado', () => {
    controller.confirmCancellation(user, 'doc-1');

    expect(
      useCase(ConfirmDocumentCancellationUseCase).execute,
    ).toHaveBeenCalledWith('doc-1', 'user-1');
  });

  it('update delega en UpdateDocumentUseCase con las coordenadas del body', () => {
    const dto = { signatures: [] } as any;
    controller.update(user, 'doc-1', dto);

    expect(useCase(UpdateDocumentUseCase).execute).toHaveBeenCalledWith(
      'doc-1',
      'user-1',
      dto,
    );
  });

  it('remove delega en DeleteDocumentUseCase con el userId autenticado', () => {
    controller.remove(user, 'doc-1');

    expect(useCase(DeleteDocumentUseCase).execute).toHaveBeenCalledWith(
      'doc-1',
      'user-1',
    );
  });

  it('getAdvancedSignature delega en su caso de uso con el id y el collaboratorId', async () => {
    await controller.getAdvancedSignature('doc-1', 'collaborator-1');

    expect(
      useCase(GetPublicAdvancedSignatureUseCase).execute,
    ).toHaveBeenCalledWith('doc-1', 'collaborator-1');
  });
});
