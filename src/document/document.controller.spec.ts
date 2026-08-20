import { Test, TestingModule } from '@nestjs/testing';
import { DocumentController } from './document.controller';
import { DocumentService } from './document.service';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';
import { SEAL_ARTIFACT_ENUM } from './seal/seal-artifacts';
import type { Response } from 'express';

describe('DocumentController', () => {
  let controller: DocumentController;
  let documentService: {
    create: jest.Mock;
    findWithFilters: jest.Mock;
    findDetailForUser: jest.Mock;
    getDocumentMinioURL: jest.Mock;
    getPublicDocumentView: jest.Mock;
    getPublicSealArtifact: jest.Mock;
    assertUserHasAccess: jest.Mock;
    submitForAuthorization: jest.Mock;
    sign: jest.Mock;
    linkPendingCollaboratorAccount: jest.Mock;
    reject: jest.Mock;
    requestCancellation: jest.Mock;
    confirmCancellation: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
  };

  const user: JwtPayload = {
    sub: 'user-1',
    email: 'juan@empresa.com',
    roles: ['signer'],
    nationalId: 'PELJ850101HDFRNN08',
    jti: 'jti-1',
  };

  beforeEach(async () => {
    documentService = {
      create: jest.fn(),
      findWithFilters: jest.fn(),
      findDetailForUser: jest.fn(),
      getDocumentMinioURL: jest.fn(),
      getPublicDocumentView: jest.fn(),
      getPublicSealArtifact: jest.fn(),
      assertUserHasAccess: jest.fn(),
      submitForAuthorization: jest.fn(),
      sign: jest.fn(),
      linkPendingCollaboratorAccount: jest.fn(),
      reject: jest.fn(),
      requestCancellation: jest.fn(),
      confirmCancellation: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DocumentController],
      providers: [{ provide: DocumentService, useValue: documentService }],
    }).compile();

    controller = module.get<DocumentController>(DocumentController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('create delega en documentService.create con el userId y el X-Account-Id', async () => {
    const dto = { signerIds: ['user-2'], watcherIds: [] } as any;
    const file = { originalname: 'contrato.pdf' } as Express.Multer.File;

    await controller.create(user, 'account-1', dto, file, '127.0.0.1');

    expect(documentService.create).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      dto,
      file,
      '127.0.0.1',
    );
  });

  // Historia "Visualización pública de documentos firmados mediante MinIO": esta ruta va
  // marcada @SkipJwtAuth() (sin JWT ni x-api-key) — a diferencia del resto del controller, no
  // recibe @CurrentUser() ni llama a assertUserHasAccess, así que el único contrato que le toca
  // verificar a este test es la delegación directa por id.
  it('getPublicDocument delega en documentService.getPublicDocumentView con el id, sin ningún chequeo de acceso', async () => {
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
    documentService.getPublicDocumentView.mockResolvedValue(response);

    const result = await controller.getPublicDocument('doc-1');

    expect(documentService.getPublicDocumentView).toHaveBeenCalledWith('doc-1');
    expect(documentService.assertUserHasAccess).not.toHaveBeenCalled();
    expect(result).toBe(response);
  });

  /**
   * Descarga de un artefacto de la constancia (historia "Actualizar vista pública de verificación
   * de documentos según estado y tipo de firma"). Es de los pocos endpoints que escriben en la
   * respuesta a mano en vez de devolver un objeto, así que lo que hay que verificar son las
   * cabeceras: sin `Content-Disposition: attachment` el navegador intentaría renderizar el token
   * del PSC en vez de guardarlo.
   */
  it('getPublicSealArtifact sirve el archivo como adjunto, sin ningún chequeo de acceso', async () => {
    const content = Buffer.from('%PDF-1.4 constancia');
    documentService.getPublicSealArtifact.mockResolvedValue({
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

    expect(documentService.getPublicSealArtifact).toHaveBeenCalledWith(
      'doc-1',
      SEAL_ARTIFACT_ENUM.NOM151,
    );
    expect(documentService.assertUserHasAccess).not.toHaveBeenCalled();
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

  it('findAll delega en documentService.findWithFilters con el userId y el X-Account-Id', () => {
    const query = { page: 1, limit: 10 } as any;

    controller.findAll(user, 'account-1', query);

    expect(documentService.findWithFilters).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      query,
    );
  });

  it('linkCollaborator delega en documentService.linkPendingCollaboratorAccount con el userId autenticado', async () => {
    await controller.linkCollaborator(user, 'doc-1');

    expect(documentService.linkPendingCollaboratorAccount).toHaveBeenCalledWith(
      'doc-1',
      'user-1',
    );
  });
});
