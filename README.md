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
| `UserEntity` | `users` (Postgres) | id, firstName, lastName, email (único), position, roles, isActive, isDeleted, nationalId (CURP, 18 chars), password, `signatureId` (FK opcional), `personalInformationId` (FK obligatoria), createdAt, updatedAt |
| `PersonalInformationEntity` | `personal_information` (Postgres) | id, name, lastName, curp, rfc (nullable), phoneNumber (nullable), secondaryEmail (nullable) |
| `SignatureEntity` | `signatures` (Postgres) | id, signatureObjectKey (nullable), officialCardObjectKey (nullable), isActive, createdAt, updatedAt |
| `DocumentEntity` | `documents` (Postgres) | id, objectKey, fileName, fileType, totalPages, documentUrl, ipAddress, originalHash, signedHash, signedAt, cancelledAt, rejectedAt, status, signatureCoordinates (jsonb), createdBy (FK) |
| `DocumentParticipantEntity` | `document_participants` (Postgres) | id, documentId (FK), userId (FK), role (`signer`\|`spectator`), status (`pending`\|`signed`\|`rejected`), signOrder, signedAt, rejectedAt, rejectionReason |
| `AccountEntity` | `accounts` (Postgres) | id, name, type (`PERSONAL`\|`ORGANIZATION`) |
| `OrganizationDetailEntity` | `organization_details` (Postgres) | accountId (PK = FK), name |
| `AccountMemberEntity` | `account_members` (Postgres) | id, accountId (FK), userId (FK), role[] (`OWNER`\|`ADMIN`\|`SIGNEE`), isActive — único por (accountId, userId) |
| `AccountSubscriptionEntity` | `account_subscriptions` (Postgres) | id, accountId (FK, único), planId, stripeCustomerId, stripeSubscriptionId, status, currentPeriodEnd, signingEnabled |
| `AuditDocument` | `audits` (Mongo) | documentId, users[], operation, chainIndex, integrityHash, cipher, chainHash — sin FK real hacia Postgres (bases distintas) |

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

> El esquema se sincroniza automáticamente desde las entidades (`synchronize: true` en TypeORM) — no hay carpeta de migraciones. Cualquier cambio de entidad se aplica al reiniciar el servidor.

---

## 3. Módulos, endpoints y funciones

### `document` (`/document`)

| Endpoint | Método de servicio | Qué hace |
|---|---|---|
| `POST /document` | `create()` | Sube el PDF, crea documento + participantes |
| `GET /document` | `findWithFilters()` | Listado paginado con filtros (id, email, participante, estado, fechas, "mi turno") |
| `GET /document/:id` | `findDetailForUser()` | Detalle + permisos del usuario (`canSign`/`canReject`) |
| `GET /document/file/:id` | `getDocumentMinioURL()` | URL prefirmada según estado |
| `PATCH /document/:id/submit-for-authorization` | `submitForAuthorization()` | `CREATED → PENDING`, notifica al primer firmante |
| `PATCH /document/:id/sign` | `sign()` | Firma en turno; finaliza el documento si es el último firmante |
| `PATCH /document/:id/reject` | `reject()` | Rechaza con motivo, marca de agua, notifica al creador |
| `PATCH /document/:id/submit-for-cancellation` | `requestCancellation()` | `SIGNED → CANCELLATION_PENDING` (solo el creador) |
| `PATCH /document/:id/confirm-cancellation` | `confirmCancellation()` | `CANCELLATION_PENDING → CANCELLED` (cualquier firmante), marca de agua + notificación |
| `PATCH /document/:id` | `update()` | Reemplaza archivo/coordenadas (solo `CREATED`) |
| `DELETE /document/:id` | `remove()` | Borra archivo + registro (solo `CREATED`) |

### `signature` (`/signature`) — credencial de firma del usuario

