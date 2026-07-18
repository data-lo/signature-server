# Signature Server

Backend en NestJS para una plataforma de firma electrónica de documentos: gestión de usuarios, credencial de firma (rúbrica + identificación oficial), creación y firma secuencial de documentos, cuentas/organizaciones con membresías, suscripciones (Stripe) y auditoría con cadena de integridad.

## 1. Proceso de firmado de documentos

### 1.1 Dos conceptos que no hay que confundir

| Concepto | Entidad | Qué representa |
|---|---|---|
| **Firma del usuario (credencial)** | `SignatureEntity` (módulo `signature`) | La imagen PNG de la rúbrica + la foto de la identificación oficial (INE) del usuario. Se registra **una sola vez** por usuario (relación 1–1 opcional `Users.signatureId`). |
| **Firma de un documento (acto de firmar)** | `DocumentParticipantEntity` (módulo `document`) | El acto de que un participante concreto firme o rechace un documento concreto. Requiere que el usuario ya tenga su credencial (`SignatureEntity`) completa y activa. |

### 1.2 Flujo paso a paso

1. **Crear el documento** — `POST /document` (multipart: `file` PDF, `signerIds` en orden de firma, `spectatorIds` opcionales, `signatureCoordinates` opcional).
   - Valida que todos los participantes existan.
   - Sube el PDF a MinIO (bucket `created_documents`).
   - Cuenta páginas (`PdfSignatureService.getPdfPages`) y calcula el hash SHA-256 del original (`originalHash`).
   - Crea el `DocumentEntity` (`status = CREATED`) y un `DocumentParticipantEntity` por firmante (`role = SIGNER`, `signOrder` = posición en el arreglo) y por espectador (`role = SPECTATOR`, sin orden, solo visualiza).

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

| Entidad | Tabla / colección | Campos principales |
|---|---|---|
| `UserEntity` | `users` (Postgres) | id, firstName, lastName, email (único), position, roles, isActive, isDeleted, `isConfigured` (default `false` — onboarding: se pone en `true` solo vía `PATCH /api/v1/users/me/status`), nationalId (CURP, 18 chars, **único**), password, `signatureId` (FK opcional), `personalInformationId` (FK obligatoria), createdAt, updatedAt |
| `PersonalInformationEntity` | `personal_information` (Postgres) | id, name, lastName, curp, rfc (nullable a nivel de columna — obligatorio en `POST /auth/register`, opcional en `POST /user`), phoneNumber (nullable), secondaryEmail (nullable) |
| `SignatureEntity` | `signatures` (Postgres) | id, signatureObjectKey (nullable), officialCardObjectKey (nullable), isActive, createdAt, updatedAt |
| `DocumentEntity` | `documents` (Postgres) | id, objectKey, fileName, fileType, totalPages, documentUrl, ipAddress, originalHash, signedHash, signedAt, cancelledAt, rejectedAt, status, signatureCoordinates (jsonb), createdBy (FK), `accountId` (FK, **NOT NULL** — cuenta activa al crearlo, ver sección 3 y migración `AddAccountIdToDocuments`) |
| `DocumentParticipantEntity` | `document_participants` (Postgres) | id, documentId (FK), userId (FK), role (`signer`\|`spectator`), status (`pending`\|`signed`\|`rejected`), signOrder, signedAt, rejectedAt, rejectionReason |
| `AccountEntity` | `accounts` (Postgres) | id, name, type (`PERSONAL`\|`ORGANIZATION`) |
| `OrganizationDetailEntity` | `organization_details` (Postgres) | accountId (PK = FK), name |
| `AccountMemberEntity` | `account_members` (Postgres) | id, accountId (FK), userId (FK), `roleId` (FK a `roles`, **nullable** — hoy siempre el rol de sistema ADMIN para el creador, tanto de la cuenta personal del registro como de una organización nueva; el `NULL` queda disponible para un futuro flujo de invitar miembros sin rol asignado todavía), isActive — único por (accountId, userId) |
| `AccountSubscriptionEntity` | `account_subscriptions` (Postgres) | id, accountId (FK, único), planId, stripeCustomerId, stripeSubscriptionId, status, currentPeriodEnd, signingEnabled |
| `AuditDocument` | `audits` (Mongo) | documentId, users[], operation, chainIndex, integrityHash, cipher, chainHash — sin FK real hacia Postgres (bases distintas) |
| `RoleEntity` | `roles` (Postgres) | id, name, isSystemRole (default `false`; `true` para los 2 roles seed `ADMIN`/`MEMBER`), organizationId (FK opcional a `accounts` — `NULL` para roles del sistema, reservado para un futuro rol custom de una organización) |
| `ResourceEntity` | `resources` (Postgres) | id, key (**único**, p. ej. `DOCUMENT`), description |
| `ActionEntity` | `actions` (Postgres) | id, key (**único**, p. ej. `CREATE`), description |
| `PermissionEntity` | `permissions` (Postgres) | id, resourceId (FK), actionId (FK), scope (string libre, hoy solo `ANY`) — único por (resourceId, actionId, scope) |
| `RolePermissionEntity` | `role_permissions` (Postgres) | id, roleId (FK), permissionId (FK) — tabla pivote, único por (roleId, permissionId) |

