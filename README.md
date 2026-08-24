# Signature Server

Backend en NestJS para una plataforma de firma electrónica de documentos: gestión de usuarios, credencial de firma (rúbrica + identificación oficial), creación y firma secuencial de documentos, cuentas/organizaciones con membresías, suscripciones (Stripe) y auditoría con cadena de integridad.

## 1. Proceso de firmado de documentos

> Esta sección describe el flujo del endpoint original `POST /document`. Sigue existiendo y expuesto, pero `signature-app` hoy crea documentos vía `POST /api/v1/documents/signatures` (multipart, colaboradores de datos libres) — ver sección 3, módulo `document-signatures`, para el contrato realmente en uso. La entidad de participante también cambió de nombre (`DocumentParticipantEntity` → `CollaboratorEntity`, ver sección 2.1) desde que se escribió originalmente esta sección; el flujo paso a paso de abajo sigue siendo conceptualmente válido para ambos endpoints.

### 1.1 Dos conceptos que no hay que confundir

| Concepto | Entidad | Qué representa |
|---|---|---|
| **Firma del usuario (credencial)** | `SignatureEntity` (módulo `signature`) | La imagen PNG de la rúbrica + la foto de la identificación oficial (INE) del usuario. Se registra **una sola vez** por usuario (relación 1–1 opcional `Users.signatureId`). |
| **Firma de un documento (acto de firmar)** | `CollaboratorEntity` (módulo `document`, antes `DocumentParticipantEntity`) | El acto de que un colaborador concreto firme o rechace un documento concreto. Requiere que el usuario ya tenga su credencial (`SignatureEntity`) completa y activa. |

### 1.2 Flujo paso a paso

1. **Crear el documento** — `POST /document` (multipart: `file` PDF, `signerIds` en orden de firma, `spectatorIds` opcionales, `signatureCoordinates` opcional).
   - Valida que todos los participantes existan.
   - Sube el PDF a MinIO (bucket `created_documents`).
   - Cuenta páginas (`PdfSignatureService.getPdfPages`) y calcula el hash SHA-256 del original (`originalHash`).
   - Crea el `DocumentEntity` (`status = CREATED`) y un `CollaboratorEntity` por firmante (`colaboratorType = SIGNER`, `signingOrder` = posición en el arreglo) y por espectador (`colaboratorType = WATCHER`, sin orden, solo visualiza).

2. **Enviar a firma** — `PATCH /document/:id/submit-for-authorization` (solo el creador, solo si `status = CREATED`).
   - `status → PENDING` y se notifica por correo al **primer firmante** según `signOrder`.

3. **Firma secuencial obligatoria** — no hay firma en paralelo: cada firmante solo puede actuar cuando todos los firmantes anteriores en `signOrder` ya firmaron. Antes de firmar/rechazar se exige tener credencial de firma completa y activa (`signatureId`, `isActive`, imagen de firma e INE presentes).

4. **Firmar** — `PATCH /document/:id/sign`.
   - Si quedan firmantes pendientes: marca al participante `SIGNED`, registra auditoría (`DOCUMENT_SIGNED`) y notifica al siguiente en turno.
   - Si es el **último firmante**: antes de marcarlo, se ejecuta la finalización (ver 1.3) — así, si el estampado del PDF falla, nada queda marcado como firmado y la operación es reintentable.

5. **Rechazar** — `PATCH /document/:id/reject` (motivo obligatorio). Estampa una marca de agua diagonal "RECHAZADO", mueve el archivo a `rejected_documents`, `status → REJECTED`, notifica al creador con el motivo. El flujo de firma queda cerrado.

6. **Solicitar cancelación** (solo el creador, solo si `status = SIGNED`) — `PATCH /document/:id/submit-for-cancellation`: `status → CANCELLATION_PENDING`, notifica a los firmantes.

7. **Confirmar cancelación** (cualquier firmante, solo si `status = CANCELLATION_PENDING`) — `PATCH /document/:id/confirm-cancellation`: basta una confirmación (igual que el rechazo, no se vota entre todos los firmantes). Estampa marca de agua diagonal "CANCELADO", mueve el archivo a `cancelled_documents`, `status → CANCELLED`, audita `DOCUMENT_CANCELLED` y notifica a todos los participantes.

8. Otras operaciones: `GET /document` (listado paginado con filtros: id, email, participante, estado, fechas, "solo mi turno"), `GET /document/:id` (detalle + `canSign`/`canReject`/`canRequestCancellation`/`canConfirmCancellation`/`myRole`/`myStatus` calculados para la pantalla de firma), `PATCH /document/:id` y `DELETE /document/:id` (solo mientras `status = CREATED`).

### 1.3 Finalización del documento (`finalizeSignedDocument`, privado)

Cuando firma el último firmante pendiente:
1. Descarga el PDF original de MinIO.
2. Para **cada firmante en orden**, descarga su imagen de firma y usa `PdfSignatureService.mergeSignatureIntoPdf` (incrusta el PNG en la última página, normaliza tamaño a un rango válido) + `addSignerName` (nombre debajo de la firma). Las firmas se apilan verticalmente.
3. Aplica conformidad **PDF/A-2B** (metadatos XMP + `OutputIntent` con perfil ICC sRGB) y sube el resultado a `signed_documents` reutilizando el mismo `objectKey`.
4. Calcula `signedHash`, marca `status = SIGNED`, `signedAt`, y envía el PDF final por correo a todos los participantes.
5. Anexa la **hoja de evidencia** al documento firmado (`attachSignaturesSheet`) y guarda esa copia —la definitiva, la única que el usuario ve y descarga— en el bucket `finalized_documents`. Se arma después de calcular `signedHash` (la hoja lo imprime) y antes de marcar el documento como `SIGNED`: si falla, el documento no queda firmado y el intento se puede repetir, en vez de dejar una versión final que no existe.

**Hay una hoja de evidencia por tipo de firma**, y son independientes entre sí (módulo `document/summary-document`):

| Hoja | Servicio | Encabezado | Qué acredita |
|---|---|---|---|
| Firma simple | `SummaryDocumentService` | `Firma_Digital_Simple` / banner `Firmalo_Grafo` | Artículos 89, 90 y 93 del Código de Comercio; por firmante imprime Nombre/Tipo/IP/Sustentada/OTP/Fecha/Geo |
| Firma avanzada (e.firma) | `AdvancedSummaryDocumentService` | `Firma_Electrónica_Avanzada` / banner `Firmalo_FIEL` | Artículos 89, 90, 93 y **97**; agrega el número de serie del certificado del SAT y la firma electrónica, leídos de `CollaboratorEntity.advancedSignature` |

`isAdvancedSignatureDocument()` elige cuál se anexa: el tipo de firma es una decisión del documento (`DocumentSignaturesService` lo copia igual a todos sus SIGNER), así que basta con mirar a los firmantes.

**Geolocalización: se registra, no se publica.** Desde la historia "Ocultar geolocalización en hojas
de firma y vistas públicas", ni las hojas de evidencia ni el QR de la firma avanzada imprimen la
ubicación del firmante. El dato NO se tocó donde importa: se sigue exigiendo al firmar
(`GeolocationDto`, un 400 si falta), se sigue guardando en `collaborators.geo_loc` y se sigue
registrando en la cadena de auditoría — de donde se puede consultar por `GET /audit/decrypted`. Lo
único que cambió es que dejó de viajar a la presentación: el campo se quitó de
`SummaryDocumentSigner`, `AdvancedSummaryDocumentSigner` y `AdvancedSignatureQrData` en vez de
dejarlo entrando sin usarse, que es como vuelve a colarse a una plantilla sin que nadie lo note.
Los documentos ya firmados conservan sus hojas y sus QR tal como se generaron: son parte del PDF y
no se regeneran.

**Estructura, idéntica en las dos** (plantillas "Firmalo Hoja de Firmas SIMPLE / AVANZADA"): encabezado con el logo PNG a la izquierda y el tipo de firma a la derecha; banner de guiones; texto legal; tabla **Documento**; tabla **Constancia de Conservación (NOM-151)**; banner `Firmas`; y una tabla **por cada firmante**. El pie lleva el código QR a la vista pública del documento (`/public/documents/:id`, la única consultable sin sesión) más las leyendas legales sobre la descarga de los archivos oficiales. Encabezado y pie se declaran como `header`/`footer` de pdfmake, así que se repiten en todas las páginas — la hoja crece con el número de firmantes.

**Tipografías**: **Lato** para texto corrido (párrafos legales, títulos de sección, pie) y **JetBrains Mono** para el contenido de las tablas y los separadores de guiones, que dependen del ancho fijo por carácter para alinearse. Los `.ttf`, el logo del encabezado y el isotipo del pie viven en `summary-document/fonts/` y `summary-document/assets/`; `nest-cli.json` los copia a `dist/` (`**/*.ttf` y `**/*.png`), y `sheet-rendering.ts` los resuelve por `__dirname` para que funcionen igual en `src/` y en el build.

Lo compartido entre ambas hojas es solo el layout (`sheet-rendering.ts`: tipografías, logo, encabezado, pie, tabla informativa y render a Buffer). Ni un texto legal se comparte: cada tipo de evidencia puede cambiar sin arrastrar al otro.

**Tabla NOM-151.** El sellado ante el PSC corre **antes** de armar la hoja (dentro de `finalizeSignedDocument`, justo antes de `attachSignaturesSheet`); antes era al revés y por eso la tabla salía siempre vacía. Sigue siendo best-effort: si el sellado falla, la firma se completa igual y la hoja se arma sin constancia. Si el documento ya estaba sellado —un intento previo selló y falló más adelante—, la constancia se relee (`SealDocumentUseCase.findByDocumentId`) en vez de perderse.

De los tres renglones de la plantilla solo se llena **EMITIDO**, desde `SealEntity.sealedAt` (columna agregada en `AddSealedAtToDocumentSeals1784300000026`: la respuesta de Seal Service ya traía el dato y el mapper lo descartaba, contradiciendo su propio criterio de "esta es la única oportunidad de guardarlo"). El DN del certificado (TSA) y el número de serie del sello viajan **solo dentro del token RFC 3161** del PSC, y ni PSC CODEX ni Seal Service los exponen por separado (ver `PscCodexResponseHash`: solo `status`, `hashProcessed`, `fileBase64` y `uuid`); sacarlos exige parsear ASN.1 del token, y ese parseo corresponde a Seal Service, que es quien habla con el PSC y ya tiene el token. Los renglones se imprimen vacíos en vez de omitirse: la tabla es parte de la plantilla. En la hoja simple van siempre vacíos, porque un documento de firma simple nunca se sella.

**Dos campos que estas hojas ya no imprimen**, porque las plantillas de referencia no los contemplan: el **"Cifrado"** de la tabla del documento —no se pierde nada, sigue en `AuditChainEntity.chipher`, que es su fuente de verdad; la hoja solo lo mostraba, y se dejó de calcular para no gastar un cifrado que nadie lee— y el **RFC del firmante**, que sigue en `CollaboratorEntity.rfc` y, en la hoja avanzada, dentro del certificado del SAT.

**Qué se estampa por cada firmante** lo decide `resolveStampImage`:

- **Firma simple** — la rúbrica del firmante, tomada del snapshot inmutable del momento de firmar (`signatureSnapshotObjectKey`), no de su perfil en vivo.
- **Firma avanzada (e.firma)** — un **código QR** (`SignatureQrService`), porque la firma avanzada no produce ninguna imagen: su evidencia es criptográfica y su espacio quedaba vacío. Se genera solo cuando esa firma ya se completó.

El QR codifica **texto plano con los datos de esa firma** (historia "Actualizar contenido del código QR en firma avanzada"), no solo un enlace: nombre del firmante y RFC —los del certificado del SAT, con los del colaborador como respaldo—, fecha y hora **con el desfase de la zona horaria del sistema** (`TZ`, o la que resuelva el sistema operativo), IP registrada al firmar, y como última línea la URL de la constancia pública (`GET /document/:id/signatures/:collaboratorId`, ver `getAdvancedSignaturePublicView`). Así quien escanea con cualquier lector ve los datos ahí mismo, sin depender de tener red, y la verificación en línea sigue disponible.

El QR se estampa con `preserveAspectRatio`: la caja de firma es apaisada (200x80 por defecto, pensada para una rúbrica) y estirar ahí un código cuadrado hace que los lectores dejen de reconocer su patrón, así que se escala al lado menor de la caja y se centra. Las rúbricas siguen ocupando la caja completa.

Al estampar también se pinta la **zona de silencio**: un borde blanco de 4pt alrededor del código. El PNG se genera sin margen propio a propósito —así los módulos quedan lo más grandes posible dentro de la caja— y el borde se dibuja por fuera. No es cosmético: medido con un decodificador real sobre la página rasterizada, un QR con el texto del documento pegado **no se lee** a 150 DPI, y con la separación sí.

**Tamaño mínimo.** Una caja de firma puede ser tan chica como 60x24pt, y ahí el QR queda en 24pt de lado (~8.5mm, módulos de 0.12mm): no lo lee ningún decodificador a 96, 150 ni 300 DPI. Se estampa igual —quitarlo dejaría la firma avanzada sin representación visual— pero se registra una advertencia (`PdfSignatureService`) en vez de producir en silencio un código ilegible. A partir de ~60pt de lado se lee sin problema en papel.

**Densidad.** Con los seis renglones de datos más la URL de la constancia, el código sale de 69x69 módulos. En la caja por defecto (80pt de lado) eso deja ~1.55 px por módulo a 96 DPI —pantalla estándar al 100%—, que está en el límite: a esa resolución decodifica o no según dónde caigan los bordes de módulo respecto a la rejilla de píxeles. A 150 DPI o más (impresión, pantalla HiDPI, o simplemente acercar el zoom) se lee siempre. Bajar de 53 módulos exigiría quitar la URL de la constancia o acortarla.

### 1.4 Integridad y auditoría

- `HashService` combina tres mecanismos:
  - **Hash de archivo** (SHA-256) → `originalHash` / `signedHash` del documento.
  - **Hash de registro** (SHA-256 de JSON normalizado) → `integrityHash` de cada evento de auditoría, y `chainHash` = hash(payload + integrityHash + `chainHash` anterior del mismo documento) — cadena tipo blockchain simplificada por documento.
  - **Cifrado reversible** (AES-256-GCM con `CIPHER_SECRET`) → el contenido de cada registro de auditoría se guarda cifrado (`cipher`) y se descifra bajo demanda.
- `AuditService` (Mongo/Mongoose, colección `audits`) persiste esta cadena. Hoy se invoca desde `sign()` (`DOCUMENT_SIGNED`) y `reject()` (`DOCUMENT_REJECTED`) — ver pendientes sobre los eventos que faltan.
- Consulta: `GET /audit/document/:documentId`, `GET /audit/decrypted`, `GET /audit`.

### 1.5 Almacenamiento (MinIO)

6 buckets por tipo de archivo: `created_documents`, `signed_documents`, `cancelled_documents`, `rejected_documents`, `oficial_cards`, `signature_images`. El `objectKey` de un documento se mantiene igual entre buckets al pasar de `CREATED` a `SIGNED`/`REJECTED` (solo cambia de bucket). Todo acceso a archivos se hace vía URL prefirmada temporal (24h por defecto), nunca URLs públicas permanentes.

### 1.6 Notificaciones

`EmailService` (SendGrid) envía: aviso de documento pendiente al firmante en turno, notificación de documento firmado (con PDF adjunto) a todos los participantes, notificación de rechazo al creador, y aviso de cancelación pendiente a los firmantes.

---

## 2. Modelo de datos

### 2.1 Entidades

> ⚠️ Esta sección describía el modelo previo a la migración de arquitectura `ENTIDAD_RELACIÓN_V2` (documentada en la sección 7, entrada "migración de modelo completa"). Esa migración ya se ejecutó y quedó narrada en el changelog, pero nunca se retroalimentó aquí — la tabla de abajo es la reescritura, auditada línea por línea contra `src/**/*.entity.ts` (25 archivos) en esta ronda.