| Endpoint | Servicio |
|---|---|
| `GET /signature/files/:fileId` | `getFile()` — URL prefirmada |
| `GET /signature/:id` | `findOne()` |
| `POST /signature` | `create()` — sube firma + INE, asigna `signatureId` al usuario |
| `PATCH /signature/:id` | `update()` — reemplaza imagen de firma y/o INE |
| `PATCH /signature/:id/deactivate` | `deactivate()` — sustituye la firma por PNG en blanco |
| `DELETE /signature/:id/signature-image` | `deleteSignatureImage()` |
| `DELETE /signature/:id/official-file` | `deleteOfficialFile()` |

Ownership de cada operación se valida contra `User.signatureId` (dueño real de la relación), no contra una FK en `Signature`.

### `user` (`/user`)

| Endpoint | Servicio |
|---|---|
| `POST /user` | `create()` — crea usuario + `PersonalInformation` vinculada |
| `GET /user` | `findAllActiveUsers()` |
| `GET /user/:id` | `findOneActiveUser()` |
| `PATCH /user/personal-information` | `updatePersonalInformation()` — el id sale del JWT, nunca de params/body |
| `PATCH /user/:id` | `update()` |
| `DELETE /user/:id` | `remove()` — soft delete |

### `account` / `account-member` (`/account`, `/account-member`)

`AccountService`: `create()`, `findAll()`, `findOne()`, `update()` (maneja `OrganizationDetailEntity` cuando `type = ORGANIZATION`). `AccountMemberService`: `create()`, `findByAccount()`, `findOne()`, `update()`, `remove()` (revocación = soft delete).

### `auth` (`/auth`)

| Endpoint | Servicio |
|---|---|
| `POST /auth/register` | `register()` → `UserService.createFromSignup()` |
| `POST /auth/login` | `login()` — valida password (bcrypt), firma JWT con `jti` único |
| `POST /auth/logout` | `logout()` — agrega el `jti` a la blacklist de Redis |
| `GET /auth/me` | `me()` |

### `audit` (`/audit`)

`GET /audit/document/:documentId`, `GET /audit/decrypted`, `GET /audit` (paginado). `AuditService.create()` es interno, invocado desde `DocumentService`.

### `stripe`

- `StripeCheckoutController`: `GET /stripe/plans`, `POST /stripe/checkout/session`, `GET /stripe/subscription`.
- `StripeWebhookController` (`POST /stripe/webhook`, verificado por firma): sincroniza `AccountSubscriptionEntity` según `checkout.session.completed`, `invoice.paid`, `customer.subscription.deleted`.

### `health`, `ip`, `kafka`

- `GET /health` — combina pings de Postgres, Mongo y Redis.
- `IpInterceptor` (global) — extrae la IP real del cliente e inyecta `request.clientIp`.
- `KafkaModule` — cliente configurado y conectando al boot (`signature.test` como chequeo de conectividad). Además, `DocumentEventsProducer`/`DocumentEventsConsumer` publican y consumen los eventos reales del ciclo de vida del documento: `document.created`, `document.sent_to_sign`, `document.signed`, `document.rejected`, `document.cancelled` (ver Pendientes sobre próximos pasos para el consumidor).

### `shared/*`

`MinioService` (almacenamiento), `HashService` (hashing + cifrado), `PdfSignatureService` (manipulación de PDF), `EmailService` (SendGrid), `OTPService` (generación/verificación de OTP — no integrado a ningún flujo aún), `RedisService` (blacklist de JWT), `PasswordService` (bcrypt).

---

## 4. Autenticación

Dos guards globales combinados con AND (`APP_GUARD` en `AuthModule`):

- **`ApiKeyGuard`** — solo exige `x-api-key` en endpoints marcados `@Public()`.
- **`JwtAuthGuard`** — exige `Authorization: Bearer <jwt>` válido y no presente en la blacklist de Redis, salvo `@Public()` o `@SkipJwtAuth()` (usado solo en `/auth/register` y `/auth/login`).