### 2.2 Relaciones

- **User 1—1 Signature**: FK `signature_id` en `users`, **opcional**. `User` es el dueño de la relación.
- **User 1—1 PersonalInformation**: FK `personal_information_id` en `users`, **obligatoria**. `User` es el dueño de la relación.
- **User 1—N Document** (como creador): FK `created_by` en `documents`.
- **User 1—N DocumentParticipant**: FK `user_id` en `document_participants`.
- **User 1—N AccountMember**: FK `user_id` en `account_members`.
- **Document 1—N DocumentParticipant**: FK `document_id`, `onDelete: CASCADE`.
- **Account 1—1 OrganizationDetail**: FK `account_id` (PK compartida), `onDelete: CASCADE`.
- **Account 1—N AccountMember**: FK `account_id`, `onDelete: CASCADE`.
- **Account 1—1 AccountSubscription**: FK `account_id` (único), `onDelete: CASCADE`.
- **Role 1—N AccountMember**: FK `role_id` en `account_members`, **nullable**, sin `onDelete` (borrar un rol en uso no borra en cascada las membresías que lo tienen asignado).
- **Account 1—N Role** (roles custom de una organización, hoy sin uso real): FK `organization_id`, `onDelete: CASCADE`.
- **Resource 1—N Permission** / **Action 1—N Permission**: FK `resource_id`/`action_id`, `onDelete: CASCADE`.
- **Role 1—N RolePermission** / **Permission 1—N RolePermission**: FK `role_id`/`permission_id`, `onDelete: CASCADE`.

> El esquema ya **no** se sincroniza automáticamente (`synchronize: false`). Hay un sistema de migraciones formal de TypeORM en `src/migrations/` — ver sección 6 para los comandos y el flujo para aplicar cambios de entidad.

---

## 3. Módulos, endpoints y funciones

### `document` (`/document`)

| Endpoint | Método de servicio | Qué hace |
|---|---|---|
| `POST /document` | `create()` | Sube el PDF, crea documento + participantes. **Requiere el header `X-Account-Id`** (cuenta activa); el documento queda scopeado a esa cuenta (`DocumentEntity.accountId`) |
| `GET /document` | `findWithFilters()` | Listado paginado con filtros (id, email, participante, estado, fechas, "mi turno"). **Requiere `X-Account-Id`**: el listado se restringe a los documentos de esa cuenta, sin importar los demás filtros |
| `GET /document/:id` | `findDetailForUser()` | Detalle + permisos del usuario (`canSign`/`canReject`). **Todavía no scopeado por cuenta** (ver Pendientes) |
| `GET /document/file/:id` | `getDocumentMinioURL()` | URL prefirmada según estado |
| `PATCH /document/:id/submit-for-authorization` | `submitForAuthorization()` | `CREATED → PENDING`, notifica al primer firmante |
| `PATCH /document/:id/sign` | `sign()` | Firma en turno; finaliza el documento si es el último firmante |
| `PATCH /document/:id/reject` | `reject()` | Rechaza con motivo, marca de agua, notifica al creador |
| `PATCH /document/:id/submit-for-cancellation` | `requestCancellation()` | `SIGNED → CANCELLATION_PENDING` (solo el creador) |
| `PATCH /document/:id/confirm-cancellation` | `confirmCancellation()` | `CANCELLATION_PENDING → CANCELLED` (cualquier firmante), marca de agua + notificación |
| `PATCH /document/:id` | `update()` | Reemplaza archivo/coordenadas (solo `CREATED`) |
| `DELETE /document/:id` | `remove()` | Borra archivo + registro (solo `CREATED`) |