| Entidad | Tabla / colección | Campos principales |
|---|---|---|
| `UserEntity` | `users` (Postgres) | id, firstName, lastName, email (único), roles (simple-array, ver nota abajo), isActive, isDeleted, `isConfigured` (onboarding, se pone en `true` solo vía `PATCH /api/v1/users/me/status`), `isEmailVerified` (default `false` — pre-cuenta hasta verificar el OTP de registro), nationalId (CURP, **único**), password, `signatureId` (FK opcional), `personalInformationId` (FK obligatoria), createdAt, updatedAt. `position` **ya no existe** (migración `RemovePositionFromUsers`). |
| `PersonalInformationEntity` | `personal_information` (Postgres) | id, name, lastName, curp, rfc (nullable a nivel de columna — obligatorio en `POST /auth/register`, opcional en `POST /user`), phoneNumber (nullable), secondaryEmail (nullable) |
| `EmailVerificationCodeEntity` | `email_verification_codes` (Postgres) | id, code, isUsed, usedAt, expiredAt, userId (FK, `ON DELETE CASCADE`), createdAt — OTP de verificación de correo en el registro |
| `PasswordResetCodeEntity` | `password_reset_codes` (Postgres) | id, code, isUsed, usedAt, expiredAt, userId (FK, `ON DELETE CASCADE`), createdAt |
| `SignatureEntity` | `signatures` (Postgres) | id, signatureObjectKey (nullable), officialCardObjectKey (nullable), isActive, createdAt, updatedAt |
| `SimpleSignatureEntity` | `simple_signatures` (Postgres, módulo `signature`) | id, verificationCode (FK nullable), signatureCoordinates (jsonb, arreglo — soporta el shape legacy de un solo objeto y el shape nuevo con ratios 0–1 por página) — coordenadas de firma explícitas por colaborador |
| `FielSignatureEntity` | `fiel_signatures` (Postgres, módulo `signature`) | id, rfc, verificationCodeId (FK nullable), verificationCodeRequired — solo modelo de datos, **sin lógica de firma FIEL/PKI real conectada** (decisión de producto/legal pendiente) |
| `DocumentEntity` | `documents` (Postgres) | id, objectKey, fileName, fileType, totalPages, documentUrl, ipAddress, originalHash, signedHash, signedAt, cancelledAt, rejectedAt, isNotified, status, signatureCoordinates (jsonb, legacy — convive con las coordenadas por colaborador), createdBy (FK), `accountId` (FK, NOT NULL), `organizationId` (FK, **nullable** — clave real de aislamiento multi-tenant en contexto organización, distinta de `accountId`; ver nota en 2.2), isSequential (default `true`), expirationDate, visibilityLevel, sealKey, totalSigners, completedSignersCount, reviewedBy (reservado, sin gateo real todavía), requiresVerification, requiresApproval (flag guardado, **sin enrutamiento real a un aprobador**, ver Pendientes), indexDocument |
| `CollaboratorEntity` (reemplaza `DocumentParticipantEntity`) | `collaborators` (Postgres) | id, documentId (FK, `ON DELETE CASCADE`), `accountId` (FK **nullable**, ancla a la cuenta PERSONAL del colaborador — ya no `userId` directo, ver migración `RenameCollaboratorUserIdToAccountId`), email/firstName/lastName/rfc (invitación por datos libres, sin cuenta de plataforma todavía si `accountId` es null), signingOrder, signedAt, status (`SIGNEE_STATUS`), comments, ipAddress, geoLoc (jsonb), visibilityLevel, cancellationReason, reminderPeriodicity, simpleSignatureId/fielSignatureId (FK), `signatureSnapshotObjectKey` (copia inmutable de la firma tomada en el momento de firmar — fix del bug crítico de "firma corrupta silenciosa", ver Pendientes/Resuelto), signatureType (`SIMPLE`\|`ADVANCED`), `colaboratorType` (`SIGNER`\|`WATCHER`\|`REVIEWER` — nótese el typo "colaborator" consistente en todo el código, no es un error de este README), createdAt, updatedAt |
| `AccountEntity` (fusión de las antiguas `AccountEntity`+`AccountMemberEntity`) | `accounts` (Postgres) | **Una fila por usuario × contexto** (personal o membresía de una organización). id, userId (FK), accountType (`PERSONAL`\|`ORGANIZATION`), organizationId (FK **nullable**, NULL en cuentas PERSONAL), roleId (FK **nullable**), email/password (**copia sincronizada** de la credencial única del usuario — decisión de producto: una sola contraseña por usuario, sin selector de cuenta antes del login), isActive, status (`pending_invite`\|`active`\|`suspended`\|`removed` — distinto de `isActive`), leftAt, joinedAt, indexDocuments, position, membershipId (sin FK real, evita un ciclo con `account_subscriptions`), createdAt |
| `OrganizationEntity` (reemplaza `OrganizationDetailEntity`) | `organizations` (Postgres) | id **propio** (ya no PK compartida con `accounts`), name, isActive, address, rfc, domainAllowed, phoneNumber, indexDocuments — varias filas `Account` (una por miembro) comparten el mismo `organizationId` |
| `OrganizationInvitationEntity` | `organization_invitations` (Postgres) | id, organizationId (FK), roleId (FK), invitedBy (FK a users), email, token (**único**), status (`PENDING`\|`ACCEPTED`\|`EXPIRED`), expiresAt (7 días desde la creación), createdAt |
| `NotificationEntity` | `notifications` (Postgres) | id, collaboratorId (FK nullable, CASCADE), isNotified, actorType, documentId (FK, CASCADE), notificationChannelSource (default `EMAIL`), delivered, sentAt, createdAt — registro/auditoría de envíos reales, alimentado por `DocumentEventsConsumer` |
| `VerificationCodeEntity` | `verification_codes` (Postgres) | id, code, event, isUsed, usedAt, ipAddress, expiredAt, signerId (FK a collaborator, nullable), documentId (FK), createdAt — OTP de firma, gateado por `document.requiresVerification` |
| `DocumentTransactionEntity` | `document_transactions` (Postgres) | id, documentId (FK, CASCADE), collaboratorId (FK nullable, CASCADE), actualHash, chainHash (encadenado **por documento**), timeStamp, chipher — cadena de integridad alimentada desde `DocumentEventsConsumer.handleCollaboratorSigned` |
| `AuditChainEntity` | `audit` (Postgres, no confundir con `audits` de Mongo) | id (**integer autoincremental**, no uuid), documentId (FK nullable, `ON DELETE SET NULL` — borrar un documento `CREATED` no rompe la cadena), chipher, actualHash, chainHash (encadenamiento **global**, sobre toda la tabla, no por documento), auditType, timestamp — índice ligero en Postgres sobre la misma información, la fuente de verdad de integridad sigue siendo Mongo |
| `AuditDocument` | `audits` (Mongo) | documentId, users[], operation, chainIndex, integrityHash, cipher, chainHash — sin FK real hacia Postgres (bases distintas) |
| `RoleEntity` | `roles` (Postgres) | id, name, isSystemRole (`true` para los 2 roles seed `ADMIN`/`MEMBER`), organizationId (FK opcional — reservado para un futuro rol custom de organización), visibility (int, default 0, significado de negocio sin definir todavía) |
| `ResourceEntity` | `resources` (Postgres) | id, key (**único**, p. ej. `DOCUMENT`), description |
| `ActionEntity` | `actions` (Postgres) | id, key (**único**, p. ej. `CREATE`), description |
| `PermissionEntity` | `permissions` (Postgres) | id, resourceId (FK), actionId (FK), scope (hoy solo `ANY`) — único por (resourceId, actionId, scope) |
| `RolePermissionEntity` | `role_permissions` (Postgres) | id, roleId (FK), permissionId (FK) — tabla pivote del RBAC real, único por (roleId, permissionId) |
| `OrganizationPermissionEntity` | `organization_permissions` (Postgres) | id, organizationId (FK, CASCADE), name, isActive, createdAt — catálogo administrativo **por organización**, sin relación con el RBAC (ver sección 3, módulo `organization-permissions`) — único por (organizationId, name) |
| `AccountPermissionEntity` | `account_permissions` (Postgres) | id, accountId (FK a `accounts`, CASCADE), organizationPermissionId (FK, CASCADE) — junction table de la asignación por miembro, único por (accountId, organizationPermissionId) |
| `AccountSubscriptionEntity` | `account_subscriptions` (Postgres) | id, accountId (FK a `accounts`, único), planId, stripeCustomerId, stripeSubscriptionId, status, currentPeriodEnd, signingEnabled, createdAt, updatedAt |
| `EventEntity` | `events` (Postgres) | id, eventType, metadata (jsonb), from, createdAt — sin FKs a propósito, correlación vía `metadata` |
| `Efirma` | — | **no es una `@Entity()` real** — clase vacía (`export class Efirma {}`). El módulo `efirma` firma PDFs directo contra buffers subidos (e.firma/CSD), sin persistencia; parece una prueba de concepto aislada del resto del dominio (ver sección 3) |

**`UserEntity.roles` vs. `AccountEntity.roleId` — dos sistemas de "rol" sin relación entre sí**: el primero (`simple-array` de `UserRoles`) es un rol de plataforma legado sin conexión al RBAC; el segundo es la FK real al catálogo `roles`/`role_permissions` que gobierna la autorización real (ver sección 3). No confundirlos al leer el código.

**`AccountMemberEntity` ya no existe como archivo** — no quedó ni siquiera como código muerto, se borró por completo en la migración de fusión. El nombre sobrevive solo como nombre de servicio/controlador (`AccountMemberService`/`AccountMemberController`, ruta `/account-member`), que hoy opera sobre `AccountEntity` filtrando por `organizationId`. Las tablas legacy `document_participants`/`account_members_deprecated` mencionadas en migraciones anteriores son residuos renombrados (`_deprecated`/`_legacy`), no entidades TypeORM activas — el `DROP` real se difirió a una limpieza posterior.

### 2.2 Relaciones

- **User 1—1 Signature**: FK `signature_id` en `users`, **opcional**.
- **User 1—1 PersonalInformation**: FK `personal_information_id` en `users`, **obligatoria**.
- **User 1—N Account**: FK `user_id` en `accounts` — cada fila es una membresía de ese usuario en un contexto (antes esta relación pasaba por `AccountMemberEntity`).
- **User 1—N Document** (creador): FK `created_by`.
- **User 1—N EmailVerificationCode / PasswordResetCode**: FK `user_id`, `ON DELETE CASCADE`.
- **Account N—1 Organization**: FK `organization_id` en `accounts`, **nullable** (NULL en cuentas PERSONAL), `ON DELETE CASCADE`.
- **Account N—1 Role**: FK `role_id`, nullable, sin `onDelete` (borrar un rol en uso no borra en cascada las membresías que lo tienen asignado).
- **Account 1—1 AccountSubscription**: FK `account_id`, único, `ON DELETE CASCADE`.
- **Document N—1 Account**: FK `account_id`, NOT NULL — cuenta activa al crear el documento.
- **Document N—1 Organization**: FK `organization_id`, **nullable** — ver nota de aislamiento multi-tenant abajo.
- **Document 1—N Collaborator**: FK `document_id`, `ON DELETE CASCADE`.
- **Collaborator N—1 Account** (nullable): FK `account_id`, ancla a la cuenta PERSONAL del colaborador (resuelta vía `AccountMemberService.findPersonalAccountId`), no a una membresía de organización específica.
- **Collaborator N—1 SimpleSignature / N—1 FielSignature**: ambas nullable.
- **DocumentTransaction / Notification / VerificationCode N—1 Document** (CASCADE) **/ N—1 Collaborator** (nullable, CASCADE).
- **AuditChain N—1 Document**: FK `document_id`, nullable, **`ON DELETE SET NULL`** a propósito.
- **OrganizationInvitation N—1 Organization** (CASCADE) **/ N—1 Role / N—1 User** (`invited_by`).
- **Role N—1 Organization** (roles custom, hoy sin uso real): FK `organization_id`, CASCADE.
- **Resource 1—N Permission** / **Action 1—N Permission**: CASCADE.
- **Role 1—N RolePermission** / **Permission 1—N RolePermission**: CASCADE.
- **OrganizationPermission N—1 Organization**: CASCADE.
- **AccountPermission N—1 Account / N—1 OrganizationPermission**: CASCADE — junction table deliberadamente separada de `role_permissions` (el módulo de permisos administrativos duplica su propio chequeo RBAC en vez de acoplarse a `AccountService`/`AccountMemberService`, ver sección 3).

**Cambio conceptual que no existía antes de ER-V2: ya no hay "una cuenta = un tenant único"**. Hoy hay dos claves de aislamiento distintas según el contexto: `AccountEntity.id` (única por usuario, sirve para contexto personal) y `OrganizationEntity.id`/`Document.organizationId` (agrupa a **todos** los miembros de una organización, porque una organización tiene N filas `Account`, una por miembro). Al leer o escribir lógica de aislamiento multi-tenant, hay que decidir cuál de las dos claves aplica según si el contexto es personal o de organización.

> El esquema ya **no** se sincroniza automáticamente (`synchronize: false`). Hay un sistema de migraciones formal de TypeORM en `src/migrations/` (30 archivos) — ver sección 6 para los comandos y el flujo para aplicar cambios de entidad.

---

## 3. Módulos, endpoints y funciones

### `document` (`/document`)

| Endpoint | Método de servicio | Qué hace |
|---|---|---|
| `POST /document` | `create()` | Sube el PDF, crea documento + participantes. **Requiere el header `X-Account-Id`** (cuenta activa); el documento queda scopeado a esa cuenta (`DocumentEntity.accountId`) |
| `GET /document` | `findWithFilters()` | Listado paginado con filtros (id, email, participante, estado, fechas, "mi turno"). **Requiere `X-Account-Id`**: el listado se restringe a los documentos de esa cuenta, sin importar los demás filtros. Cada fila incluye `creator` y `creatorRfc` (el RFC sale de `personal_information` vía `leftJoinAndSelect` sobre `requester`, no de `users`; `null` si el creador aún no lo registró) y `signatureType` (`simple`/`fiel`, para la columna "Tipo de firma" del frontend — se resuelve a partir de los SIGNER del documento, que ya vienen en el mismo query, y es `null` si no todos coinciden o si ninguno lo tiene registrado, como en los documentos del endpoint antiguo) |
| `GET /document/:id` | `findDetailForUser()` | Detalle + permisos del usuario (`canSign`/`canReject`). **Todavía no scopeado por cuenta** (ver Pendientes) |
| `GET /document/file/:id` | `getDocumentMinioURL()` | URL prefirmada según estado |
| `GET /document/public/:id` | `getPublicDocument()` | **`@SkipJwtAuth()`** — vista pública de verificación, sin autenticación. El contenido depende de `isCompleted`: pendiente ⇒ solo nombre del documento y nombres de los firmantes; completado ⇒ además hash, páginas, creador, constancia NOM-151, la evidencia de cada firma **según su tipo** y `secureUrl`. Consumido por `signature-app` en `/public/documents/:id` |
| `GET /document/public/:id/seal/:artifact` | `getPublicSealArtifact()` | **Nuevo, `@SkipJwtAuth()`** — descarga un artefacto de la constancia ya persistida en `document_seals`: `nom151` (PDF), `timestamp` (token RFC 3161) o `canonical` (cadena canónica en texto plano). Nunca vuelve a llamar al PSC. 404 si el documento no está firmado, no tiene sello, o ese artefacto no vino del proveedor |
| `PATCH /document/:id/submit-for-authorization` | `submitForAuthorization()` | `CREATED → PENDING`, notifica al primer firmante |
| `PATCH /document/:id/sign` | `sign()` | Firma en turno; finaliza el documento si es el último firmante |
| `PATCH /document/:id/link-collaborator` | `linkCollaborator()` | **Nuevo** — vincula al usuario autenticado como colaborador si fue invitado solo por email (sin cuenta todavía); consumido por `/access-document` en el frontend |
| `POST /document/:id/verification-codes` | `requestVerificationCode()` | **Nuevo** — emite un OTP de firma cuando el documento tiene `requiresVerification = true` |
| `POST /document/:id/verification-codes/verify` | `verifyCode()` | **Nuevo** — valida el OTP anterior antes de habilitar `sign()` |
| `PATCH /document/:id/reject` | `reject()` | Rechaza con motivo, marca de agua, notifica al creador |
| `PATCH /document/:id/submit-for-cancellation` | `requestCancellation()` | `SIGNED → CANCELLATION_PENDING` (solo el creador) |
| `PATCH /document/:id/confirm-cancellation` | `confirmCancellation()` | `CANCELLATION_PENDING → CANCELLED` (cualquier firmante), marca de agua + notificación |
| `PATCH /document/:id` | `update()` | Reemplaza archivo/coordenadas (solo `CREATED`) |
| `DELETE /document/:id` | `remove()` | Borra archivo + registro (solo `CREATED`) |

**Multi-tenancy (`X-Account-Id`)**: `create()`/`findWithFilters()` reciben el header y llaman `AccountMemberService.assertIsActiveMember(userId, accountId)` (`ForbiddenException` si el usuario no es miembro activo de esa cuenta) **antes** de usarlo para nada — el header lo manda el cliente, así que confiar en él sin validar contra la membresía real habría sido un hueco de aislamiento por tenant, no una solución. Si falta el header, `BadRequestException`. `DocumentEntity.accountId` (migración `AddAccountIdToDocuments`, con backfill a la cuenta PERSONAL del creador para los documentos ya existentes) es la columna que hace posible el filtro. El resto de los endpoints del módulo (`GET /document/:id`, `sign`/`reject`/cancelación/`update`/`remove`) siguen sin este scoping — ver Pendientes.

### `document-signatures` (`POST /api/v1/documents/signatures`) — endpoint de creación alternativo, coexiste con `POST /document`

`DocumentSignaturesController`/`DocumentSignaturesService` (`src/document/`): recibe multipart (archivo + `documentData` + `collaborators`, cada uno `SIGNER`/`VIEWER` con datos libres, sin `userId`), sube el PDF él mismo, y orquesta en una sola transacción (`DataSource.transaction`) Document → Collaborator (uno por colaborador) → Notification (`isNotified: false`) → `verification_code` (si el colaborador es SIGNER y aplica verificación). Los eventos Kafka (`notification.created`, uno por notificación, vía `NotificationEventsProducer`) se publican **fuera** de la transacción, después de que resuelve — si algo falla adentro, el rollback ya ocurrió antes de llegar al publish. Es el endpoint que consume hoy `signature-app` desde `/dashboard/documents/create` (ver su README) — `POST /document` sigue existiendo y expuesto, pero con un contrato distinto (JSON con `objectKey` ya subido, no multipart).

### `signature` (`/signature`) — credencial de firma del usuario

| Endpoint | Servicio |
|---|---|
| `GET /signature/files/:fileId` | `getFile()` — URL prefirmada |
| `GET /signature/:id` | `findOne()` |
| `PATCH /signature/:id` | `update()` — reemplaza imagen de firma y/o INE |
| `PATCH /signature/:id/deactivate` | `deactivate()` — sustituye la firma por PNG en blanco |
| `DELETE /signature/:id/signature-image` | `deleteSignatureImage()` |
| `DELETE /signature/:id/official-file` | `deleteOfficialFile()` |

Ownership de cada operación se valida contra `User.signatureId` (dueño real de la relación), no contra una FK en `Signature`.

> `POST /signature` (creación inicial) ya no está expuesto aquí — `SignatureService.create()` ahora solo se llama desde `PUT /api/v1/users/me/signature` (onboarding, JWT). El resto de operaciones (`update`/`deactivate`/`delete*`) siguen bajo `/signature` sin cambios.

### `user` (`/user`) — CRUD administrativo (API key)

| Endpoint | Servicio |
|---|---|
| `POST /user` | `create()` — crea usuario + `PersonalInformation` vinculada |
| `GET /user` | `findAllActiveUsers()` |
| `GET /user/:id` | `findOneActiveUser()` |
| `PATCH /user/:id` | `update()` |
| `DELETE /user/:id` | `remove()` — soft delete |

> `PATCH /user/personal-information` y `PATCH /user/me/status` ya **no** existen aquí — se movieron a `api/v1/users` (JWT, ver abajo) como parte del flujo de onboarding.

### `users` (`/api/v1/users`) — perfil y onboarding del usuario autenticado (JWT)

| Endpoint | Servicio | Qué hace |
|---|---|---|
| `GET /api/v1/users/me` | `UserService.getMeFromCache()` | Lee **exclusivamente Redis DB 0** por CURP (key = `nationalId`) el snapshot unificado User+PersonalInformation, para hidratar rápido el store de onboarding en el cliente. Si la key no existe (p. ej. un fallo previo de Redis), reconstruye una única vez desde Postgres y recachea. |
| `PUT /api/v1/users/me/personal-information` | `UserService.updatePersonalInformation()` | Actualiza `phoneNumber`/`secondaryEmail` en Postgres. El userId sale del JWT, nunca de params/body. **No refresca el cache de Redis por CURP** (ver Pendientes). |
| `PUT /api/v1/users/me/signature` | `SignatureService.create()` | Sube la firma PNG (+ INE opcional) y vincula `signatureId` al usuario — mismo servicio que usaba `POST /signature`, ya no expuesto ahí (ver módulo `signature`). Tampoco refresca el cache de Redis por CURP. |
| `PATCH /api/v1/users/me/status` | `UserService.updateStatus()` | Consolidación final del onboarding: fija `isConfigured = true` de forma atómica y **sí** refresca el cache de Redis por CURP. El body (`{ isConfigured: true }`) se ignora — es un disparador de un solo sentido, no un toggle. |

El JWT ahora incluye `nationalId` (CURP) como claim estable (ver sección 4) para que `GET /me` pueda resolver directo por Redis sin una consulta previa a Postgres.

### `account` (`/account`) — CRUD genérico de cuentas (JWT)

