import { CreateDocumentSignaturesDto } from '../../dto/create-document-signatures.dto';

/**
 * `POST /api/v1/integration/documents` (multipart): `file` (PDF), `documentData` (JSON) y
 * `collaborators` (JSON).
 *
 * Es exactamente el contrato de `POST /api/v1/documents/signatures`, a propósito: la creación
 * reutiliza `CreateDocumentSignatureFlowUseCase` y sus validaciones, así que un documento creado
 * por integración cumple las mismas reglas que uno creado desde la plataforma.
 *
 * Lo que NO trae, ni se acepta: `organizationId`, `taxId`, `accountId`, `createdBy` ni
 * `createdByUserId`, en el body ni dentro de `documentData`. La organización y el autor salen de
 * la API key; si alguno llega, se responde 400 en vez de ignorarlo (ver
 * `assertNoTenantOverrides`). El `taxId` de un TESTIGO, dentro de `collaborators`, sí es válido.
 */
export class CreateIntegrationDocumentDto extends CreateDocumentSignaturesDto {}