**Multi-tenancy (`X-Account-Id`)**: `create()`/`findWithFilters()` reciben el header y llaman `AccountMemberService.assertIsActiveMember(userId, accountId)` (`ForbiddenException` si el usuario no es miembro activo de esa cuenta) **antes** de usarlo para nada — el header lo manda el cliente, así que confiar en él sin validar contra `account_members` habría sido un hueco de aislamiento por tenant, no una solución. Si falta el header, `BadRequestException`. `DocumentEntity.accountId` (migración `AddAccountIdToDocuments`, con backfill a la cuenta PERSONAL del creador para los documentos ya existentes) es la columna que hace posible el filtro. El resto de los endpoints del módulo (`GET /document/:id`, `sign`/`reject`/cancelación/`update`/`remove`) siguen sin este scoping — ver Pendientes.

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

`AccountService`: `create()`, `findAll()`, `findOne()`, `update()` (maneja `OrganizationDetailEntity` cuando `type = ORGANIZATION`). `findOne()`/`update()` exigen que el llamador tenga una membresía **activa** con rol de sistema ADMIN sobre esa cuenta (`ForbiddenException` si no — el check consulta `account_members.role_id` vía `relations: {role: true}` y compara `role.name`, ya no un enum-array). `create()`/`findAll()` solo exigen JWT válido — no hay un `accountId` concreto contra el cual validar ownership (`findAll()` en particular sigue devolviendo el listado completo de cuentas de **todos** los usuarios a cualquier autenticado; ver Pendientes). Ninguno de los 4 se usa desde `signature-app` hoy — la creación real de cuentas pasa por `POST /auth/register` (personal) y `POST /api/v1/organizations` (organización).

### `organizations` (`/api/v1/organizations`, JWT) — creación de organización e invitación de miembros (multi-tenant)

`AccountService.createOrganization(userId, dto)`: transacción ACID que crea `Account(type=ORGANIZATION)` + `OrganizationDetail` + `AccountMemberEntity` con `roleId` apuntando al rol de sistema ADMIN (`RolesService.findSystemRoleByName`) para el creador (queda como administrador de inmediato, igual que en la cuenta personal). Al confirmar, refresca el catálogo cacheado en Redis (`appendAccountToCatalog`) para el usuario creador.

**`POST /api/v1/organizations/invite`** (`AccountService.inviteMember(callerId, accountId, dto)`) — **alcance delimitado a propósito** (ver historia `[STORY] Módulo de Invitación de Miembros`): recibe `{email, roleId}`, exige el header `X-Account-Id` (la organización activa, vía `@ActiveAccountId()`), valida que el llamador tenga una membresía activa con rol ADMIN sobre esa cuenta (reutiliza `assertIsAccountAdmin`, `ForbiddenException` si no), que la cuenta activa sea de tipo `ORGANIZATION` (`BadRequestException` si no — no tiene sentido invitar a la cuenta PERSONAL de alguien) y que el `roleId` recibido exista (`RolesService.findByIdOrFail()`, `NotFoundException` si no). Si todo pasa, responde éxito de inmediato. **No envía correo, no genera token de invitación, ni inserta ninguna fila** (`AccountMemberEntity`, catálogo de Redis) — es intencional, el endpoint solo valida y confirma recepción, dejando el flujo listo para conectar esa lógica en una siguiente iteración (ver Pendientes).

### `accounts` (`GET /api/v1/accounts/me`, JWT) — catálogo de cuentas del usuario autenticado

`AccountService.getAccountsCatalog(userId)`: lee **exclusivamente** el catálogo cacheado en Redis DB 0 (key `accounts:{userId}`), sin fallback a Postgres. Si la key no existe, retorna un catálogo vacío (no hay self-heal como en `users/me`, porque el catálogo se puebla siempre al registrarse/crear una organización).

### `account-member` (`/account-member`) — membresías (JWT, solo ADMIN)

`AccountMemberService`: `create()` (otorgar acceso con un `roleId` del catálogo RBAC), `findByAccount()`, `findOne()`, `update()` (cambia rol/puesto/vigencia), `remove()` (revocación = soft delete `isActive=false`). Los 5 exigen que el llamador tenga una membresía **activa** con rol de sistema ADMIN sobre la cuenta involucrada (`ForbiddenException` si no) — para `findOne()`/`update()`/`remove()`, que reciben el id de la membresía (no de la cuenta), primero se resuelve la membresía para obtener su `accountId` y luego se valida contra ese id. `create()`/`update()` además validan que el `roleId` recibido exista de verdad (`RolesService.findByIdOrFail()`, `NotFoundException` si no) antes de asignarlo.