`AccountService`: `create()`, `findAll()`, `findOne()`, `update()` (maneja `OrganizationEntity` cuando `accountType = ORGANIZATION`). `findOne()` exige `ORGANIZATION:READ` y `update()` exige `ORGANIZATION:UPDATE` vía RBAC granular real (`assertHasOrganizationPermission` → `RolesService.assertHasPermission`, consulta `role_permissions` — ya no una comparación de `role.name === 'ADMIN'` a mano, ver la entrada "RBAC granular" en la sección 7). `create()`/`findAll()` solo exigen JWT válido — no hay un `accountId` concreto contra el cual validar ownership (`findAll()` en particular sigue devolviendo el listado completo de cuentas de **todos** los usuarios a cualquier autenticado; ver Pendientes). Ninguno de los 4 se usa desde `signature-app` hoy — la creación real de cuentas pasa por `POST /auth/register` (personal) y `POST /api/v1/organizations` (organización).

### `organizations` (`/api/v1/organizations`, JWT) — mucho más grande que solo "crear e invitar"

`AccountService.createOrganization(userId, dto)`: transacción ACID que crea `Organization` + `Account(accountType=ORGANIZATION)` con `roleId` apuntando al rol de sistema ADMIN para el creador (queda como administrador de inmediato, igual que en la cuenta personal). Al confirmar, refresca el catálogo cacheado en Redis (`appendAccountToCatalog`) para el usuario creador.

**`POST /api/v1/organizations/invite`** (`AccountService.inviteMember` + `OrganizationInvitationService.create`, orquestados desde el controller a propósito para no crear una dependencia circular) — **ya no es solo validación**: recibe `{email, roleId}`, exige el header `X-Account-Id`, valida ADMIN (`ORGANIZATION:CREATE`) sobre la cuenta activa, que sea de tipo `ORGANIZATION`, y que el `roleId` exista. Si todo pasa, **persiste** una fila `OrganizationInvitationEntity` (`PENDING`, token único, expira en 7 días) y publica `organization.member.invited` en Kafka — `OrganizationInvitationEventsConsumer` (ver Kafka más abajo) despacha el correo real de forma asíncrona. Ver módulo `organization-invitations` para el flujo de aceptación.

**`GET /:organizationId/members`** (`AccountMemberService.findMembersForOrganizationDetailed`): shape delgado (`accountId`, `userId`, `email`, `rfc`, `role: {id,name} | null`, `joinedAt`), solo miembros activos, exige `ORGANIZATION:READ`.

**`PATCH /members/:accountId/role`** / **`DELETE /members/:accountId`**: alias sobre `AccountMemberService.update()`/`remove()` (mismos checks RBAC `ORGANIZATION:UPDATE`/`DELETE`) — protegidos por `assertNotLastAdmin`: si el objetivo es el único ADMIN activo de la organización, ambas operaciones responden `409 Conflict` (no hay rol `OWNER` separado de `ADMIN`, así que "no dejar la organización sin dueño" se implementa como "no dejar la organización sin ADMIN").

**`GET/PATCH /members/:accountId/permissions`**: montadas aquí pero pertenecen al módulo de permisos administrativos — ver `organization-permissions` más abajo.

### `organization-invitations` (`/api/v1/organizations/invitations`, público) — aceptar una invitación

Rutas `@SkipJwtAuth()` (el invitado puede no tener sesión): **`GET /:token`** (preview — nombre de la organización, para el mensaje de `/join` en el frontend; expiración perezosa, se marca `EXPIRED` en el primer acceso posterior a `expiresAt`, sin job programado) y **`POST /:token/accept`** (`{rfc}`, resuelve al usuario por RFC — el correo es solo el canal de entrega, no el criterio de aceptación). El registro (`POST /auth/register`) acepta un `invitationToken` opcional para el camino de "RFC nuevo": crea la cuenta y se une a la organización automáticamente (best-effort, un fallo no tumba un registro que por lo demás fue exitoso).

### `accounts` (`GET /api/v1/accounts/me`, JWT) — catálogo de cuentas del usuario autenticado

`AccountService.getAccountsCatalog(userId)`: lee **exclusivamente** el catálogo cacheado en Redis DB 0 (key `accounts:{userId}`), sin fallback a Postgres. Si la key no existe, retorna un catálogo vacío (no hay self-heal como en `users/me`, porque el catálogo se puebla siempre al registrarse/crear una organización).

### `account-member` (`/account-member`) — membresías (JWT, RBAC)

`AccountMemberService`: `create()` (otorgar acceso con un `roleId` del catálogo RBAC, exige `ORGANIZATION:CREATE`), `findByAccount()`/`findOne()` (`ORGANIZATION:READ`), `update()` (cambia rol/puesto/vigencia, `ORGANIZATION:UPDATE`), `remove()` (revocación = soft delete `isActive=false`, `ORGANIZATION:DELETE`) — todos vía `assertHasOrganizationPermission`, no una comparación de nombre de rol. Para `findOne()`/`update()`/`remove()`, que reciben el id de la membresía, primero se resuelve para obtener su `organizationId` y luego se valida contra ese id. `create()`/`update()` además validan que el `roleId` recibido exista de verdad antes de asignarlo. Internamente opera sobre `AccountEntity` filtrado por `organizationId` — no existe `AccountMemberEntity` como archivo (ver sección 2.1).

También expone `assertIsActiveMember(userId, accountId)` (público, sin controlador propio): check de tenant más laxo — cualquier miembro **activo** basta, sin importar su rol — usado por `document` para validar `X-Account-Id`.

### `organization-permissions` (`/api/v1/organizations/:organizationId/permissions`) — catálogo administrativo, **no RBAC**

Módulo completo sin ninguna documentación previa. `GET /` (lista), `POST /` (crea, nombre único por organización), `PATCH /:permissionId` (nombre y/o `isActive`), `DELETE /:permissionId` — más las dos rutas montadas en `organizations` de arriba para leer/reemplazar la asignación por miembro (`PATCH` hace `DELETE`+`INSERT` transaccional completo, nunca deja una lista parcial a medio camino).

**Es deliberadamente un sistema paralelo al RBAC**, no una extensión — `OrganizationPermissionEntity`/`AccountPermissionEntity` son solo un catálogo de **nombres libres** que el ADMIN de cada organización define (p. ej. "puede aprobar gastos", "puede firmar en nombre de la empresa"). No le dan a nadie ningún permiso técnico real sobre ningún otro endpoint del sistema — es metadata de negocio, no control de acceso. El único punto de contacto con el RBAC real es que **gestionar el catálogo** exige ser ADMIN (`assertHasOrganizationPermission`, la misma consulta a `role_permissions` que usan `AccountService`/`AccountMemberService`, duplicada a propósito en vez de compartida — cada servicio resuelve la membresía del llamador de forma distinta, y compartir el helper habría creado un acoplamiento cruzado innecesario).

### `roles` (`GET /api/v1/roles`, JWT) — catálogo RBAC (Role/Resource/Action/Permission/RolePermission)

`AccountEntity.roleId` (antes `AccountMemberEntity.roleId`, previo a la fusión — migración `ReplaceAccountMemberRoleWithRoleId` — ver Pendientes/Resuelto) es una FK real a este catálogo — ya no son dos sistemas paralelos. Centraliza las 5 entidades de control de acceso: `RoleEntity`, `ResourceEntity`, `ActionEntity`, `PermissionEntity`, `RolePermissionEntity` (tabla pivote).

`RolesService.findAllSystemRoles()`: `roleRepository.find({ where: { isSystemRole: true } })`, ordenado por `name`. `RolesController` expone `GET /api/v1/roles` (JWT, sin check de ownership — es un catálogo de solo lectura, no datos de una cuenta concreta) devolviendo `{id, name, isSystemRole}` por rol; pensado para poblar el modal de invitar miembros en el frontend. También expone (sin controlador propio) `findSystemRoleByName(name)` — usado por `AccountService` al asignar el rol ADMIN por defecto a una membresía nueva — y `findByIdOrFail(id)` — usado por `AccountMemberService` para validar el `roleId` recibido en `create()`/`update()`.

**Seed** (`npm run seed:roles`, `src/scripts/seed-roles.ts`, mismo patrón standalone que `seed:documents`): puebla `ADMIN`/`MEMBER` (`isSystemRole: true`, `organizationId: null`), los 3 `resources` (`DOCUMENT`/`ORGANIZATION`/`USER`), las 4 `actions` (`CREATE`/`READ`/`UPDATE`/`DELETE`), y `role_permissions`: `ADMIN` con las 12 combinaciones resource×action (`scope: ANY`), `MEMBER` solo con `READ`+`CREATE` sobre `DOCUMENT`. Idempotente: cada tabla se busca por su clave natural antes de insertar (`key`/`name`, o el par de FKs en las pivote), así que correrlo varias veces no duplica filas — verificado corriéndolo dos veces seguidas contra Postgres local (mismos conteos: 2/3/4/12/14).

### `auth` (`/auth`) — mucho más grande que solo login/registro

| Endpoint | Servicio |
|---|---|
| `POST /auth/register` | `register()` — primero verifica el token de **Cloudflare Turnstile** (`turnstileToken`, obligatorio en el body) contra Siteverify; solo si pasa llama a `UserService.createFromSignup()`, que crea una **pre-cuenta** (`isEmailVerified: false`) y envía OTP. No autentica todavía |
| `POST /auth/verify-otp` | Confirma el OTP de registro (`EmailVerificationCodeEntity`), marca `isEmailVerified = true` y autentica de inmediato (auto-login) |
| `POST /auth/resend-otp` | Reenvía el OTP de verificación de registro |
| `POST /auth/forgot-password` | Inicia recuperación de contraseña, envía OTP (`PasswordResetCodeEntity`) |
| `POST /auth/verify-reset-code` | Valida el OTP de recuperación |
| `POST /auth/reset-password` | Fija la contraseña nueva tras un OTP válido |
| `POST /auth/login` | `login()` — valida password (bcrypt) contra `Account.email`/`.password`, rechaza con `403` si `!user.isEmailVerified`, firma JWT con `jti` único |
| `POST /auth/logout` | `logout()` — agrega el `jti` a la blacklist de Redis |
| `GET /auth/me` | `me()` — perfil completo desde Postgres (joins + URLs prefirmadas de MinIO para firma/INE); lo consume `/dashboard/personal-documents` en el frontend. **No** es el mismo endpoint que `GET /api/v1/users/me` (ese lee solo Redis, sin URLs firmadas, pensado para hidratar rápido el onboarding). |

Todos los endpoints públicos de este módulo tienen `ThrottlerGuard` explícito (5 intentos/60s) — no solo `register`/`login` como documentaba antes este README.

**CAPTCHA en el registro (Cloudflare Turnstile).** `POST /auth/register` exige además `turnstileToken`: el token de un solo uso que genera el widget en `/signup`. `TurnstileService` (ver `shared/*`) lo canjea contra la API Siteverify de Cloudflare **antes** de cualquier escritura, así que un token ausente, inválido, expirado o ya usado devuelve `400` sin crear ni actualizar el pre-registro y sin enviar OTP. El throttler no sustituía esto: limita la frecuencia, no distingue a una persona de un script.

Falla cerrado: si `TURNSTILE_SECRET_KEY` no está configurada, o Siteverify no responde, el registro se rechaza con `503` en vez de dejarse pasar. Para desarrollo, Cloudflare publica claves de prueba que siempre aprueban (están puestas en `.env.example`).

### `users` (`/api/v1/users`) — un endpoint público adicional

Además de los 4 ya documentados arriba: **`GET /api/v1/users/check-rfc?rfc=`** (`@SkipJwtAuth()`) — `UserService.checkRfcAvailability()`, usado por `/join` y `/signup` en el frontend para bifurcar el flujo según si ese RFC ya tiene cuenta.

### `efirma` (`POST /efirma/sign`) — prueba de concepto aislada, sin persistencia

`@SkipJwtAuth()` en todo el controlador (**sin autenticación de ningún tipo**). Recibe multipart (`cerBuffer`, `keyBuffer`, `documento`) y firma directo contra los buffers con e.firma/CSD mexicana, sin guardar nada — `Efirma` no es siquiera una `@Entity()` TypeORM real (ver sección 2.1). No usa `CollaboratorEntity`/`FielSignatureEntity` para nada; no está conectado al flujo de firma de documentos del resto del sistema.

### `audit` (`/audit`)

`GET /audit/document/:documentId`, `GET /audit/decrypted`, `GET /audit` (paginado). `AuditService.create()` es interno, invocado desde `DocumentService`.

### `payments` (`/api/v1/payments`, JWT)

> Esta sección decía `StripeCheckoutController` con `GET /stripe/plans`, `POST /stripe/checkout/session`
> y `GET /stripe/subscription`. **Esas rutas ya no existen**: el módulo `stripe` pasó a llamarse
> `payments`, Stripe quedó como un proveedor dentro de él y la orquestación bajó a casos de uso.
> Se corrige aquí porque la documentación desactualizada fue parte de lo que hizo difícil ubicar
> el fallo de "no cargan los planes": quien venía a buscar el endpoint no lo encontraba.

| Endpoint | Caso de uso | Qué hace |
|---|---|---|
| `GET /api/v1/payments/services` | `GetPaymentServicesUseCase` | Catálogo de servicios comprables, leído **en vivo** de los precios activos de Stripe (`expand: product`). No hay price_id en el `.env` ni tabla local: dar de alta un servicio se hace en el panel del proveedor. **No abre sesiones de pago** — ver la nota del caso de uso. |
| `POST /api/v1/payments/checkout-sessions` | `CreateStripeCheckoutSessionUseCase` | Valida el `priceId` contra el catálogo activo (sin eso, cualquiera podría mandar un precio archivado o ajeno), resuelve la cuenta y su cliente de Stripe, y devuelve la URL hospedada de Checkout. |
| `GET /api/v1/payments/subscription` | `GetSubscriptionStateUseCase` | Estado de la suscripción de la cuenta. |

`StripeWebhookController` (`POST /stripe/webhook`, verificado por firma) sincroniza
`AccountSubscriptionEntity` según `checkout.session.completed`, `invoice.paid` y
`customer.subscription.deleted`. El único archivo que conoce el SDK es
`StripePaymentGatewayService`.

**Cómo falla, y cómo distinguirlo** (ver `translateError` en el gateway): un fallo de Stripe ya no
se reporta siempre igual, porque no siempre significa lo mismo.

| Situación | Respuesta | Qué hay que hacer |
|---|---|---|
| Falta `STRIPE_SECRET_KEY` | La aplicación **no arranca** | El error nombra la variable. El SDK ya fallaba solo, pero con "Neither apiKey nor config.authenticator provided", que no dice cuál falta. |
| Llave inválida, revocada, de otra cuenta, o restringida sin permiso (401/403) | **500** `PaymentGatewayMisconfiguredException` | Revisar la llave del entorno. Reintentar no sirve: es configuración nuestra, no una caída del proveedor. |
| Stripe no responde o rompe su contrato | **502** `PaymentGatewayUnavailableException` | Esperar y reintentar. |
| La cuenta no tiene productos/precios activos | **200 con lista vacía** | Se registra un `warn` explícito: es el único caso en que la pantalla se queda sin tarjetas sin que nada falle. |

Al arrancar, el módulo registra en qué modo quedó configurado (`test`/`live`) y si la llave es
restringida — nunca la llave. Es la línea que permite descartar de un vistazo "el entorno apunta a
la cuenta equivocada", que desde fuera se ve idéntico a un error del proveedor.

### `health`, `ip`, `kafka`

- `GET /health` — combina pings de Postgres, Mongo y Redis. `@SkipJwtAuth()` (sin JWT ni x-api-key): lo consumen probes de infraestructura.
- `IpInterceptor` (global) — extrae la IP real del cliente e inyecta `request.clientIp`.
- **`KafkaModule`** — 3 productores, no 1:
  - **`DocumentEventsProducer`** → `DOCUMENT_KAFKA_TOPICS`, **7 tópicos, no 5**: `document.created`, `document.sent_to_sign`, `document.collaborator_signed` (se dispara por cada colaborador que firma, distinto de `.signed` que solo dispara al terminar el último), `document.signed`, `document.rejected`, `document.cancellation_requested`, `document.cancelled`.
  - **`NotificationEventsProducer`** → `notification.created` (uno por `Notification` creada desde `document-signatures`).
  - **`OrganizationInvitationEventsProducer`** → `organization.member.invited`.
  - **3 consumidores** (`src/kafka/*.controller.ts`), no 1: **`DocumentEventsConsumer`** ya no solo loggea — persiste `NotificationEntity`, encadena `DocumentTransactionEntity` en `document.collaborator_signed`, y alimenta el ledger global (`AuditChainEntity`) en cada evento. **`NotificationEventsConsumer`** consume `notification.created`, resuelve a quién le toca notificar (orden secuencial, tipo de firma) y despacha el correo real. **`OrganizationInvitationEventsConsumer`** consume `organization.member.invited`, arma el link `/join` y despacha el correo de invitación.

### `shared/*`

`MinioService` (almacenamiento), `HashService` (hashing + cifrado), `PdfSignatureService` (manipulación de PDF), `EmailService` (SendGrid), `OTPService`, `RedisService` (blacklist de JWT), `PasswordService` (bcrypt), `TurnstileService` (verificación del CAPTCHA de registro contra Cloudflare Siteverify). El flujo de OTP de registro/recuperación de contraseña (`auth`, arriba) ya está integrado end-to-end vía `EmailVerificationCodeService`/`PasswordResetCodeService` — confirmar si reutilizan `OTPService` internamente o son una implementación paralela antes de asumir cuál es la fuente de verdad del código de generación/expiración.

---

### Documentación Swagger: decoradores por endpoint (`docs/`)

Los controladores **no llevan decoradores `@Api*` de Swagger en sus métodos**. La documentación de
cada endpoint vive en un decorador compuesto con `applyDecorators()`, en la carpeta `docs/` de su
módulo:

```
src/document/
  docs/
    api-sign-document.docs.ts
    api-reject-document.docs.ts
    ...
  document.controller.ts
```

```ts
@Patch(':id/sign')
@ApiSignDocument()
sign(...) { ... }
```

**Qué va en el decorador y qué se queda en el controlador.** Al decorador se mueve *solo* lo que
describe (`ApiOperation`, `ApiResponse`, `ApiParam`, `ApiQuery`, `ApiBody`, `ApiConsumes`,
`ApiHeader`, `ApiSecurity`, `ApiExcludeEndpoint`). En el controlador se queda todo lo que *hace*:
la ruta, `@Public()`/`@SkipJwtAuth()`, guards, `@UseInterceptors` (incluidos los de multipart, que
son quienes de verdad procesan el archivo) y la delegación al servicio. `ApiSecurity` y
`ApiConsumes` son la pareja engañosa: solo documentan — quien abre la ruta a la API key es
`@Public()`, y quien procesa el multipart es el `FileInterceptor`.

