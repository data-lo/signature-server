import type { Provider } from '@nestjs/common';

import { GetDocumentFileUrlUseCase } from './../src/document/applications/get-document-file-url.use-case';
import { GetPublicDocumentUseCase } from './../src/document/applications/get-public-document.use-case';
import { GetPublicSealArtifactUseCase } from './../src/document/applications/get-public-seal-artifact.use-case';
import { GetPublicAdvancedSignatureUseCase } from './../src/document/applications/get-public-advanced-signature.use-case';
import { CreateDocumentUseCase } from './../src/document/applications/create-document.use-case';
import { GetDocumentsUseCase } from './../src/document/applications/get-documents.use-case';
import { GetDocumentUseCase } from './../src/document/applications/get-document.use-case';
import { SubmitDocumentForAuthorizationUseCase } from './../src/document/applications/submit-document-for-authorization.use-case';
import { LinkDocumentCollaboratorUseCase } from './../src/document/applications/link-document-collaborator.use-case';
import { RequestDocumentVerificationCodeUseCase } from './../src/document/applications/request-document-verification-code.use-case';
import { VerifyDocumentCodeUseCase } from './../src/document/applications/verify-document-code.use-case';
import { RejectDocumentUseCase } from './../src/document/applications/reject-document.use-case';
import { SubmitDocumentForCancellationUseCase } from './../src/document/applications/submit-document-for-cancellation.use-case';
import { ConfirmDocumentCancellationUseCase } from './../src/document/applications/confirm-document-cancellation.use-case';
import { UpdateDocumentUseCase } from './../src/document/applications/update-document.use-case';
import { DeleteDocumentUseCase } from './../src/document/applications/delete-document.use-case';

/**
 * Dobles inertes para los casos de uso de `DocumentController` que una prueba end-to-end no
 * ejercita.
 *
 * Nest resuelve el constructor completo del controller aunque la prueba sólo llame a una de sus
 * rutas, así que sin estos dobles habría que cablear las dependencias reales de los diecisiete
 * casos de uso para probar uno. Cada prueba registra por su cuenta el caso de uso que sí quiere
 * ejercitar: como se declara después de este arreglo, su provider gana.
 */
export const DOCUMENT_CONTROLLER_USE_CASE_STUBS: Provider[] = [
  GetDocumentFileUrlUseCase,
  GetPublicDocumentUseCase,
  GetPublicSealArtifactUseCase,
  GetPublicAdvancedSignatureUseCase,
  CreateDocumentUseCase,
  GetDocumentsUseCase,
  GetDocumentUseCase,
  SubmitDocumentForAuthorizationUseCase,
  LinkDocumentCollaboratorUseCase,
  RequestDocumentVerificationCodeUseCase,
  VerifyDocumentCodeUseCase,
  RejectDocumentUseCase,
  SubmitDocumentForCancellationUseCase,
  ConfirmDocumentCancellationUseCase,
  UpdateDocumentUseCase,
  DeleteDocumentUseCase,
].map((provide) => ({ provide, useValue: { execute: jest.fn() } }));