`@CurrentUser()` expone el payload del JWT (`sub`, `email`, `roles`, `jti`) inyectado por el guard en `request.user`.

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
npm run start:dev         # aplica el esquema automáticamente (synchronize: true)
```

Swagger disponible en `/api/docs` una vez levantado.

---

## 7. Pendientes / trabajo futuro

### Pendientes reales (lo que queda abierto hoy)
- **Migración de modelo completa (`ENTIDAD_RELACIÓN_V2`)**: RBAC granular (`role`/`permission`/`resource`/`action`), `Organization` separada de `OrganizationDetail`, mover `email`/`password` de `Users` a `Account` (multi-cuenta), `Collaborator` reemplazando `DocumentParticipant` con campos nuevos (`comments`, `geoLoc`, `visibilityLevel`, `cancellationReason`, `reminderPeriodicity`, `signatureType`), `Watcher`/`Notification`/`Event`, `verification_code`, `SimpleSignature`/`FIELSignature`, `Document Transaction`. Decisión tomada: se planea como fase aparte, no se toca el login actual hasta diseñarla explícitamente. Ver detalle más abajo.
- **CURP sin constraint `@unique` en base de datos**: la unicidad se valida hoy solo a nivel de aplicación (`UserService.assertCurpNotTaken`), no con un índice único de Postgres. Dos requests concurrentes con el mismo CURP podrían colarse en una condición de carrera.
- **RFC no se recolecta en el registro** (`POST /auth/register`): sigue siendo `nullable`, solo se puede cargar después vía `PATCH /user/personal-information`. Pendiente decidir si se agrega al formulario de registro.
- **Kafka sin caso de uso de negocio para el consumidor**: `DocumentEventsConsumer` hoy solo loggea los eventos de forma estructurada. Falta decidir una acción real (p. ej. desacoplar el envío de emails del request síncrono, alimentar un dashboard, disparar webhooks a terceros).
- **`OTPService`**: implementado pero deliberadamente sin integrar a ningún flujo (decisión del equipo, no es un olvido).
- **Sin sistema de migraciones formal**: `synchronize: true` sigue aplicando cualquier cambio de entidad directo a la base configurada. Antes de acometer la migración de modelo grande de arriba, hay que decidir si se introduce un sistema de migraciones de TypeORM.
- **Tests siguen siendo smoke tests**: las 14 suites pasan, pero solo verifican `should be defined` (inyección de dependencias correcta). No hay cobertura de comportamiento real (casos de éxito/error de cada método de servicio).

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
- **Tests arreglados**: la causa raíz de que casi toda la suite fallara no era solo la falta de mocks — el `rootDir: "src"` de Jest no tenía un `moduleNameMapper` para el prefijo `src/...` que usa todo el proyecto (TypeScript lo resuelve vía `baseUrl`, pero Jest no lo entendía y ni siquiera podía cargar los archivos). Se agregó `"moduleNameMapper": { "^src/(.*)$": "<rootDir>/$1" }` en la config de Jest (`package.json`). Además: dos specs (`signature.service.spec.ts`, `signature.controller.spec.ts`, `document.controller.spec.ts`, `redis.service.spec.ts`, `app.controller.spec.ts`) importaban `describe`/`it`/`beforeEach` desde `node:test` en vez de usar los globals de Jest — se quitaron esos imports. Se agregaron mocks reales (`getRepositoryToken`/`getModelToken`/`getDataSourceToken` + `jest.fn()`) a los specs de `user`, `document`, `signature` y `audit`. **Las 14 suites (15 tests) pasan ahora.** Siguen siendo smoke tests ("should be defined"); no se agregaron casos de comportamiento nuevos — eso queda como trabajo futuro si se quiere subir la cobertura real.
- **`OTPService` se deja explícitamente en pendiente** (decisión del equipo, no se tocó).

### Frontend
El frontend (`signature-app`) ya consume `PATCH /user/personal-information` para `phoneNumber` y `secondaryEmail` desde `/personal-documents`. `name`, `lastName`, `curp`, `rfc` no tienen UI de edición **por diseño** (no es una tarea pendiente, es la decisión tomada — ver arriba). Ver pendientes propios del README de `signature-app` (incluye una dependencia futura de esta misma migración RBAC/multi-cuenta).