`@ApiTags` y `@ApiBearerAuth` a nivel de CLASE se quedan en el controlador: no pertenecen a ningún
endpoint. La convención no tiene excepciones: incluso los endpoints que se ocultan del Swagger
publicado tienen su decorador (`ApiGetDocumentFileUrl`, `ApiGetSignatureFile`, `ApiGetHello`), para
que el motivo de la exclusión quede escrito y todos los endpoints se lean igual.

**Cómo verificar que no se perdió nada.** Al mover decoradores, leer el diff no alcanza: lo que
importa es que la especificación generada no cambie. La forma de comprobarlo es volcarla a un JSON
antes y después y comparar. Un script de una sola función basta:

```ts
const app = await NestFactory.create(AppModule, { preview: true, logger: false });
const document = SwaggerModule.createDocument(app, config); // el mismo DocumentBuilder de main.ts
writeFileSync(salida, JSON.stringify(document, null, 2));
```

Dos detalles que lo hacen práctico: el modo `preview` resuelve el grafo de módulos **sin instanciar
un solo provider**, así que no abre conexiones a Postgres/Mongo/Redis/MinIO/Kafka y corre sin
infraestructura levantada; y conviene NO pasar `include` —a diferencia de `main.ts`, que publica
solo cuatro módulos— para cubrir todos los controladores del proyecto.

Así se comprobó la extracción de los 74 decoradores en los 23 controladores: `diff` vacío, 58 rutas
y 72 operaciones idénticas byte a byte.

## 4. Autenticación

Dos guards globales combinados con AND (`APP_GUARD` en `AuthModule`):

- **`ApiKeyGuard`** — solo exige `x-api-key` en endpoints marcados `@Public()`.
- **`JwtAuthGuard`** — exige `Authorization: Bearer <jwt>` válido y no presente en la blacklist de Redis, salvo `@Public()` o `@SkipJwtAuth()` — hoy usado en bastante más que `register`/`login`: todo el flujo de OTP (`verify-otp`/`resend-otp`/`forgot-password`/`verify-reset-code`/`reset-password`), `check-rfc`, las rutas de `organization-invitations`, `GET /document/public/:id` y todo el controlador `efirma`.

`@CurrentUser()` expone el payload del JWT (`sub`, `email`, `roles`, `nationalId`, `jti`) inyectado por el guard en `request.user`. `nationalId` (CURP) se agregó como claim estable — no es un dato volátil de onboarding (eso vive en Redis, no en el JWT), es la misma clase de identificador que `email`/`roles`, y permite que `GET /api/v1/users/me` resuelva directo por Redis sin una consulta previa a Postgres.

---

## 5. Stack técnico

| Componente | Uso |
|---|---|
| PostgreSQL (TypeORM) | Todo el dominio transaccional: usuarios, información personal, credenciales de firma, documentos, colaboradores, cuentas/organizaciones (fusionadas, ver 2.1), suscripciones, RBAC, permisos administrativos de organización, OTP de registro/recuperación de contraseña, y un índice ligero de auditoría (`AuditChainEntity`, `audit`) |
| MongoDB (Mongoose) | El módulo `audit` (colección `audits`) — cadena de hashes de integridad, append-only; sigue siendo la fuente de verdad, `AuditChainEntity` en Postgres es solo un índice joinable |
| Redis (ioredis) | Blacklist de JWT invalidados por logout; también el cache de onboarding por CURP y el catálogo de cuentas (ver sección 3) |
| Kafka (KRaft) | 3 productores (`DocumentEventsProducer` con 7 tópicos del ciclo de vida del documento, `NotificationEventsProducer`, `OrganizationInvitationEventsProducer`) y 3 consumidores reales — ver sección 3, `kafka` |
| MinIO | Almacenamiento de archivos (documentos, firmas, INEs), siempre vía URL prefirmada |
| Stripe | Suscripciones por cuenta, 3 planes (`basic`/`pro`/`enterprise`), Checkout Sessions + webhook verificado |
| SendGrid | Notificaciones transaccionales por correo |
| pdf-lib / sharp | Manipulación y conformidad PDF/A de documentos / generación de PNG en blanco |

### Variables de entorno relevantes