También expone `assertIsActiveMember(userId, accountId)` (público, sin controlador propio): check de tenant más laxo — cualquier miembro **activo** basta, sin importar su rol — usado por otros módulos que necesitan validar el header `X-Account-Id` contra una membresía real (hoy solo `document`, ver su sección arriba).

### `roles` (`GET /api/v1/roles`, JWT) — catálogo RBAC (Role/Resource/Action/Permission/RolePermission)

`AccountMemberEntity.roleId` es una FK real a este catálogo (migración `ReplaceAccountMemberRoleWithRoleId` — ver Pendientes/Resuelto) — ya no son dos sistemas paralelos. Centraliza las 5 entidades de control de acceso: `RoleEntity`, `ResourceEntity`, `ActionEntity`, `PermissionEntity`, `RolePermissionEntity` (tabla pivote).

`RolesService.findAllSystemRoles()`: `roleRepository.find({ where: { isSystemRole: true } })`, ordenado por `name`. `RolesController` expone `GET /api/v1/roles` (JWT, sin check de ownership — es un catálogo de solo lectura, no datos de una cuenta concreta) devolviendo `{id, name, isSystemRole}` por rol; pensado para poblar el modal de invitar miembros en el frontend. También expone (sin controlador propio) `findSystemRoleByName(name)` — usado por `AccountService` al asignar el rol ADMIN por defecto a una membresía nueva — y `findByIdOrFail(id)` — usado por `AccountMemberService` para validar el `roleId` recibido en `create()`/`update()`.

**Seed** (`npm run seed:roles`, `src/scripts/seed-roles.ts`, mismo patrón standalone que `seed:documents`): puebla `ADMIN`/`MEMBER` (`isSystemRole: true`, `organizationId: null`), los 3 `resources` (`DOCUMENT`/`ORGANIZATION`/`USER`), las 4 `actions` (`CREATE`/`READ`/`UPDATE`/`DELETE`), y `role_permissions`: `ADMIN` con las 12 combinaciones resource×action (`scope: ANY`), `MEMBER` solo con `READ`+`CREATE` sobre `DOCUMENT`. Idempotente: cada tabla se busca por su clave natural antes de insertar (`key`/`name`, o el par de FKs en las pivote), así que correrlo varias veces no duplica filas — verificado corriéndolo dos veces seguidas contra Postgres local (mismos conteos: 2/3/4/12/14).

### `auth` (`/auth`)

| Endpoint | Servicio |
|---|---|
| `POST /auth/register` | `register()` → `UserService.createFromSignup()` |
| `POST /auth/login` | `login()` — valida password (bcrypt), firma JWT con `jti` único |
| `POST /auth/logout` | `logout()` — agrega el `jti` a la blacklist de Redis |
| `GET /auth/me` | `me()` — perfil completo desde Postgres (joins + URLs prefirmadas de MinIO para firma/INE); lo consume `/personal-documents` en el frontend. **No** es el mismo endpoint que `GET /api/v1/users/me` (ese lee solo Redis, sin URLs firmadas, pensado para hidratar rápido el onboarding). |

### `audit` (`/audit`)

`GET /audit/document/:documentId`, `GET /audit/decrypted`, `GET /audit` (paginado). `AuditService.create()` es interno, invocado desde `DocumentService`.

### `stripe`

- `StripeCheckoutController`: `GET /stripe/plans`, `POST /stripe/checkout/session`, `GET /stripe/subscription`.
- `StripeWebhookController` (`POST /stripe/webhook`, verificado por firma): sincroniza `AccountSubscriptionEntity` según `checkout.session.completed`, `invoice.paid`, `customer.subscription.deleted`.

### `health`, `ip`, `kafka`

- `GET /health` — combina pings de Postgres, Mongo y Redis. `@SkipJwtAuth()` (sin JWT ni x-api-key): lo consumen probes de infraestructura (healthcheck de Docker, liveness/readiness de k8s, monitoreo externo) que no traen ninguna credencial — antes de esta ronda no tenía el decorador y devolvía 401 a cualquier probe real, rompiendo el propósito mismo del endpoint (encontrado en el chequeo end-to-end de todos los servicios).
- `IpInterceptor` (global) — extrae la IP real del cliente e inyecta `request.clientIp`.
- `KafkaModule` — cliente configurado y conectando al boot (`signature.test` como chequeo de conectividad). Además, `DocumentEventsProducer`/`DocumentEventsConsumer` publican y consumen los eventos reales del ciclo de vida del documento: `document.created`, `document.sent_to_sign`, `document.signed`, `document.rejected`, `document.cancelled` (ver Pendientes sobre próximos pasos para el consumidor).