`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `POSTGRES_DB_URL`, `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`, `FRONTEND_URL`, `MONGO_USERNAME`, `MONGO_PASSWORD`, `MONGO_DB_NAME`, `MONGO_DB_URL`, `MINIO_HOST`, `MINIO_PORT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `MINIO_*_BUCKET` (una por bucket), `CIPHER_SECRET`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `KAFKA_BROKER`, `KAFKA_CLIENT_ID`, `KAFKA_CONSUMER_GROUP_ID`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_BASIC`, `STRIPE_PRICE_ID_PRO`, `STRIPE_PRICE_ID_ENTERPRISE`, `API_KEY`, `TURNSTILE_SECRET_KEY` (clave privada de Cloudflare Turnstile — solo acá, nunca en el frontend; su pareja pública `TURNSTILE_SITE_KEY` vive en el `.env` de `signature-app`).

## 6. Levantar el proyecto

```bash
docker compose up -d      # Postgres, MongoDB, Redis, Kafka, Kafka UI, MinIO
npm install
npm run start:dev         # aplica las migraciones pendientes automáticamente (migrationsRun: true) y levanta con --watch
```

Swagger disponible en `/api/docs` una vez levantado.

### Migraciones (TypeORM)

El esquema ya no se gestiona con `synchronize: true`. `src/data-source.ts` es el `DataSource` que usa la CLI (independiente del `TypeOrmModule.forRootAsync` de `app.module.ts`, que sigue siendo lo que usa la app en tiempo de ejecución).

```bash
npm run migration:generate -- src/migrations/NombreDescriptivo   # genera una migración a partir del diff entidades vs. DB
npm run migration:create -- src/migrations/NombreDescriptivo     # crea una migración vacía (up/down manuales)
npm run migration:run                                            # aplica las migraciones pendientes
npm run migration:revert                                         # revierte la última migración aplicada
```

`migrationsRun: true` en `app.module.ts` significa que `npm run start:dev`/`start:prod` aplican automáticamente cualquier migración pendiente al arrancar — no hace falta correr `migration:run` a mano en el flujo normal, solo al generar una migración nueva para probarla antes de commitear.

**30 migraciones en `src/migrations/` (esta auditoría)**. Las 8 más recientes no tenían ninguna mención en este README hasta esta ronda: `CreateAuditChain` (ledger global en Postgres), `RemovePositionFromUsers` (columna eliminada de `users`), `DecoupleLegacyAccountsTypeEnum`, `ArraySignatureCoordinates` (shape nuevo de coordenadas con ratios 0–1), `AddIsEmailVerifiedToUsers` + `CreateEmailVerificationCodes` (OTP de verificación de registro), `CreatePasswordResetCodes` (recuperación de contraseña), `CreateOrganizationPermissions` (catálogo administrativo de permisos, sección 3).

### Seed en Docker (post-build)

`npm run seed:roles`/`seed:documents` (ver sección 3) usan `ts-node` sobre `src/*.ts` — no sirven dentro de la imagen de producción, que solo tiene `dist/` compilado y `node_modules --omit=dev` (sin `ts-node`, ver `Dockerfile`). Para esos casos existen `seed:roles:prod`/`seed:documents:prod`, que corren el `.js` ya compilado directo con `node`:

```bash
docker compose up -d              # o el compose real del entorno (staging/prod)
docker exec <nombre-o-id-del-contenedor-api> npm run seed:roles:prod
docker exec <nombre-o-id-del-contenedor-api> npm run seed:documents:prod   # requiere el usuario fixture PRIMARY_TEST_EMAIL, ver src/scripts/seed-documents.ts — normalmente solo seed:roles:prod aplica en un ambiente real
```

Correrlo **después** de que el contenedor de la API y el de la base de datos ya estén arriba (nunca durante el `RUN` del build) — el seed abre su propia conexión a Postgres vía `POSTGRES_DB_URL`, así que la base tiene que estar alcanzable en ese momento. Es idempotente: correrlo más de una vez no duplica filas.

---

## 7. Pendientes / trabajo futuro

### Pendiente de configuración: revisar la llave de Stripe del entorno desplegado — 2026-08-24

El flujo de pagos se reportó como roto en el entorno desplegado ("no cargan los servicios, no se
puede continuar al Checkout"). **Contra el stack local en `development` funciona de punta a punta**,
verificado con el backend y el frontend reales: el catálogo responde 200 con los 4 servicios, la
pantalla de Planes pinta las 4 tarjetas, "Comprar" devuelve 201 y el navegador aterriza en
`checkout.stripe.com`. Es decir, **no hay un defecto de código en este flujo**; lo que falla es la
configuración de ese entorno.

Qué revisar en Dokploy, en este orden:

1. **`STRIPE_SECRET_KEY` apunta a la cuenta y el modo correctos.** Si estuviera ausente, la
   aplicación entera no arrancaría (el proveedor falla al construirse), así que si el resto de la
   API responde, la variable está puesta — lo que puede estar mal es *cuál* es.
2. **Si es una `rk_` (restricted key), que tenga LECTURA de Products y Prices.** El `.env.example`
   listaba los permisos de Checkout, Customers, Subscriptions e Invoices, **pero no éste**, que es
   justo del que sale el catálogo. Con esa lista incompleta, una llave provisionada "según la
   documentación" deja Checkout funcionando y la pantalla de Planes vacía o en error — exactamente
   el síntoma reportado. Ya está corregido en `.env.example`.
3. **Que esa cuenta tenga productos ACTIVOS con al menos un precio ACTIVO**, y en el mismo modo
   (test/live) que la llave. Un catálogo vacío responde 200 y no falla: ahora deja un `warn`.

El log de arranque dice ahora en qué modo quedó y si la llave es restringida, así que los tres
puntos se descartan leyendo las primeras líneas del contenedor.

### Formato de `seal/dto/seal-document.dto.ts` (y por qué `npm run lint` no sirve hoy como filtro)

Quedó sin corregir a propósito, al arreglar el sellado: son renglones de la feature de verificación
OCSP, no del bugfix, y reformatearlos habría metido ruido ajeno en un diff de corrección.

`npx eslint src/document/seal/dto/seal-document.dto.ts` marca tres:

| Línea | Qué |
|---|---|
| 34 | `@ApiProperty({example: '"https://cfdi.sat.gob.mx/edofiel"'})` — prettier lo quiere espaciado, y el valor lleva comillas dobles **dentro** de la cadena, que parecen sobrar |
| 49 | `@ApiProperty({example: 'SERVICIO DE ADMINISTRACION TIRIBUTARIA'})` — mismo espaciado, y dice **TIRIBUTARIA** en vez de TRIBUTARIA |
| 52 | `issuer:string;` — falta el espacio tras los dos puntos |

Las tres son cosméticas: no afectan la validación ni el payload que se manda a Seal Service, solo
el ejemplo que se publica en Swagger (el de la línea 49 sí se ve en el portal, con el typo).

**El problema de fondo es que no hay forma de notarlas.** El repo está guardado con CRLF
(`core.autocrlf`) y la configuración de prettier espera LF, así que `npx eslint src` reporta del
orden de **14,600 errores** de `Delete ␍` — un archivo que nadie ha tocado da ~470 él solo. Con ese
volumen, un error de formato real es indistinguible del ruido y el lint no puede usarse como filtro
en CI ni en pre-commit. Resolver el fin de línea (un `.gitattributes` con `* text eol=lf` y un
`--fix` de una sola pasada) es lo que haría que estas tres aparezcan solas.

### Al integrar `feat/signature-67`: quitarle la geolocalización a la vista pública

La historia "Ocultar geolocalización en hojas de firma y vistas públicas" se aplicó a todo lo que
existía en `development` (las dos hojas de evidencia y el QR de la firma avanzada). La **vista
pública de verificación** entra por otra rama, `feat/signature-67`, y ahí el dato sí se publica —
las dos ramas se escribieron en paralelo, así que el conflicto no aparece como conflicto de git:
el merge entra limpio y la ubicación vuelve a publicarse sin que nadie lo note.

**No hace falta acordarse.** `src/document/geolocation-not-published.spec.ts` lee las superficies de
presentación del módulo (las dos hojas, el QR y **todos** los contratos de `interfaces/responses/`,
leídos del directorio para que uno nuevo quede cubierto solo) y falla si alguna vuelve a exponerla,
señalando el archivo y el renglón. Al integrar esa rama, la prueba se pone en rojo.

Lo que hay que quitar cuando eso pase:

| Repo | Archivo | Qué |
|---|---|---|
| `signature-server` | `interfaces/responses/document-public-view-response.ts` | El campo `geoLocation` de `PublicSignerData` |
| `signature-server` | `document.service.ts` | `geoLocation` en `toCompletedPublicSigner` (y en el objeto del firmante pendiente) |
| `signature-app` | `_components/SignerEvidenceCard.tsx` | El `<InfoRow label="Geolocalización" …>` |
| `signature-app` | `_components/../_requests.ts` | El campo `geoLocation` de `PublicSigner` |
| `signature-app` | `_components/PublicDocumentView.spec.tsx` | El campo en los fixtures |

El criterio es el mismo que se aplicó aquí: se quita el campo del contrato, no solo el renglón de
la pantalla. Un campo que sigue llegando a la capa de presentación es como vuelve a colarse.


### Resuelto en esta ronda (las solicitudes FIEL sin 2FA no aparecían en "Por firmar") — 2026-08-15

`GET /document?participantEmail=` era el **único** punto del flujo que comparaba correos con `=` exacto. `users.email` se guarda siempre en minúsculas (ver `UserService`), pero `collaborators.email` conservaba tal cual lo que tecleó quien invitó — así que un firmante invitado como `Juan.Perez@mail.com` no veía el documento en su bandeja "Por firmar", aunque el detalle (`resolveMyCollaborator`), la vinculación (`linkPendingCollaboratorAccount`) y `sign()`/`reject()` sí lo reconocen: todos ellos comparan sin distinguir mayúsculas.

**Por qué se veía solo en documentos FIEL sin 2FA** (la parte que hacía parecer que el bug era del tipo de firma): en todos los demás casos algo termina vinculando la cuenta al colaborador, y a partir de ahí el emparejamiento del listado pasa a hacerse contra `users.email`, ya normalizado. La firma SIMPLE **siempre** exige 2FA, y solicitar el código (`POST /document/:id/verification-codes` → `findMySignerCollaborator` → `linkPendingCollaboratorAccount`) vincula la cuenta antes de firmar. Al desactivar el 2FA —solo posible en FIEL— ese paso previo desaparece: la fila se queda sin `accountId` y el documento permanece invisible en "Por firmar" hasta que el firmante entra por el enlace del correo.

- `DocumentService.findWithFilters`: `participantEmail`/`email` se normalizan a minúsculas y las tres subconsultas (participante, creador y "me toca firmar") comparan con `LOWER(...)`. Corrige también los documentos ya existentes en la base, sin migración de datos.
- `DocumentSignaturesService.create`: el correo del colaborador se guarda normalizado en minúsculas, igual que `users.email` — mientras no hay cuenta vinculada, ese correo es la única identidad del firmante.
- Tests: 4 casos nuevos (3 en `document.service.spec.ts` — participante, "me toca firmar" y creador con mayúsculas; 1 en `document-signatures.service.spec.ts` — el correo se persiste normalizado). 582 tests en total.

**Pendiente relacionado, no corregido aquí** (afecta a la misma bandeja pero tiene otra causa): el filtro "Requiere mi firma o revisión" (`myTurnOnly`) exige en SQL que el firmante tenga el `signing_order` más bajo pendiente, sin mirar `document.isSequential` — en un documento sin orden (`isSequential: false`, el default del formulario cuando no se pide firma en orden) cualquier firmante pendiente puede firmar, así que ese filtro esconde el documento a todos menos al primero. Es la única implementación de "a quién le toca" que no pasa por `isSignerTurn()` (ver `utils/next-signer.util.ts`, que sí contempla el caso).

### Resuelto en esta ronda (un fallo de correo ya no bloquea la firma) — 2026-08-09

`POST /document/:id/verification-codes` persistía el código y **después** enviaba el correo sin protección: si el proveedor (SendGrid) fallaba, la excepción tumbaba toda la petición con un 500 aunque el código ya estuviera emitido en la base. La pantalla de firma nunca llegaba a mostrar el campo para capturarlo, así que el firmante no podía firmar **ni rechazar** (el bloque de acciones depende de la verificación) — quedaba sin ninguna salida por un problema de infraestructura ajeno a él.

- El envío pasa a ser no fatal, con el mismo criterio que ya usaba `UserService` para el OTP de registro (advierte en el log y continúa).
- El contrato ahora reporta el resultado: `data: { emailDelivered: boolean }`, con un `message` distinto en cada caso, para que la UI pueda avisar y ofrecer el reenvío en vez de fingir que el correo salió. Documentado en Swagger.
- Tests: 2 casos nuevos en `document.service.spec.ts` (correo caído → `emailDelivered:false`, código igualmente emitido, sin excepción; y el camino feliz reportando `true`).

Del lado del frontend, `requestVerificationCodeRequest` expone `emailDelivered`, el hook cambia el toast por una advertencia cuando no salió, y `SignDocumentView` muestra un aviso persistente junto al botón "Reenviar código". Efecto secundario en las pruebas: la suite E2E ahora valida el código **por la interfaz** (antes tenía que hacerlo por API porque la pantalla nunca avanzaba).

### Resuelto en esta ronda (bug de acceso: el firmante no podía abrir su propio documento) — 2026-08-08

Encontrado por la suite E2E del frontend (`signature-app/e2e`, Playwright contra la aplicación real). `GET /document/:id` y `GET /document/file/:id` identificaban al colaborador **solo por `accountId`**, y ese campo permanece en `null` hasta que el firmante entra por el enlace del correo (`/access-document` → `PATCH /document/:id/link-collaborator`). El listado (`GET /document?participantEmail=`), en cambio, siempre filtró por email: **el usuario veía en "Por firmar" documentos que el detalle le rechazaba con 403** ("No tienes acceso a este documento"), y quedaba atascado si llegaba por la navegación en vez del correo. El visor de PDF fallaba igual, así que ni el detalle ni el archivo cargaban.

- `DocumentService.resolveMyCollaborator` (nuevo, privado) resuelve al colaborador del usuario autenticado primero por cuenta vinculada y, si no hay, por email (case-insensitive) contra las invitaciones con `accountId` en null. Lo usan `findDetailForUser` y —con la consulta equivalente— `assertUserHasAccess`.
- **No amplía el modelo de seguridad**: `sign()`/`reject()` ya identificaban al firmante exactamente así (`findOrLinkMySignerCollaborator` → `linkPendingCollaboratorAccount`, emparejando por email), y el email de la cuenta está verificado por OTP en el registro. Lo que había era una asimetría: se confiaba en el email para *firmar* pero no para *leer*.
- **Sigue sin vincular en lecturas**: se respeta la decisión de la historia "Vinculación del documento debe postergarse hasta el inicio de sesión y validación de RFC" — un GET no asocia la cuenta; eso sigue siendo una acción explícita (`/access-document`, `useLogin`) o perezosa dentro de `sign()`/`reject()`. Hay un test que lo fija (`collaboratorRepository.update` no se llama al leer).
- Tests: 4 casos nuevos en `document.service.spec.ts` (lectura por email, no-vinculación, extraño sigue con 403, y los cuatro caminos de `assertUserHasAccess`). En el frontend, la prueba E2E que documentaba el bug pasó a verificar el comportamiento corregido.

### Auditoría de documentación (README vs. código real) — 2026-08-06
Las secciones 1-6 de este README (referencia técnica) describían el modelo previo a la migración de arquitectura `ENTIDAD_RELACIÓN_V2` — esa migración sí quedó narrada más abajo en este mismo changelog ("migración de modelo completa `ENTIDAD_RELACIÓN_V2`"), pero nunca se retroalimentó a las secciones de arriba, y varias rondas posteriores a esa migración (OTP de registro/recuperación de contraseña, catálogo de permisos administrativos de organización, cadena de auditoría global en Postgres, `efirma`, visor público de documentos) tampoco se documentaron nunca, en ninguna sección. Se hizo una auditoría de solo lectura (dos agentes en paralelo, uno por proyecto del monorepo, más lectura directa de migraciones/entidades/controladores) y se reescribieron las secciones 1-6 completas contra el código real (25 entidades, 22 controladores, 30 migraciones, 3 productores/3 consumidores Kafka). La sección 7 (este changelog) se dejó intacta salvo esta entrada nueva — es un registro histórico, no se reescribe retroactivamente.

**No se corrigió ningún código en esta ronda** (auditoría de documentación únicamente) — los hallazgos que implican una decisión de producto o un posible bug quedan documentados como pendientes reales más abajo, no arreglados de paso. En particular: el módulo `organization-permissions` completo, el flujo OTP de `auth`, y `GET /document/public/:id` no tenían precedente documental de ningún tipo antes de esta ronda.

### Resuelto en esta ronda (contrato de `POST /api/v1/documents/signatures` revisado por la historia de frontend)
La historia "[STORY] Frontend: Carga de Documentos y Configuración de Firmantes" trajo el JSON exacto que el formulario nuevo manda, y no coincidía con el contrato que se acababa de construir la ronda anterior — se ajustó el backend para matchearlo (confirmado antes de tocar código, no fue una suposición):

- **`collaborators`/`viewers` se unificaron en un solo arreglo** `collaborators` con `collaboratorType: SIGNER | VIEWER` (antes eran dos arreglos separados, `viewers` desapareció del payload). `VIEWER` mapea a `COLABORATOR_TYPE_ENUM.WATCHER` internamente.
- **El endpoint pasó a multipart** (antes era JSON puro con `documentData.objectKey` ya subido a MinIO por un paso externo) — ahora recibe el archivo real (`file`), lo sube él mismo (mismo flujo que `POST /document`), y `documentData` ya no trae `objectKey`/`fileType` (se derivan del archivo subido), solo `fileName`/`requiresApproval`.
- **Nuevas columnas**: `documents.requires_approval` (el checkbox "Requiere aprobación" — solo el flag, sin lógica de enrutamiento a un aprobador todavía, ver pendientes) y `collaborators.first_name`/`last_name`/`rfc` (antes un colaborador sin cuenta solo tenía `email`; `collaboratorDisplayName()` ahora usa nombre/apellido como fallback antes del email crudo).
- **`signaturePosition` (`{page, x, y}`) se conecta a `SimpleSignatureEntity`**: se crea una fila por firmante (`ADVANCED` o `SIMPLE`, ambos la mandan) y se linkea vía `collaborator.simpleSignatureId` — cierra un pendiente explícito de la ronda anterior ("no se crea fila en SimpleSignature/FielSignature"), al menos para las coordenadas.
- **`requiresTwoFactorAuth` reemplaza el criterio anterior**: el backend ya no infiere "ADVANCED ⇒ 2FA" — respeta el valor que manda el colaborador, salvo que **refuerza server-side** que SIMPLE siempre sea `true` (la historia de frontend fuerza esto oculto en la UI; el backend no confía ciegamente en que el cliente lo mande bien y lo reafirma).
- **`rfc` obligatorio se resolvió con `class-validator` puro** (`@ValidateIf` sobre el propio objeto: VIEWER siempre, SIGNER solo si ADVANCED) — más simple que la ronda anterior porque ya no hay un `signatureType` default a nivel documento del que depender.

**Bug real encontrado y corregido, no relacionado al contrato**: el `@Transform` que parsea `documentData`/`collaborators` (JSON serializado dentro de los campos de texto multipart) solo hacía `JSON.parse` sin construir una instancia de la clase destino — `ValidationPipe` con `whitelist: true` no reconocía las propiedades del objeto plano resultante como parte del DTO anidado y las descartaba en silencio (`documentData.fileName` llegaba `null` al service). Fix: usar `plainToInstance` dentro del `@Transform`, mismo patrón que ya usaba `signatureCoordinates` en `create-document.dto.ts` — encontrado probando el payload real contra un servidor corriendo, ningún test unitario (con mocks) lo hubiera atrapado.

Verificado en vivo contra Postgres + MinIO + Kafka reales con el payload **exacto** del ticket (multipart real, no solo JSON): 1 documento (`requires_approval: true`), 2 firmantes (ADVANCED con rfc + SIMPLE forzado a 2FA) + 1 viewer, 2 `simple_signatures` con las coordenadas correctas, 2 `verification_codes`. Confirmado además que nombres con acento (María, Pérez) se guardan correctamente — la corrupción que se vio en una prueba manual con `curl` inline resultó ser un artefacto de cómo Git Bash pasa argumentos UTF-8 a `curl.exe` en Windows (confirmado pasando el mismo JSON desde un archivo), no un bug real; un navegador real (`FormData`) nunca lo dispara. Build, lint y 244 tests (8 en `document-signatures.service.spec.ts`, reescritos para el nuevo contrato) pasan.

### Resuelto en esta ronda ([STORY] Backend: Orquestación para Creación de Documento y Flujo de Firmas)
Endpoint nuevo `POST /api/v1/documents/signatures` (`DocumentSignaturesController`/`DocumentSignaturesService`, `src/document/`), separado de `POST /document` existente — payload y orquestación distintos, coexisten.

**Decisiones tomadas antes de implementar (el ticket no las especificaba)**, confirmadas con el equipo:
- **El archivo ya está subido**: el payload es JSON puro (`documentData.objectKey/fileName/fileType`), no multipart — este endpoint lee el archivo de MinIO (para calcular `originalHash`/`totalPages`) pero no lo sube. La subida en sí (ej. vía URL prefirmada) queda fuera de esta historia.
- **Colaboradores siempre por email**: `collaborators`/`viewers` no traen `userId` — se crean con `accountId = null` siempre (invitación por email), sin intentar resolver si ese correo ya tiene cuenta en la plataforma. `viewers` mapea a `colaboratorType: WATCHER`.
- **Tópico Kafka dedicado**: `notification.created` (`NotificationEventsProducer`, `src/kafka/`), un evento por `Notification` creada — distinto de `DocumentEventsProducer` (eventos de ciclo de vida del documento, uno por documento). También integrado con `EventModule` (mismo patrón que los otros 2 producers).

**Transacción** (`DataSource.transaction`, ver `DocumentSignaturesService.create()`): Document → Collaborator (uno por cada `collaborators`+`viewers`) → Notification (`isNotified: false`) → `verification_code` si el colaborador es SIGNER y (`requiresVerification` del payload === true O `signatureType` efectivo es ADVANCED). Los eventos de Kafka (uno por notificación) se publican **fuera** de la transacción, después de que el `await this.dataSource.transaction(...)` resuelve — si cualquier paso de adentro lanza, el rollback ya ocurrió antes de que el código de publish sea alcanzable (Escenario 2). `VerificationCodeService.issue()` se extendió con un parámetro `manager?: EntityManager` opcional (retrocompatible) para que el INSERT del código participe de la misma transacción en vez de correr en una conexión aparte.

**RFC obligatorio en ADVANCED** (Escenario 3): se valida en el service, antes de leer MinIO o abrir la transacción — no es una regla expresable con `class-validator` sobre un solo colaborador porque el `signatureType` efectivo puede venir heredado del default a nivel documento (`dto.signatureType`), no solo del propio objeto.

**Fuera de esta ronda a propósito**: no se crea una fila en `SimpleSignatureEntity`/`FielSignatureEntity` para los colaboradores ADVANCED (el DoD de esta historia solo lista Document/Collaborator/Notification/verification_code) — el `rfc` se valida pero no se persiste todavía; conectarlo a `collaborator.fielSignatureId` sería el siguiente paso natural si se necesita. Tampoco se construyó un consumer para `notification.created` — el DoD solo pide el productor, el consumo real ("workers de correos") es explícitamente externo a este repo.

Verificado en vivo contra Postgres + MinIO + Kafka reales, no solo mocks: subí un PDF directo a MinIO (simulando el paso de upload previo), llamé al endpoint con 1 signer ADVANCED+rfc, 1 reviewer y 1 viewer, y confirmé 1 documento (`status: pending`, `requires_verification: true`), 3 colaboradores, 3 notificaciones, 1 `verification_code` (solo el ADVANCED) y 3 filas en `events` (`notification.created`) — HTTP 201 con los conteos correctos. Probé también el rollback real (objectKey inexistente → 400, cero filas nuevas) y la validación de RFC (ADVANCED sin rfc → 400 antes de tocar MinIO). Build, lint y 242 tests (6 nuevos en `document-signatures.service.spec.ts`, cubriendo los 3 escenarios de la historia con mocks) pasan.

### Resuelto en esta ronda (EventModule conectado a los producers Kafka existentes)
Cerraba el pendiente de la ronda anterior: `EventService.create()` ahora se llama desde ambos producers reales, no solo desde el módulo aislado.

- **`DocumentEventsProducer`**: `emitEvent()` (el helper privado que usan las 6 `emit*`) ahora, además de publicar a Kafka, llama a `EventService.create()` con `eventType` mapeado explícitamente desde el tópico (`TOPIC_TO_EVENT_TYPE`, un `Record` — se evitó castear un enum al otro solo porque hoy comparten los mismos valores string), `metadata: { documentId, fileName }` (la correlación que el diagrama pide vía metadata, no FK real) y `from: actorUserId`.
- **`OrganizationInvitationEventsProducer`**: `emitInvited()` igual, con `eventType: ORGANIZATION_MEMBER_INVITED` y `from` = el `invitedBy` del admin que invitó (parámetro nuevo del método, separado del payload de Kafka — no viajaba ahí y no hacía falta agregarlo al contrato ya documentado). **Decisión deliberada**: `invitationToken` NO se copia a `metadata` — ya vive en `organization_invitations.token` como credencial de un solo uso, y duplicarlo en una tabla de propósito general (`events`, potencialmente con acceso más amplio) amplía su superficie de exposición sin necesidad real.
- **Independiente de Kafka a propósito**: la llamada a `EventService.create()` va con `.catch()` + `logger.error` (fire-and-forget, mismo patrón que `void auditService.create(...)` en `document.service.ts`) — un fallo al persistir el evento de trazabilidad no debe tumbar el publish real a Kafka ni la petición HTTP que lo disparó.

Verificado en vivo contra Postgres + Kafka reales (no solo mocks): creé un documento real (dispara `document.created`) y una invitación real a organización (dispara `organization.member.invited`), y confirmé ambas filas en `events` con `metadata`/`from` correctos — incluyendo que `invitationToken` efectivamente no aparece en el metadata de la invitación. Build, lint y los 236 tests (agregué 1 nuevo, cubriendo que el token no se filtra a metadata) pasan.

### Resuelto en esta ronda (diagrama ER-V2 más reciente: Collaborator→Account, entidades de firma en su módulo, módulo event)
Historia [TASK] Actualización de Diagramas Entidad-Relación (ER) — el diagrama adjunto (`Firmalo-ER-V2.drawio (4).png`, raíz del monorepo) ya tenía `Collaborator`, `SimpleSignature` y `FielSignature` implementados desde rondas anteriores del mismo plan de migración; el trabajo real de esta ronda fue:

- **`CollaboratorEntity.userId` → `accountId`** (migración `RenameCollaboratorUserIdToAccountId`): el diagrama especifica `Collaborator.accountId` (FK a `Account`), no `userId` directo a `Users`. No es solo un rename de columna — ancla la identidad del colaborador a su cuenta PERSONAL (no a una membresía de organización específica, evita la ambigüedad de "cuál cuenta" para alguien en varias organizaciones) y toca autorización real: `sign()`/`reject()`/`confirmCancellation()`/`findDetailForUser()`/`assertUserHasAccess()` comparaban `collaborator.userId === currentUserId` (JWT `sub`) directo; ahora comparan `collaborator.account?.userId === currentUserId`, resolviendo la identidad de la persona a través de la cuenta (`AccountEntity.userId`, 1:1 para cuentas PERSONAL) — el criterio de autorización no cambió (sigue siendo "eres tú"), solo el camino para verificarlo. `create()` resuelve cada `signerIds`/`watcherIds`/`reviewerIds` (siguen llegando como `userId`s desde el picker del frontend, sin cambios ahí) a la cuenta PERSONAL del invitado vía `AccountMemberService.findPersonalAccountId()` (nuevo, mismo patrón que ya usaban `seed-documents.ts` y varias migraciones). Las 4 subconsultas SQL crudas de `findWithFilters` (`participantEmail`/`email`/`participantName`/`myTurnOnly`) pasaron de un JOIN directo a `users` a un JOIN de 2 saltos vía `accounts`. Backfill con el mismo criterio que `AddAccountIdToDocuments`: falla a propósito si algún colaborador con `user_id` no resuelve a una cuenta PERSONAL, en vez de dejar una fila huérfana.
- **`SimpleSignatureEntity`/`FielSignatureEntity` movidas a `src/signature/entities/`** (antes vivían en `src/document/entities/` pese a ser conceptualmente del dominio de firmas): actualizado el import en `CollaboratorEntity` (el único consumidor real) y registradas en `SignatureModule.forFeature` (mismo patrón que ya usaba ese módulo al registrar `UserEntity` — no hacía falta moverlas para esto, pero el ticket pedía explícitamente que quedaran "dentro del módulo signature"). No se tocó su esquema de BD (mismos nombres de tabla/columna) ni su lógica.
- **Módulo `event` nuevo** (`src/event/`): `EventEntity` (`events`: `id`, `event_type` enum, `metadata` jsonb, `from` varchar nullable, `created_at`) + `EventService.create()` mínimo + `EventModule` registrado en `app.module.ts`. Sin FK a otras tablas a propósito — el diagrama anota explícitamente que la trazabilidad fina (p. ej. a qué notificación corresponde un evento) va dentro de `metadata`, no como relación real. El diagrama no especifica los valores del enum `eventType`: se usó el mismo vocabulario de eventos de dominio que el sistema ya publica en Kafka (`document.created`/`.sent_to_sign`/`.signed`/`.rejected`/`.cancellation_requested`/`.cancelled`, `organization.member.invited`) por ser el candidato más fundamentado, documentado como asunción explícita en el docblock del enum. **Explícitamente fuera de esta ronda**: no se conectó `EventService` a ningún productor Kafka existente (`DocumentEventsProducer`, `OrganizationInvitationEventsProducer`) — el ticket pedía modelar la entidad y crear el módulo, no wire-earlo a los flujos existentes; conectarlo sería un cambio bastante más grande (toca cada call site de cada producer) que queda para una historia aparte si se necesita.

Verificado en vivo, no solo con mocks: migraciones corridas contra Postgres real (incluyendo el backfill real sobre las 2 filas de `collaborators` que ya existían en dev), y un flujo completo de creación→envío a firma→consulta de detalle (`canSign`)→firma real vía HTTP con dos usuarios reales, confirmando que `collaborator.account_id` resuelve correctamente de punta a punta (nombre del firmante, snapshot de firma, `assertUserHasAccess` con 200/403 correctos, y los 3 filtros de `findWithFilters` que usan las subconsultas de 2 saltos). Build, lint y los 235 tests existentes (con sus mocks actualizados al nuevo shape `account: { user: {...} }`) pasan sin cambios de comportamiento.

### Resuelto en esta ronda (seed en entorno compilado + verificación post-build en Docker)
El seed (`seed-roles.ts`/`seed-documents.ts`) nunca se había probado corriendo desde el código compilado (`dist/`) ni dentro de un contenedor — solo vía `ts-node` en dev. Dos bugs encontrados y corregidos:

- **Glob de entidades hardcodeado a `.ts`**: ambos scripts creaban su propio `DataSource` con `entities: [join(__dirname, '..', '**', '*.entity.ts')]`. En `dist/` esas entidades son `.entity.js` — el glob no matcheaba nada, así que corrido con `node dist/scripts/seed-roles.js` conectaba a la base pero `dataSource.getRepository(...)` fallaba (sin metadata registrada para ninguna entidad). Fix: mismo patrón que ya usaba `src/data-source.ts` para las migraciones, `*.entity{.ts,.js}` — un solo glob que resuelve al archivo que exista en disco en cada entorno, sin variable de entorno aparte. Se agregaron `seed:roles:prod`/`seed:documents:prod` (`node dist/scripts/seed-*.js`, sin `ts-node`) a `package.json` para el caso compilado.
- **La imagen Docker no arrancaba en absoluto** (bug bloqueante encontrado al intentar la verificación post-build, no reportado en el ticket original): `node:18-alpine` — usado en ambos stages del `Dockerfile` — tiene un bug conocido donde `globalThis.crypto` solo existe en modo `node -e`, no al correr un archivo (`node dist/main.js`); `@nestjs/typeorm` lo usa a nivel de módulo (`crypto.randomUUID()` en `typeorm.utils.js`) y el proceso moría con `ReferenceError: crypto is not defined` antes de levantar. `node:20-alpine`/`node:22-alpine` no tienen este problema. Fix: `Dockerfile` actualizado a `node:22-alpine` en ambos stages, alineado con el Node 22 que ya usa `ci-deployment.yml`.

**Verificación end-to-end real** (no solo "compila"): `docker build` de la imagen ya corregida → `docker compose up -d postgres mongo redis minio kafka` → contenedor de la API levantado con `docker run --network <red-de-compose> --env-file .env` (apuntando a los hostnames internos del compose, no `localhost`) → confirmado `healthy` vía el healthcheck existente → `docker exec <contenedor> npm run seed:roles:prod` corrido contra Postgres real. Para probar inserción real (no solo idempotencia) se vaciaron las tablas RBAC (`role_permissions`/`permissions`/`actions`/`resources`, `roles` se mantuvo por una FK real desde `account_members_deprecated`) y se corrió el seed de nuevo: mismos conteos finales que antes de vaciar (2 roles/3 resources/4 actions/12 permissions/14 role_permissions), confirmando que efectivamente reinsertó todo desde una base vacía y no solo no-opeó.

Ver comando exacto para correrlo en Docker en la sección 6, "Seed en Docker (post-build)".

### Resuelto en esta ronda (chequeo end-to-end completo: todos los servicios y procesos)
Se levantaron Docker (Postgres/Mongo/Redis/Kafka/MinIO) + backend + frontend limpios y se ejerció un flujo real completo vía HTTP (no mocks): registro → login → `GET /api/v1/users/me` → `GET /api/v1/accounts/me` → crear organización → `GET /api/v1/roles` → invitar miembro (éxito y los 4 caminos de error: sin header, cuenta no-ORGANIZATION, no-ADMIN, roleId inexistente) → agregar un segundo usuario como MEMBER real vía `/account-member` → crear un documento con archivo real → listar documentos filtrados por cuenta. En cada paso se confirmó el efecto real en la base de datos correspondiente, no solo el código 2xx de la respuesta:
- **Postgres**: usuario, `personal_information`, cuenta personal + membresía (`roleId` → rol ADMIN real), organización + `organization_details` + membresía, documento con `account_id` correcto.
- **Redis DB 0**: snapshot de onboarding por CURP y catálogo de cuentas (`accounts:{userId}`), ambos actualizándose en cada paso (alta de cuenta personal, luego de la organización).
- **MongoDB**: `AuditService` registrando `DOCUMENT_CREATED` con su `integrityHash`.
- **MinIO**: el archivo subido es recuperable de verdad vía la URL prefirmada que devuelve la API (`HTTP 200` al descargarlo).
- **Kafka**: `DocumentEventsConsumer` recibiendo y logueando el evento `document.created` publicado por el producer.
- **Aislamiento por tenant**: confirmado que un documento creado en la cuenta PERSONAL no aparece al listar con `X-Account-Id` de la organización (y viceversa), y que intentar operar con un `accountId` al que el usuario no pertenece responde `403`.

**Bug encontrado y corregido**: `GET /health` exigía JWT (le faltaba `@SkipJwtAuth()`) — cualquier probe de infraestructura real (Docker healthcheck, k8s liveness/readiness, monitoreo externo) recibía `401` en vez de un chequeo real, inutilizando el endpoint para su propósito. Ver sección 3, `health`.

**Bug crítico encontrado y corregido — en `signature-app`, no en este repo**: el cliente HTTP del frontend no lograba llegar al backend en ningún escenario real (`baseURL` apuntaba a un proxy same-origin roto, con un puerto de fallback que nadie sirve). El backend en sí nunca tuvo el problema — quedó demostrado sirviendo correctamente cada llamada real de este chequeo — pero **ninguna de esas llamadas le habría llegado nunca desde una sesión real de navegador** hasta este fix. Ver README de `signature-app`, sección 9, para el detalle completo.

### Pendientes reales (lo que queda abierto hoy)
- **`documents.requires_approval` sin enrutamiento real a un aprobador**: `POST /api/v1/documents/signatures` guarda el flag correctamente, pero nada en el backend usa ese valor todavía — el documento se crea en `PENDING` y notifica a los colaboradores igual que si `requiresApproval` fuera `false`. Falta decidir e implementar el flujo real: a quién se le notifica primero (¿algún colaborador con rol REVIEWER? ¿un ADMIN de la organización?), qué endpoint aprueba, y que la notificación a los firmantes solo se dispare después de esa aprobación. Fuera de esta ronda porque la historia que lo pidió era explícitamente de frontend (solo el checkbox + el payload).
- **"Cuenta fantasma" si Redis falla al crear una organización**: `appendAccountToCatalog()` solo hace `logger.warn` si Redis falla al sincronizar el catálogo tras `POST /api/v1/organizations` — la fila en Postgres queda bien, pero el usuario ve la organización funcionar (el frontend la agrega optimistamente a Zustand sin refetch) hasta que refresca la página: `GET /accounts/me` (Redis-only, sin fallback) ya no la trae, `AuthProvider` hace fallback silencioso a la cuenta personal, y la organización queda huérfana en Postgres sin ningún mecanismo de reconciliación (ni job periódico, ni "repair on read"). Encontrado en la auditoría de la Historia 3 del README raíz.
- **Endpoints `@Public()` de firma/INE sin verificar propiedad**: `GET /signature/files/:fileId` y `GET /signature/:id` solo exigen `x-api-key` compartida, no validan que el recurso pertenezca a quien llama — cualquiera con esa API key puede leer el INE/firma de cualquier usuario conociendo el UUID. Hoy no alcanzable desde `signature-app` (no manda `x-api-key`), pero vale revisar si es necesario.
- **`useCreateCheckoutSession` (frontend) sin manejo de error**: si `POST /stripe/checkout/session` falla, el botón "Suscribirse" solo vuelve a su estado normal sin ningún toast — a diferencia del resto de los hooks de mutación del proyecto.
- **`void this.auditService.create(...)` sin `await` en `sign()`/`confirmCancellation()`**: fire-and-forget — un fallo silencioso ahí no se propaga ni se loguea explícitamente como error de auditoría.
- **Healthcheck de MinIO en `docker-compose.yml` roto** (aparece "unhealthy" aunque MinIO funciona bien): usa `curl`, que no existe en la imagen oficial de MinIO — habría que cambiarlo por algo que sí esté disponible en la imagen (p. ej. `mc ready local`).
- **Invitación por email a alguien sin cuenta todavía**: el flujo de invitación (ver "Resuelto en esta ronda" más abajo) resuelve la identidad del invitado por RFC — si esa persona nunca se registra (ni siquiera llega a /join), la invitación simplemente queda `PENDING` hasta expirar (7 días); no hay un recordatorio automático ni un reenvío. Tampoco hay un listado de "invitaciones pendientes" en la UI de gestión de miembros todavía (ver README de `signature-app`, Fase de Gestión de Miembros) — solo se ven miembros ya aceptados.
- **`acceptByRfc` (Camino A de la historia) no requiere JWT ni contraseña — es una decisión explícita de la historia, no un descuido**: cualquiera que conozca el token de la invitación (del correo) Y el RFC del invitado (dato semi-público en México) puede consumar la invitación en su nombre. Ver el docblock de `OrganizationInvitationService` para el detalle — si se necesita cerrar este tradeoff, habría que exigir contraseña o requerir sesión iniciada en ese paso, lo cual cambiaría la historia tal como está escrita hoy.
- **JWT sin claims de cuenta/organización activa**: el `sub`/`email`/`roles`/`nationalId`/`jti` del JWT no cambiaron con la migración `ENTIDAD_RELACIÓN_V2` (ver "Resuelto en esta ronda" más abajo, sección de esa migración) — sigue sin haber un claim de "cuenta activa" en el token; el header `X-Account-Id` es la única señal de contexto por request. Si se necesita, es una decisión de producto aparte (afecta el flujo de login, no solo el modelo de datos).
- **`account`/`findAll()` sigue sin aislamiento por tenant**: ahora exige JWT (ver "Resuelto" abajo), pero cualquier usuario autenticado puede listar **todas** las cuentas de **todos** los usuarios — no hay un `accountId` único contra el cual aplicar el ownership check ahí. Es el único endpoint de estos dos módulos que quedó así a propósito (ver la entrada de la sección 3); si se necesita cerrar esto habría que decidir un concepto de "admin de plataforma" que hoy no existe, o quitar el endpoint si de verdad no lo usa nadie.
- **Migraciones `MakeAccountMemberRoleNullable`, `AddAccountIdToDocuments`, `CreateRolesModule` y `ReplaceAccountMemberRoleWithRoleId` sin confirmar contra una base con datos reales**: las 4 se generaron y se verificaron contra el esquema de desarrollo (incluyendo la última, verificada con una fila real: `role: [OWNER]` → `roleId` del rol de sistema ADMIN), pero no contra un ambiente con datos de producción reales. `AddAccountIdToDocuments` hace un backfill (asigna la cuenta PERSONAL del creador a cada documento existente) y falla a propósito si algún documento no encuentra esa cuenta. `ReplaceAccountMemberRoleWithRoleId` colapsa `ADMIN`/`SIGNEE` (enum viejo) en un solo rol `MEMBER` — una decisión de producto **irreversible sin pérdida** (el `down()` no puede distinguir cuál de los dos era originalmente); si en producción existiera alguna membresía con `ADMIN` (enum) que dependiera de tener más permisos que `SIGNEE`, este backfill la degradaría a `MEMBER`. Hay que correr las 4 primero en staging y confirmar que no truenen ni degraden permisos inesperadamente antes de un despliegue real. `migrationsRun: true` las aplica solas al desplegar, no requiere acción manual salvo esa verificación previa.
- **Multi-tenancy de documentos solo cubre crear + listar**: `GET /document/:id`, `sign`/`reject`/cancelación/`update`/`remove`, y el selector de participantes (`GET /user`, sigue devolviendo todos los usuarios de la plataforma) todavía no validan ni filtran por la cuenta activa. Se decidió acotar esta ronda a `create()`/`findWithFilters()` — el resto queda para una siguiente iteración si se necesita.
- **`X-Organization-Id` no lo lee nadie en el backend todavía**: el frontend lo manda en cada request cuando la cuenta activa es una organización (`lib/axios.ts`, ver README de `signature-app`), pero ningún controller/servicio de este repo lo consume — ni siquiera `document`, que sí valida `X-Account-Id`. Hoy es inofensivo (el scoping real ya lo hace `accountId`, y una organización no necesita un identificador adicional para resolver su cuenta), pero si en algún punto se necesita distinguir un rol "de organización" separado del "de cuenta", hay que decidir primero para qué serviría este header antes de empezar a leerlo.
- ~~Kafka sin caso de uso de negocio para el consumidor~~ **desactualizado, corregido en esta auditoría**: `DocumentEventsConsumer` ya no solo loggea (persiste `NotificationEntity`, encadena `DocumentTransactionEntity` y el ledger `AuditChainEntity`), y hay 2 consumidores reales más (`NotificationEventsConsumer` despacha correos, `OrganizationInvitationEventsConsumer` despacha el correo de invitación) — ver sección 3, `kafka`.
- ~~`OTPService`: implementado pero deliberadamente sin integrar a ningún flujo~~ **desactualizado, corregido en esta auditoría**: hoy hay un flujo OTP completo end-to-end (`auth`: `verify-otp`/`resend-otp`/`forgot-password`/`verify-reset-code`/`reset-password`, ver sección 3) — falta confirmar si internamente reutiliza `OTPService` o es una implementación paralela, ver nota en `shared/*`.
- **Cobertura de tests desactualizada en este README**: esta auditoría (de solo lectura, sin correr la suite) contó **47 archivos `*.spec.ts`** bajo `src/`, cubriendo módulos que ninguna entrada de este changelog documenta (`organization-permissions`, `efirma`, `audit-chain`, `document-transaction`, `verification-code`, `password-reset-code`, `email-verification-code`, `document-signing`). La última cifra de *tests* (no archivos) que aparece en el changelog es "244 tests" (entrada más reciente, arriba) — correr `npm test` es la única forma de confirmar el número vigente de tests individuales; no se hizo en esta ronda por ser auditoría de solo lectura. Tampoco hay un e2e que ejercite el flujo completo registro→login→onboarding→crear organización→crear documento (`test/app.e2e-spec.ts` sigue siendo el scaffold por defecto de Nest).
- **Bug crítico recurrente en `signature-app` (3ra vez), no en este repo**: `lib/axios.ts` volvió a tener `baseURL: '/api'` hardcodeado y `next.config.ts` volvió a traer el `rewrites()` roto — el mismo bug ya documentado como "resuelto" dos veces más abajo en este changelog (ver "bug crítico: el frontend no llegaba al backend"), incluyendo una ronda donde se agregó un test dedicado (`lib/axios.spec.ts`) explícitamente para evitar una tercera recurrencia. Ese test está fallando ahora mismo. El backend en sí no tiene el problema — ver README de `signature-app`, sección 9, para el detalle completo.
- **Migración baseline generada contra una base vacía de desarrollo**: `src/migrations/*-InitialSchema.ts` se generó reseteando el schema `public` de la base de dev (confirmado como desechable). Si este proyecto ya tiene un ambiente de staging/producción con datos reales, esa migración **no** debe correrse ahí tal cual — habría que generar una migración de diff real contra ese ambiente, o revisar la baseline a mano antes de aplicarla.

### Resuelto en esta ronda (auditoría general: revisión de las 6 historias del README + búsqueda abierta de bugs)
Auditoría completa de las 6 historias del README raíz (`C:/Signature/README.md`) más una búsqueda abierta de bugs en firma de documentos, Stripe y eliminación de documentos personales — 2 agentes de exploración en paralelo por historia, más lectura directa y verificación en vivo de cada hallazgo antes de corregirlo (no se corrigió nada solo por el reporte de un agente sin confirmarlo primero en el código real).

**Críticos:**
- **Firma corrupta silenciosa en el PDF final**: `finalizeSignedDocument()` volvía a leer la imagen de firma **en vivo** de MinIO para todos los firmantes cuando el último firmaba, no una copia tomada en el momento real de cada firma. Si un firmante desactivaba su firma (`PATCH /signature/:id/deactivate`, que sobrescribe el mismo object key con un PNG en blanco) entre que firmó y que el último terminó, el PDF legal final quedaba estampado con una firma en blanco, sin ningún error. Fix: `CollaboratorEntity.signatureSnapshotObjectKey` (migración `AddSignatureSnapshotToCollaborators`) — al firmar, se copia la imagen activa a un object key nuevo e inmutable; `finalizeSignedDocument()` usa ese snapshot, no la firma en vivo del perfil.
- **Suscripciones de Stripe que nunca se activaban**: `findByCustomerOrSubscription()` no caía al fallback por `stripeCustomerId` si la búsqueda por `stripeSubscriptionId` no encontraba nada (solo si venía vacío) — como Stripe no garantiza el orden entre `checkout.session.completed` e `invoice.paid`, un cliente podía pagar y quedar con `signingEnabled=false` para siempre. Corregido para intentar ambos criterios en cascada.

**Altos:**
- **Sin protección de carrera en `sign()`/`reject()`/`confirmCancellation()`**: doble clic o dos pestañas podían duplicar el estampado del PDF, los correos a todos los colaboradores y las filas de auditoría — no había ninguna transacción ni lock. Fix: un `UPDATE` condicionado atómico (`WHERE id = ? AND status = 'PENDING'`) antes de tocar MinIO — si `affected !== 1`, alguien más ya ganó la carrera, se aborta sin desperdiciar ningún trabajo. Verificado con tests que simulan la carrera perdida.
- **Condición de carrera al eliminar INE/firma en paralelo**: `deleteSignatureImage`/`deleteOfficialFile` cada uno leía el estado por su cuenta y decidía "¿el otro campo también está vacío?" contra esa lectura — si ambos corrían casi al mismo tiempo, ninguno tomaba la rama de "borrar todo", dejando una fila `signatures` huérfana que bloqueaba `create()` para siempre. Fix: `SELECT ... FOR UPDATE` (lock pesimista) dentro de una transacción, así la segunda llamada siempre decide sobre el estado fresco que dejó la primera. **Bug independiente encontrado de paso mientras se corregía esto**: el orden de las operaciones (borrar la fila de `signatures` antes de limpiar `users.signature_id`) violaba la FK `ON DELETE NO ACTION` de `InitialSchema` — nunca había funcionado, en carrera o no; se corrigió el orden. Verificado en vivo con dos requests DELETE disparadas en paralelo de verdad (no solo tests).
- **`ThrottlerModule` configurado pero nunca aplicado**: dab a la falsa impresión de que había rate limiting, pero `ThrottlerGuard` no se usaba en ningún lado — `/auth/login` no tenía ninguna protección real contra fuerza bruta. Se aplicó explícitamente (`@UseGuards(ThrottlerGuard)` + `@Throttle`) solo en `register`/`login` (5 intentos/60s) — no como `APP_GUARD` global, para no arriesgar romper el resto de la API con un límite nunca probado contra tráfico real. Verificado en vivo: el intento 6 en la misma ventana responde `429`.
- **`PATCH /api/v1/users/me/status` sin validación server-side**: confiaba 100% en que el frontend solo lo llamara cuando el onboarding realmente estaba completo — cualquier request autenticado marcaba `isConfigured=true` sin importar el estado real. Ahora recalcula `personalConfigured`/`signatureConfigured` server-side (mismo criterio que el frontend) antes de consolidar. Verificado en vivo: llamar el endpoint directo sin haber completado el onboarding responde `400`.

**Tests nuevos**: 235 tests en total (antes 214) — cubren los 2 críticos, la carrera de firma/rechazo/cancelación (incluyendo los casos de "carrera perdida"), la condición de carrera de eliminación de documentos personales, y la validación de `updateStatus`.

### Resuelto en esta ronda (Eventos Kafka, Email (SendGrid) y Miembros (/join))
Cierra el gap documentado en la ronda anterior: `POST /api/v1/organizations/invite` ya no solo valida — persiste, publica en Kafka, envía correo, y hay un flujo completo de aceptación (usuario existente o nuevo).

- **`organization_invitations` (tabla nueva)**: `id`, `organization_id`/`role_id`/`invited_by` (FKs a `organizations`/`roles`/`users`), `email`, `token` (UUID, `UNIQUE`), `status` (`PENDING`/`ACCEPTED`/`EXPIRED`), `expires_at` (7 días desde la creación — valor sin precedente en el repo, ajustable), `created_at`. Migración `CreateOrganizationInvitations`.
- **`OrganizationInvitationService`** (`src/account/`): `create()` genera el token, persiste `PENDING` y publica `organization.member.invited` vía `OrganizationInvitationEventsProducer` (nuevo, `src/kafka/`). `OrganizationsController.invite()` orquesta `AccountService.inviteMember()` (validación ya existente: ADMIN, cuenta ORGANIZATION, roleId válido) + `OrganizationInvitationService.create()` — deliberadamente en el controller y no dentro de un solo servicio, para no crear una dependencia circular (`OrganizationInvitationService` ya depende de `AccountService` para refrescar el catálogo de Redis al aceptar).
- **`OrganizationInvitationEventsConsumer`** (`src/kafka/`, nuevo): consume `organization.member.invited`, arma `${FRONTEND_URL}/join?token=...&orgId=...` y despacha el correo vía `EmailService.sendOrganizationInvitationNotification` (plantilla nueva). A diferencia de los correos del ciclo de vida de documentos (inline/síncronos), este envío es asíncrono a propósito — el `POST /invite` responde en cuanto persiste, sin esperar a SendGrid. Un fallo del consumer nunca tumba el proceso (mismo criterio que `DocumentEventsConsumer`) — la invitación queda `PENDING` igual, solo que sin correo hasta reintentarla manualmente.
- **`GET /api/v1/organizations/invitations/:token`** y **`POST /api/v1/organizations/invitations/:token/accept`** (`OrganizationInvitationsController`, nuevo): públicas (`@SkipJwtAuth()`, sin `x-api-key` tampoco — no `@Public()`) porque el invitado puede no tener sesión iniciada todavía. El GET resuelve el nombre de la organización para el mensaje de /join; el POST recibe `{rfc}` y resuelve al usuario por RFC (no por igualdad de email contra la invitación — el correo es solo el canal de entrega, ver docblock del servicio). Expiración perezosa: se marca `EXPIRED` en el primer acceso posterior a `expires_at`, sin job programado (sin infraestructura de cron en este repo).
- **`GET /api/v1/users/check-rfc?rfc=X`** (`UsersController`, nuevo, `@SkipJwtAuth()`): `UserService.checkRfcAvailability()` — usado desde /join y /signup en el frontend para bifurcar el flujo (RFC existente → unirse con la cuenta actual; RFC nuevo → registrarse).
- **`RegisterDto.invitationToken` (opcional)**: cuando el registro viene de /signup?...&token=... (RFC nuevo en /join), `AuthService.register()` llama `OrganizationInvitationService.acceptForUser()` automáticamente después de crear la cuenta — best-effort (un fallo no tumba un registro que por lo demás fue exitoso), mismo criterio que el refresco de Redis en `UserService.createFromSignup`.
- **Verificado en vivo end-to-end contra la base de dev** (no solo con tests mockeados): invitar → fila `PENDING` con token real en Postgres → `GET /invitations/:token` → Camino A (`POST /accept` con RFC de un usuario ya registrado, sin ningún header de autenticación) → aparece en `GET /organizations/:id/members` con el rol correcto; y Camino B (`check-rfc` con RFC nuevo → `POST /auth/register` con `invitationToken` → aparece igual en el listado de miembros, con el rol asignado en la invitación).
- **Tests nuevos**: `organization-invitation.service.spec.ts` (creación, preview con expiración perezosa, aceptar por RFC — no encontrado/ya aceptada/expirada/ya es miembro —, aceptar por userId), `organization-invitation.controller.spec.ts`, `organization-invitation.producer.spec.ts`, `organization-invitation-events.controller.spec.ts` (URL construida correctamente, fallback de `FRONTEND_URL`, el consumer no propaga errores de SendGrid), más casos nuevos en `auth.service.spec.ts` (auto-join best-effort) y `user.service.spec.ts`/`users.controller.spec.ts` (`check-rfc`). 206 tests en total (antes 183).
- **Sin variables de entorno nuevas**: reutiliza `SENDGRID_API_KEY`/`SENDGRID_FROM_EMAIL`/`FRONTEND_URL`/`KAFKA_BROKER`/`KAFKA_CLIENT_ID`/`KAFKA_CONSUMER_GROUP_ID`, ya documentadas en `.env.example`.

### Resuelto en esta ronda (Gestión de Miembros: listado, edición de rol y eliminación en organización)
- **`GET /api/v1/organizations/:organizationId/members`** (`AccountMemberService.findMembersForOrganizationDetailed`): shape delgado (`accountId`, `userId`, `email`, `rfc`, `role: {id,name} | null`, `joinedAt`) en vez de la `AccountEntity` completa — `email` ya vive en `accounts` (sincronizado, decisión D6), `rfc` requiere el join `accounts -> users -> personal_information`. Solo devuelve miembros activos. Mismo check de permiso `ORGANIZATION:READ` que el resto del módulo.
- **`PATCH /api/v1/organizations/members/:accountId/role`** y **`DELETE /api/v1/organizations/members/:accountId`**: delegan en los métodos ya existentes `AccountMemberService.update()`/`remove()` (mismos checks de permiso `ORGANIZATION:UPDATE`/`DELETE`, mismo soft-delete) — son alias con el contrato de ruta exacto que pedía la historia, no lógica nueva duplicada.
- **Protección del último ADMIN** (`assertNotLastAdmin`, nuevo): si el miembro objetivo es hoy el único `ADMIN` activo de la organización, tanto degradar su rol como eliminarlo responden `409 Conflict` — se aplica sin importar si el llamador es el propio objetivo u otro ADMIN (el sistema no tiene un rol `OWNER` separado de `ADMIN`, así que "el último dueño" de la historia se implementa como "el último ADMIN"). Verificado en vivo: con dos ADMIN activos ambas operaciones proceden con normalidad; al quedar uno solo, ambas quedan bloqueadas.
- **Bug corregido de paso**: `AccountMemberService.findByOrganization()` no filtraba `isActive: true` — un miembro eliminado (soft-delete) podía seguir apareciendo en el listado genérico de `/account-member`. Ahora ambos listados (el genérico y el nuevo detallado) excluyen miembros inactivos.
- **Tests nuevos**: `findMembersForOrganizationDetailed` (mapeo del shape, `ForbiddenException` sin permiso), `assertNotLastAdmin` cubierto desde `update()`/`remove()` (bloquea al único ADMIN, permite si hay otro ADMIN activo, no aplica a un `MEMBER`). `organizations.controller.spec.ts` gana la delegación de las 3 rutas nuevas. 181 tests en total (antes 170).

### Resuelto en esta ronda (RBAC granular: permisos reales por resource+action, no solo "es rol ADMIN")
- **`RolesService.hasPermission(roleId, resourceKey, actionKey)`/`assertHasPermission(...)`** (nuevo): consulta real contra `role_permissions` (join a `permissions`/`resources`/`actions`) en vez de comparar un nombre de rol fijo. El seed le da a `ADMIN` los 12 permisos (3 resources × 4 actions) y a `MEMBER` solo `DOCUMENT:READ`/`CREATE` — sembrados desde la ronda anterior pero sin ningún consumidor hasta ahora.
- **`AccountService.assertIsAccountAdmin` → `assertHasOrganizationPermission(callerId, accountId, action)`**: `findOne()` exige `ORGANIZATION:READ`, `update()` exige `ORGANIZATION:UPDATE`, `inviteMember()` exige `ORGANIZATION:CREATE`. Mismo cambio en `AccountMemberService.assertIsOrganizationAdmin` → `assertHasOrganizationPermission(callerId, organizationId, action)`: `create()` exige `CREATE`, `findByOrganization()`/`findOne()` exigen `READ`, `update()` exige `UPDATE`, `remove()` exige `DELETE`.
- **Comportamiento actual sin cambios**: como `ADMIN` tiene los 4 permisos de `ORGANIZATION` y `MEMBER` no tiene ninguno, el resultado de cada check es idéntico al `role.name === 'ADMIN'` de antes — verificado con la suite completa (170 tests) y un smoke test real contra la base de dev (`GET /account/:id` con un usuario `ADMIN` de su cuenta personal, `200 OK` con los joins reales a `role_permissions`). Lo que cambia es que un futuro rol custom de organización con permisos parciales (p. ej. puede `READ`/`UPDATE` miembros pero no `DELETE`) ya funcionaría sin tocar código — antes era binario (ADMIN o nada).
- **Tests nuevos**: `roles.service.spec.ts` gana `hasPermission`/`assertHasPermission` (permiso presente/ausente, `roleId` nulo sin consultar la base, mensaje de error propagado). `account.service.spec.ts`/`account-member.service.spec.ts` actualizados para mockear `RolesService.hasPermission`/`assertHasPermission` en vez de inferir el resultado del `role.name` embebido en la cuenta mockeada — mismo comportamiento cubierto, ahora a través del punto de extensión real.

### Resuelto en esta ronda (migración de modelo completa `ENTIDAD_RELACIÓN_V2`)
Migración de arquitectura grande, ejecutada en fases (0-8) tras comparar el diagrama `Firmalo-ER-V2` campo por campo contra las entidades reales. Confirmado con el equipo: proyecto todavía en desarrollo sin datos reales en producción, así que se ejecutó como migraciones conectadas únicas (sin dual-write ni ventana de mantenimiento), verificando cada fase con la suite de tests + smoke test manual antes de pasar a la siguiente.

- **`Organization` separada de `Account`**: antes colgaba de `accountId` (`OrganizationDetailEntity`); ahora es su propia entidad con `id` propio (`isActive`, `address`, `rfc`, `domainAllowed`, `phoneNumber`, `indexDocuments`). Varias filas `Account` (una por miembro) comparten el mismo `organizationId`.
- **`Account`/`AccountMember` fusionados**: una sola fila por (usuario × contexto), tal como lo pedía el diagrama — ya no son dos entidades paralelas. `email`/`password` se movieron de `UserEntity` a `Account`, sincronizados desde una única credencial por usuario (decisión de producto: **una sola credencial por usuario**, sin selector de cuenta antes de la contraseña — cero cambio en la UX de login actual). `AuthService.login` resuelve contra `Account.email`/`.password`.
- **`Collaborator` reemplaza `DocumentParticipant`**: generaliza "participante" a "colaborador" — agrega el rol `WATCHER`/`REVIEWER`, permite invitar solo por email (`userId` nullable, sin cuenta de plataforma todavía), y suma `comments`/`geoLoc`/`cancellationReason`/`reminderPeriodicity`/`signatureType` que no existían antes.
- **`SimpleSignature`/`FielSignature`**: coordenadas de firma explícitas por colaborador (antes una sola ancla por documento) con fallback al apilado automático si no se especifican. `FielSignature` es solo modelo de datos (`id`/`rfc`/`verificationCode`/`verificationCodeRequired`) — deliberadamente sin ninguna lógica de firma criptográfica conectada; qué proveedor de e.firma/PKI mexicano se integra es una decisión de producto/legal pendiente, no de ingeniería (ver `fiel-signature.entity.ts`).
- **`verification_code`**: conecta el `OTPService` que ya existía completo pero sin caller. Gateado por `document.requiresVerification` (default `false` — el flujo de firma dominante no cambia).
- **`Notification` persistida**: respalda los envíos de `EmailService` con una fila por colaborador afectado, escrita desde `DocumentEventsConsumer`. `requestCancellation` ahora también audita y emite evento Kafka (gap que existía desde antes).
- **`audit_log` en Postgres**: índice ligero (no reemplazo) sobre la cadena de hashes que ya vive en Mongo — un puntero indexable/joinable, la fuente de verdad sigue siendo `AuditDocument`.
- **Migraciones**: `AddOrganizationFields`, `AddDocumentAdditiveColumns`, `CreateCollaboratorsFromDocumentParticipants`, `CreateSimpleSignatures`, `MergeAccountAndOrganization`, `CreateNotifications`, `CreateVerificationCodes`, `CreateFielSignatures` — todas con `up`/`down` probados en round-trip contra la base de dev, siguiendo el mismo estilo que las anteriores (SQL crudo, backfill, `down()` honesto). `document_participants` y las tablas legacy de `accounts`/`organizations` se renombraron a `_deprecated`/`_legacy` en vez de borrarse, para diferir el `DROP` real a una limpieza posterior.
- **Lo que NO cambió**: el JWT (`sub`/`email`/`roles`/`nationalId`/`jti`) sigue igual — no se agregó ningún claim de cuenta/organización activa (ver Pendientes). Tampoco se construyó lógica de firma FIEL real, ni un flujo de aprobación que module el rol `REVIEWER` (son datos, sin gateo del state machine todavía).

### Resuelto en esta ronda (Módulo de Invitación de Miembros — alcance delimitado)
- **`POST /api/v1/organizations/invite`** (`AccountService.inviteMember`, expuesto en `OrganizationsController`): implementado exactamente al alcance que pedía la historia — valida el payload (`InviteMemberDto`: `email` con `@IsEmail()`, `roleId` con `@IsUUID()`), que el llamador sea ADMIN activo de la organización activa (reutiliza `assertIsAccountAdmin`, ya existente), que esa cuenta sea de tipo `ORGANIZATION` (chequeo agregado por consistencia con el nombre/propósito del endpoint, no lo pedía la historia explícitamente pero evita invitar a la cuenta PERSONAL de alguien) y que el `roleId` exista (reutiliza `RolesService.findByIdOrFail`, ya existente de la ronda del RBAC). Responde éxito (201) sin persistir nada — ni correo, ni token, ni fila nueva — tal como especificaba la historia ("Alcance Delimitado"). Reutiliza `@ActiveAccountId()` (el mismo decorador de `document`) para leer `X-Account-Id`.
- **Sin entidades ni migraciones nuevas**: no hay tabla de "invitaciones pendientes" todavía — deliberado, la historia solo pedía validar y responder OK (ver Pendientes para lo que falta conectar).
- **Tests nuevos**: `account.service.spec.ts` gana un describe `inviteMember` (éxito, `BadRequestException` sin header, `ForbiddenException` si no es ADMIN, `BadRequestException` si la cuenta no es ORGANIZATION, `NotFoundException` si el `roleId` no existe). `organizations.controller.spec.ts` gana la prueba de delegación del nuevo endpoint. 124 tests en total (antes 118).

### Resuelto en esta ronda (Módulo de Roles: RolesModule, entidades RBAC y seed básico)
- **`RolesModule` nuevo (`src/roles/`)**: centraliza las 5 entidades de control de acceso (`RoleEntity`, `ResourceEntity`, `ActionEntity`, `PermissionEntity`, `RolePermissionEntity`) — antes no existían en ningún lado del proyecto. Migración `CreateRolesModule` (generada vía diff de TypeORM contra Postgres local, revisada a mano para no arrastrar un cambio pendiente no relacionado — ver nota abajo) y aplicada exitosamente contra la base de dev.
- **`GET /api/v1/roles`** (JWT): `RolesService.findAllSystemRoles()` retorna los roles con `isSystemRole = true` (`ADMIN`, `MEMBER`), pensado para poblar el modal de invitar miembros en el frontend — no expone los roles custom de una organización (hoy no existen, la columna `organizationId` queda lista para cuando se necesiten).
- **Seed básico** (`npm run seed:roles`, mismo patrón standalone que `seed:documents`): puebla `ADMIN`/`MEMBER`, los 3 `resources` y las 4 `actions` de la historia, y `role_permissions` (`ADMIN` con las 12 combinaciones resource×action, `MEMBER` solo `READ`+`CREATE` sobre `DOCUMENT`). Verificado corriéndolo dos veces seguidas contra Postgres local: mismos conteos exactos en ambas corridas (2 roles/3 resources/4 actions/12 permissions/14 role_permissions), confirmando que es idempotente y no duplica filas.
- **Nota sobre la migración generada**: el diff de TypeORM detectó, además de las tablas nuevas, que la migración `AddAccountIdToDocuments` (de la ronda anterior) nunca se había aplicado contra la base de dev local — el diff intentaba re-agregar `documents.account_id` sin el backfill que esa migración sí tiene. Se quitó esa parte de la migración nueva (no le correspondía) y en su lugar se corrió `migration:run`, que aplicó ambas migraciones pendientes en orden correcto (primero `AddAccountIdToDocuments`, luego `CreateRolesModule`) sin conflicto, ya que la base de dev no tenía documentos que backfillear.
- **En su momento, explícitamente fuera de esta ronda**: ninguna autorización real usaba todavía estas tablas — era solo el catálogo + su seed, tal como pedía la historia. Conectarlo con `AccountMemberEntity` fue la ronda siguiente (ver más abajo).

### Resuelto en esta ronda (AccountMemberEntity.roleId conectado al catálogo RBAC — ya no son dos sistemas paralelos)
- **Decisión de producto tomada con el equipo**: reemplazar `AccountMemberEntity.role` (enum-array `OWNER`/`ADMIN`/`SIGNEE`, sin relación con ninguna tabla) por `roleId`, una FK real a `roles`. Motivación: dos historias anteriores (creación de organización, configuración de Zustand) ya especificaban un campo `roleId` singular tipo-FK — el enum-array fue una solución de compromiso porque en ese momento no existía ninguna tabla `Role` real; ahora que el módulo RBAC existe, seguir con el enum habría dejado ese catálogo permanentemente decorativo.
- **Backfill de datos** (migración `ReplaceAccountMemberRoleWithRoleId`): `OWNER` → rol de sistema `ADMIN`; `{ADMIN, SIGNEE}` → rol de sistema `MEMBER` — colapso decidido porque en el código actual `ADMIN` y `SIGNEE` (enum) eran funcionalmente idénticos (ningún check los distinguía, ambos fallaban el gate de `OWNER`), y los permisos seed de `MEMBER` (solo `READ`+`CREATE` sobre `DOCUMENT`) calzan con alguien cuyo rol es firmar/ver documentos, no administrar la cuenta. La migración inserta los roles `ADMIN`/`MEMBER` ella misma (idempotente, `WHERE NOT EXISTS`) para no depender de que `npm run seed:roles` ya se haya corrido — sin eso, el backfill podría no encontrar ningún rol al que apuntar. Verificado contra la única fila real de `account_members` en desarrollo (`role: [OWNER]` → `roleId` del rol `ADMIN` sembrado, sin duplicar roles).
- **`assertIsOwner` renombrado a `assertIsAccountAdmin`** (en `account.service.ts` y `account-member.service.ts`): ahora consulta `accountMemberRepository.findOne({ ..., relations: { role: true } })` y compara `callerMembership.role?.name === 'ADMIN'`, en vez de `.role?.includes(OWNER)` sobre el enum. `createDefaultPersonalAccount()`/`createOrganization()` resuelven el rol ADMIN vía `RolesService.findSystemRoleByName()` (nueva, lanza `InternalServerErrorException` si el seed no se ha corrido, en vez de fallar silenciosamente) para asignar el `roleId` de la membresía nueva.
- **`CreateAccountMemberDto`/`UpdateAccountMemberDto`**: `role: ACCOUNT_MEMBER_ROLE_ENUM[]` → `roleId: string` (`@IsUUID()`). `AccountMemberService.create()`/`update()` validan que el `roleId` recibido exista de verdad (`RolesService.findByIdOrFail()`, nueva) antes de asignarlo — `NotFoundException` si no.
- **Enum `ACCOUNT_MEMBER_ROLE_ENUM` eliminado** (`src/account/enums/account-member-role.enum.ts`) — ya no lo usa nadie tras el swap.
- **Respuestas HTTP**: `AccountData.role`/`AccountMemberData.role` (arrays de enum) → `roleId` (UUID único) en ambas interfaces.
- **Tests actualizados**: `account.service.spec.ts`/`account-member.service.spec.ts` reescritos para el nuevo shape (incluye casos nuevos de `NotFoundException` por `roleId` inválido). 118 tests en total (antes 114).

### Resuelto en esta ronda (X-Account-Id con efecto real: documentos scopeados por cuenta)
- **`DocumentEntity.accountId` (nueva columna, NOT NULL, FK a `accounts`)**: migración `AddAccountIdToDocuments` — backfill a la cuenta PERSONAL del creador para los documentos existentes (decisión de producto: ningún documento queda huérfano). Si algún documento no encuentra esa cuenta, la migración falla a propósito en el `ALTER COLUMN SET NOT NULL` en vez de dejar una fila inconsistente.
- **`POST /document` y `GET /document` ya leen y validan `X-Account-Id`**: nuevo decorador `@ActiveAccountId()` (`src/auth/decorators/`) extrae el header crudo; el servicio lanza `BadRequestException` si falta y llama al nuevo `AccountMemberService.assertIsActiveMember(userId, accountId)` (`ForbiddenException` si el usuario no es miembro activo) **antes** de usar el valor para nada. Confiar en un header que manda el cliente sin esta validación habría sido un hueco de aislamiento por tenant — cualquiera hubiera podido poner el UUID de otra organización. `findWithFilters()` agrega `WHERE document.accountId = :accountId` como filtro base, antes de cualquier otro filtro opcional de la query.
- **Se decidió explícitamente NO tocar** `GET /document/:id`, el ciclo de firma/rechazo/cancelación, ni `GET /user` (selector de participantes) en esta ronda — ver Pendientes.
- **`src/scripts/seed-documents.ts` actualizado**: creaba documentos directamente vía repositorio (sin pasar por `DocumentService`), así que necesitaba resolver `accountId` a mano — se agregó `findPersonalAccountId()`, con la misma lógica de la migración.
- **Tests nuevos**: casos de éxito/`BadRequestException`/`ForbiddenException` para `create()`/`findWithFilters()` en `document.service.spec.ts` (incluyendo uno que atrapó un bug real: al escribir el fix inicial se me olvidó enlazar `accountId` a la entidad antes de guardarla), más delegación en `document.controller.spec.ts` (antes solo un smoke test).

### Resuelto en esta ronda (ownership check en account/account-member)
- **`account`/`account-member` ya exigen JWT y validan OWNER**: se quitó `@Public()`/`@ApiSecurity('x-api-key')` de ambos controllers (ahora `@ApiBearerAuth('access-token')`, igual que el resto de la API autenticada). `AccountMemberService` valida en sus 5 métodos (`create`/`findByAccount`/`findOne`/`update`/`remove`) que el llamador tenga una membresía **activa** con `role` incluyendo `OWNER` sobre la cuenta involucrada (`ForbiddenException` si no) — para `findOne`/`update`/`remove`, que reciben el id de la membresía (no de la cuenta), primero se resuelve la membresía para obtener su `accountId`. `AccountService.findOne()`/`update()` aplican el mismo check. `create()`/`findAll()` de `AccountService` solo exigen JWT (no hay un `accountId` concreto que validar) — ver Pendientes sobre `findAll()`.
- **Por qué este orden importó**: implementar este check *antes* de que el creador de una organización quedara como OWNER automático (punto anterior) hubiera bloqueado a cualquier dueño de gestionar su propia organización recién creada. Se resolvió esa dependencia primero a propósito.
- **Tests nuevos**: `account-member.service.spec.ts` y `account-member.controller.spec.ts` (ninguno existía antes) cubren los 5 métodos con casos de éxito y de `ForbiddenException`. `account.service.spec.ts`/`account.controller.spec.ts` ganan casos equivalentes para `findOne`/`update`. 102 tests en total (antes 84).

### Resuelto en esta ronda (el creador de una organización queda como OWNER)
- **Decisión de producto revertida a propósito**: la historia original de creación de organización pedía dejar `AccountMemberEntity.role = NULL` para el creador ("se asigna en un paso posterior"), pero nunca se construyó ningún flujo que lo asignara — en la práctica quedaba `NULL` para siempre, y además bloqueaba cualquier intento de exigir ownership (OWNER/ADMIN) en `account`/`account-member`, ya que el propio creador no calificaría. Se decidió con el equipo asignar `role: [OWNER]` de inmediato en `createOrganization()`, igual que ya pasaba en la cuenta personal del registro — el patrón estándar de SaaS multi-tenant. La columna sigue siendo nullable a nivel de base (queda disponible para un futuro flujo de invitar miembros sin rol todavía), simplemente ningún código propio la deja en `NULL` hoy.

### Resuelto en esta ronda (role/isActive reales en el catálogo cacheado)
- **El catálogo de cuentas ya expone `role`/`isActive` de la membresía**: `AccountData` (`interfaces/response/account-response.ts`) gana los campos `role`/`isActive`. `toCatalogEntry()` ahora los recibe explícitos vía una nueva interfaz `MembershipCatalogFields`, en vez de serializar solo `id`/`name`/`type`/`createdAt`/`organizationDetail.name`. `createDefaultPersonalAccount()` retorna `{account, membership}` (antes solo `account`) para que el llamador (`UserService.createFromSignup`) pueda cachear el `role`/`isActive` reales sin duplicar el conocimiento de "la cuenta personal siempre es OWNER" en dos archivos. `renombrar una cuenta` (`update()`/`replaceAccountInCatalog`) preserva el `role`/`isActive` ya cacheados — renombrar no toca la membresía, así que no hace falta volver a consultarla.
- **Bug encontrado y corregido de paso**: `POST /api/v1/organizations` devolvía la `AccountEntity` cruda en la respuesta HTTP (sin `role`/`isActive`, esos campos viven en `AccountMemberEntity`, una fila aparte). Ahora la respuesta se construye con el mismo `toCatalogEntry()` que alimenta el catálogo cacheado, así que el frontend recibe `role`/`isActive` reales (hoy `['OWNER']`/`true` para el creador — ver el punto siguiente sobre esa decisión), en vez de `undefined` (que el mapper del frontend interpretaba como `status: 'INACTIVE'`, incorrecto para una cuenta apenas creada).

### Resuelto en esta ronda (invalidación del cache de Redis)
- **`updatePersonalInformation` y `PUT /api/v1/users/me/signature` ahora refrescan el cache de Redis por CURP**: `UserService.updatePersonalInformation()` llama `refreshUserCurpCache()` tras actualizar `PersonalInformation`. Para la firma, como `SignatureService` no conoce el CURP ni el cache de onboarding (y hacerlo depender de `UserService` crearía una dependencia circular con `UserModule`), se agregó `UserService.refreshCurpCacheForUser(userId)` (público, reconstruye el snapshot completo desde Postgres) y `UsersController.updateSignature()` lo llama justo después de `signatureService.create()`. Ya no hay ventana en la que `GET /api/v1/users/me` devuelva `signatureId`/`phoneNumber` desactualizados tras completar un paso del onboarding.
- **El catálogo de cuentas cacheado en Redis ya no queda obsoleto**: `AccountService.update()` (rename de cuenta/organización) ahora recorre los miembros activos (`AccountMemberEntity`, `isActive: true`) y reemplaza la entrada de esa cuenta en el catálogo (`accounts:{userId}`) de cada uno — solo cuando `name`/`organizationName` realmente cambiaron. `AccountMemberService.remove()` (revocar acceso) ahora resuelve la membresía primero (para tener `userId`/`accountId`) y llama al nuevo `AccountService.removeAccountFromCatalog(userId, accountId)`, que la quita del catálogo cacheado de ese usuario. Ambos helpers son best-effort (no tumban la operación si Redis falla), igual que `appendAccountToCatalog`. Se agregó `account-member.service.spec.ts` (no existía) cubriendo el `remove()` nuevo.

### Resuelto en esta ronda (organizaciones, onboarding vía Redis, endpoints versionados)
- **Creación de organización y switcher multi-tenant**: nuevo `POST /api/v1/organizations` (transaccional: `Account(ORGANIZATION)` + `OrganizationDetail` + `AccountMemberEntity` con `role: null`) y `GET /api/v1/accounts/me` (catálogo leído solo de Redis, sin fallback a Postgres). Ambos en controllers nuevos (`OrganizationsController`, `AccountsController`) separados del `AccountController` genérico (`/account`), que se queda solo con el CRUD administrativo.
- **`AccountMemberEntity.role` ahora nullable**: migración `MakeAccountMemberRoleNullable` (`DROP NOT NULL`). `createOrganization` guarda `role: null` a propósito (se asigna después, hoy sin UI — ver Pendientes); `createDefaultPersonalAccount` (registro) sigue asignando `[OWNER]` de inmediato, sin cambios.
- **Flujo de onboarding movido a `api/v1/users`**: `GET /api/v1/users/me` (perfil cacheado en Redis por CURP, con self-heal desde Postgres si la key no existe), `PUT /api/v1/users/me/personal-information`, `PUT /api/v1/users/me/signature` (delega en el mismo `SignatureService.create()`, ya no expuesto como `POST /signature`) y `PATCH /api/v1/users/me/status` (consolidación, sí refresca Redis). El JWT ahora incluye `nationalId` para que `GET /me` no necesite tocar Postgres en el camino feliz.
- **Rutas alineadas a lo pedido por las historias** (`/api/v1/...`, plural, verbos HTTP explícitos) en vez de seguir la convención singular sin versión que ya tenía el resto de la API (`/account`, `/user`, `/auth`) — es una inconsistencia de estilo consciente, documentada, no un descuido.

### Resuelto recientemente
- **Duplicados en `POST /document`**: `DocumentService.create` ahora rechaza (`400`) IDs repetidos entre `signerIds`/`spectatorIds`, y rechaza crear un documento con el mismo `fileName` que otro documento propio (mismo `createdBy`) en estatus `CREATED` o `PENDING`.
- **`findOneActiveUser` expone `phoneNumber`/`secondaryEmail`**: ahora incluye la relación `personalInformation` (solo esos dos campos) y los aplana en la respuesta de `GET /user/:id` y `GET /auth/me`, para que el frontend pueda mostrarlos y prefilling un formulario de edición.
- **`PATCH /user/personal-information` solo acepta `phoneNumber` y `secondaryEmail`**: `name`, `lastName`, `curp` y `rfc` se quitaron de `UpdatePersonalInformationDto` — son campos de identidad y no deben poder actualizarse por este endpoint (el frontend ya solo enviaba estos dos campos, pero ahora el backend tampoco los acepta si algún otro cliente de la API los envía).
- **`PATCH /user/:id` ya no acepta `nationalId` (CURP)**: `UpdateUserDto` excluye `nationalId` de `CreateUserDto` (`OmitType`). El CURP se fija una sola vez al crear el usuario y no es editable después, por la misma razón: es un campo de identidad.
- **Frontend consumiendo `PATCH /user/personal-information`**: `signature-app` tiene una pantalla (`/personal-documents`) que edita `phoneNumber` y `secondaryEmail` contra este endpoint — ver README de `signature-app`.
- **Validación de la firma del JWT**: confirmado que `JwtAuthGuard` verifica la firma con `jwtService.verifyAsync` (no solo decodifica) en cada request no marcado `@Public()`/`@SkipJwtAuth()`. El `middleware.ts` del frontend que decodifica sin verificar es seguro como optimización de UX porque esta capa sigue siendo la validación real.
- **Duplicados de CURP al crear/registrar usuario**: `UserService.assertCurpNotTaken` rechaza (`409`) un CURP ya usado por otro usuario activo, tanto en `POST /auth/register` como en `POST /user`. El correo electrónico ya tenía esta validación desde antes. **A propósito, `firstName`/`lastName` NO son campos de unicidad** — dos usuarios distintos pueden compartir nombre y apellido. Como `curp`/`nationalId` ya no son editables después de crear el usuario (ver puntos anteriores), no hace falta validar duplicados en ninguna actualización — solo al crear.

### Resuelto en esta ronda (fase "lo seguro primero" antes del RBAC/multi-cuenta completo)
Decisión tomada con el equipo: el diagrama `ENTIDAD_RELACIÓN_V2` completo (RBAC granular, `Organization`/`Account`/`Membership` separados, mover credenciales a `Account`, `Collaborator` reemplazando `DocumentParticipant`, `Watcher`/`Notification`/`Event`, `verification_code`, `SimpleSignature`/`FIELSignature`) es una migración de arquitectura grande que se planeará aparte. Esta ronda solo atacó lo acotado y de bajo riesgo:

- **Transacciones en creación de usuario**: `UserService.create()` y `createFromSignup()` ahora envuelven la creación de `PersonalInformation` + `User` en una transacción (`DataSource.createQueryRunner`). Si falla el `save()` del usuario, se hace rollback y no queda una fila huérfana de `PersonalInformation`.
- **Enum `UserRoles` duplicado eliminado**: se borró `src/user/interfaces/user.roles.enum.ts` (tenía un valor `ASIGNEE` no usado en ningún lugar real) y todo el código usa ahora `src/user/enums/user-roles.ts` como única fuente.
- **Typo de SendGrid corregido**: se eliminó la línea `SENGRID_API_KEY` (no usada, duplicada con el nombre correcto) de `.env` y `.env.example`.
- **Auditoría completa**: `DocumentService` ahora invoca `AuditService.create()` también para `DOCUMENT_CREATED` (en `create()`) y `DOCUMENT_SENT_TO_SIGN` (en `submitForAuthorization()`), además de los `DOCUMENT_SIGNED`/`DOCUMENT_REJECTED` que ya existían y el nuevo `DOCUMENT_CANCELLED` (ver siguiente punto).
- **Ciclo de cancelación completado**: nuevo método `DocumentService.confirmCancellation()` + endpoint `PATCH /document/:id/confirm-cancellation`. Cualquier firmante puede confirmar (una sola confirmación basta, igual que el rechazo — no hay votación de todos los firmantes, eso requeriría un campo de estado por participante que no existe hoy). Estampa "CANCELADO" (`stampCancelledWatermark`, ya existía), mueve el archivo a `cancelled_documents`, marca `cancelledAt`/`status = CANCELLED`, audita `DOCUMENT_CANCELLED` y notifica a todos los participantes (`sendDocumentCancelledNotification`, nuevo). También se endureció `requestCancellation()`: ahora exige que el llamador sea el creador del documento (antes no validaba propiedad) y expone `canRequestCancellation`/`canConfirmCancellation` en `GET /document/:id` para que el frontend muestre los botones correctos. Ver también README de `signature-app`.
- **Kafka con productor y consumidor reales**: nuevo `DocumentEventsProducer` (`src/kafka/document-events.producer.ts`) publica `document.created`, `document.sent_to_sign`, `document.signed`, `document.rejected`, `document.cancelled` en los mismos puntos donde se audita cada evento. Nuevo `DocumentEventsConsumer` (`src/kafka/document-events.controller.ts`) los consume y los loggea de forma estructurada — es un punto de partida real (visible en Kafka UI), no el mensaje de prueba original. Queda para una futura iteración conectar el consumidor a una acción de negocio real (p. ej. mover el envío de notificaciones fuera del request síncrono).
- **Tests arreglados**: la causa raíz de que casi toda la suite fallara no era solo la falta de mocks — el `rootDir: "src"` de Jest no tenía un `moduleNameMapper` para el prefijo `src/...` que usa todo el proyecto (TypeScript lo resuelve vía `baseUrl`, pero Jest no lo entendía y ni siquiera podía cargar los archivos). Se agregó `"moduleNameMapper": { "^src/(.*)$": "<rootDir>/$1" }` en la config de Jest (`package.json`). Además: dos specs (`signature.service.spec.ts`, `signature.controller.spec.ts`, `document.controller.spec.ts`, `redis.service.spec.ts`, `app.controller.spec.ts`) importaban `describe`/`it`/`beforeEach` desde `node:test` en vez de usar los globals de Jest — se quitaron esos imports. Se agregaron mocks reales (`getRepositoryToken`/`getModelToken`/`getDataSourceToken` + `jest.fn()`) a los specs de `user`, `document`, `signature` y `audit`.
- **`OTPService` se deja explícitamente en pendiente** (decisión del equipo, no se tocó).

### Resuelto en esta ronda (CURP único, RFC en registro, migraciones, tests de comportamiento)
- **CURP con constraint `@unique` en base de datos**: `UserEntity.nationalId` ahora tiene `unique: true` (antes la unicidad solo se validaba en la aplicación vía `assertCurpNotTaken`). Aplicado en la migración baseline (`CONSTRAINT ... UNIQUE ("national_id")`).
- **RFC recolectado en el registro**: `POST /auth/register` (`RegisterDto`) ahora exige `rfc` (12-13 caracteres alfanuméricos). `POST /user` (`CreateUserDto`, uso administrativo) lo recibe **opcional** — cumple el TODO que ya existía en el DTO ("Agregar RFC Opcional"). Se restauró `UserService.assertRfcNotTaken()` para rechazar (`409`) un RFC duplicado al crear/registrar (la columna `rfc` sigue siendo nullable a nivel de base porque `POST /user` puede omitirlo). El frontend (`signature-app`) ya tiene el campo en el formulario de signup — ver su README.
- **Sistema de migraciones formal**: `src/data-source.ts` (DataSource para la CLI), scripts `migration:generate`/`migration:create`/`migration:run`/`migration:revert` en `package.json`, `synchronize: false` + `migrationsRun: true` en `app.module.ts`. Se generó y aplicó `src/migrations/*-InitialSchema.ts` como baseline, reseteando primero el schema `public` de la base de dev (confirmada como desechable) para partir de un diff limpio contra las entidades actuales (incluyendo el CURP único de arriba). Ver sección 6 para el flujo completo. Tuvo el mismo problema de resolución de módulos que Jest (`src/...`): se resolvió agregando `"ts-node": { "require": ["tsconfig-paths/register"] }` a `tsconfig.json`.
- **Tests de comportamiento real**: `user.service.spec.ts` y `document.service.spec.ts` dejaron de ser smoke tests. Ahora cubren, con mocks reales de repositorios/servicios (no solo `should be defined`): en `UserService` — creación exitosa dentro de transacción, rollback si falla el `save` del usuario (sin fila huérfana), rechazo por email/CURP/RFC duplicado (tanto en `create()` como en `createFromSignup()`), actualización de información personal; en `DocumentService` — creación exitosa y sus 3 validaciones de rechazo (sin archivo, participante duplicado, nombre duplicado), firma intermedia vs. firma del último firmante (finalización + estampado), rechazo, solicitud y confirmación de cancelación, y sus respectivos casos de error (estatus inválido, no ser firmante/creador, turno incorrecto, sin credencial de firma activa). 47 tests en total (antes 15, todos "should be defined").

### Frontend
El frontend (`signature-app`) consume `PUT /api/v1/users/me/personal-information` para `phoneNumber` y `secondaryEmail` desde `/personal-documents` (ruta movida desde el `PATCH /user/personal-information` original, ver "Resuelto en esta ronda" arriba). `name`, `lastName`, `curp`, `rfc` no tienen UI de edición **por diseño** (no es una tarea pendiente, es la decisión tomada). También consume `GET /api/v1/users/me`, `GET /api/v1/accounts/me`, `POST /api/v1/organizations` y `PUT /api/v1/users/me/signature` para el onboarding y el switcher multi-tenant, con un store de Zustand (`useAuthStore`, Slices Pattern). Ver pendientes propios del README de `signature-app` (incluye una dependencia futura de la migración RBAC/multi-cuenta completa; el gap de `roleId`/`status` que dependía de que este backend los expusiera ya se cerró — `roleId` ahora es el UUID real del catálogo RBAC, no un valor derivado de un enum).