### `shared/*`

`MinioService` (almacenamiento), `HashService` (hashing + cifrado), `PdfSignatureService` (manipulación de PDF), `EmailService` (SendGrid), `OTPService` (generación/verificación de OTP — no integrado a ningún flujo aún), `RedisService` (blacklist de JWT), `PasswordService` (bcrypt).

---

## 4. Autenticación

Dos guards globales combinados con AND (`APP_GUARD` en `AuthModule`):

- **`ApiKeyGuard`** — solo exige `x-api-key` en endpoints marcados `@Public()`.
- **`JwtAuthGuard`** — exige `Authorization: Bearer <jwt>` válido y no presente en la blacklist de Redis, salvo `@Public()` o `@SkipJwtAuth()` (usado solo en `/auth/register` y `/auth/login`).

`@CurrentUser()` expone el payload del JWT (`sub`, `email`, `roles`, `nationalId`, `jti`) inyectado por el guard en `request.user`. `nationalId` (CURP) se agregó como claim estable — no es un dato volátil de onboarding (eso vive en Redis, no en el JWT), es la misma clase de identificador que `email`/`roles`, y permite que `GET /api/v1/users/me` resuelva directo por Redis sin una consulta previa a Postgres.

---

## 5. Stack técnico

| Componente | Uso |
|---|---|
| PostgreSQL (TypeORM) | Todo el dominio transaccional: usuarios, información personal, credenciales de firma, documentos, participantes, cuentas, membresías, suscripciones |
| MongoDB (Mongoose) | Solo el módulo `audit` — cadena de hashes de integridad, append-only |
| Redis (ioredis) | Blacklist de JWT invalidados por logout |
| Kafka (KRaft) | Cliente configurado y funcional; publica/consume los eventos del ciclo de vida del documento (creado, enviado a firma, firmado, rechazado, cancelado) |
| MinIO | Almacenamiento de archivos (documentos, firmas, INEs), siempre vía URL prefirmada |
| Stripe | Suscripciones por cuenta, 3 planes (`basic`/`pro`/`enterprise`), Checkout Sessions + webhook verificado |
| SendGrid | Notificaciones transaccionales por correo |
| pdf-lib / sharp | Manipulación y conformidad PDF/A de documentos / generación de PNG en blanco |

### Variables de entorno relevantes

`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `POSTGRES_DB_URL`, `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`, `FRONTEND_URL`, `MONGO_USERNAME`, `MONGO_PASSWORD`, `MONGO_DB_NAME`, `MONGO_DB_URL`, `MINIO_HOST`, `MINIO_PORT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `MINIO_*_BUCKET` (una por bucket), `CIPHER_SECRET`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `KAFKA_BROKER`, `KAFKA_CLIENT_ID`, `KAFKA_CONSUMER_GROUP_ID`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_BASIC`, `STRIPE_PRICE_ID_PRO`, `STRIPE_PRICE_ID_ENTERPRISE`, `API_KEY`.

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

---

## 7. Pendientes / trabajo futuro

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
- **Kafka sin caso de uso de negocio para el consumidor**: `DocumentEventsConsumer` hoy solo loggea los eventos de forma estructurada. Falta decidir una acción real (p. ej. desacoplar el envío de emails del request síncrono, alimentar un dashboard, disparar webhooks a terceros).
- **`OTPService`**: implementado pero deliberadamente sin integrar a ningún flujo (decisión del equipo, no es un olvido).
- **Cobertura de tests parcial**: 124 tests en 23 suites. `user.service.spec.ts`, `document.service.spec.ts`, `account.service.spec.ts` (incluye `inviteMember`), `account-member.service.spec.ts` y `roles.service.spec.ts` ya cubren comportamiento real (éxito + errores, incluyendo `NotFoundException` cuando `create()`/`update()` de `account-member` reciben un `roleId` inexistente), igual que `account.controller.spec.ts`/`account-member.controller.spec.ts`/`organizations.controller.spec.ts`/`document.controller.spec.ts`/`roles.controller.spec.ts` (delegación con el userId/accountId del JWT/header). El resto de specs (`audit`, etc.) siguen siendo smoke tests (`should be defined`). Tampoco hay un e2e que ejercite el flujo completo registro→login→onboarding→crear organización→crear documento (`test/app.e2e-spec.ts` sigue siendo el scaffold por defecto de Nest).
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
