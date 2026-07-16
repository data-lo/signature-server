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
| `DocumentEntity` | `documents` (Postgres) | id, objectKey, fileName, fileType, totalPages, documentUrl, ipAddress, originalHash, signedHash, signedAt, cancelledAt, rejectedAt, status, signatureCoordinates (jsonb), createdBy (FK) |
| `DocumentParticipantEntity` | `document_participants` (Postgres) | id, documentId (FK), userId (FK), role (`signer`\|`spectator`), status (`pending`\|`signed`\|`rejected`), signOrder, signedAt, rejectedAt, rejectionReason |
| `AccountEntity` | `accounts` (Postgres) | id, name, type (`PERSONAL`\|`ORGANIZATION`) |
| `OrganizationDetailEntity` | `organization_details` (Postgres) | accountId (PK = FK), name |
| `AccountMemberEntity` | `account_members` (Postgres) | id, accountId (FK), userId (FK), role[] (`OWNER`\|`ADMIN`\|`SIGNEE`) **nullable** — `NULL` al crear una organización (se asigna en un paso posterior, hoy sin UI — ver Pendientes), siempre `[OWNER]` en la cuenta personal del registro —, isActive — único por (accountId, userId) |
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

> El esquema ya **no** se sincroniza automáticamente (`synchronize: false`). Hay un sistema de migraciones formal de TypeORM en `src/migrations/` — ver sección 6 para los comandos y el flujo para aplicar cambios de entidad.

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

### `account` (`/account`) — CRUD genérico de cuentas (API key)

`AccountService`: `create()`, `findAll()`, `findOne()`, `update()` (maneja `OrganizationDetailEntity` cuando `type = ORGANIZATION`).

### `organizations` (`POST /api/v1/organizations`, JWT) — creación de organización (multi-tenant)

`AccountService.createOrganization(userId, dto)`: transacción ACID que crea `Account(type=ORGANIZATION)` + `OrganizationDetail` + `AccountMemberEntity` (con `role: null` — ver Pendientes sobre asignación posterior). Al confirmar, refresca el catálogo cacheado en Redis (`appendAccountToCatalog`) para el usuario creador.

### `accounts` (`GET /api/v1/accounts/me`, JWT) — catálogo de cuentas del usuario autenticado

`AccountService.getAccountsCatalog(userId)`: lee **exclusivamente** el catálogo cacheado en Redis DB 0 (key `accounts:{userId}`), sin fallback a Postgres. Si la key no existe, retorna un catálogo vacío (no hay self-heal como en `users/me`, porque el catálogo se puebla siempre al registrarse/crear una organización).

### `account-member` (`/account-member`) — membresías (API key, sin ownership check)

`AccountMemberService`: `create()` (otorgar acceso con uno o más roles), `findByAccount()`, `findOne()`, `update()` (cambia rol/puesto/vigencia — es el único lugar donde un `role` que nació `NULL` puede asignarse), `remove()` (revocación = soft delete `isActive=false`). Protegido solo por `x-api-key`, **no valida que el llamador pertenezca o sea OWNER/ADMIN de esa cuenta** — ver Pendientes.

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

### Pendientes reales (lo que queda abierto hoy)
- **Migración de modelo completa (`ENTIDAD_RELACIÓN_V2`)**: RBAC granular (`role`/`permission`/`resource`/`action` como entidades propias — hoy `role` en `AccountMemberEntity` sigue siendo un enum-array, no una FK), `Organization` separada de `OrganizationDetail`, mover `email`/`password` de `Users` a `Account`, `Collaborator` reemplazando `DocumentParticipant` con campos nuevos (`comments`, `geoLoc`, `visibilityLevel`, `cancellationReason`, `reminderPeriodicity`, `signatureType`), `Watcher`/`Notification`/`Event`, `verification_code`, `SimpleSignature`/`FIELSignature`, `Document Transaction`. **Nota**: ya se implementó una porción acotada de multi-cuenta (creación de organización, catálogo de cuentas cacheado en Redis, membresías con rol nullable) — ver "Resuelto en esta ronda" más abajo — pero es explícitamente un paso intermedio, no la migración RBAC completa. Sigue sin tocarse el login/JWT (`sub`/`email`/`roles`/`nationalId`, sin claims de cuenta/organización activa).
- **`roleId` de una organización nunca se asigna desde ningún flujo de producto**: `createOrganization` deja `AccountMemberEntity.role = NULL` a propósito (ver Escenario 1 de la historia de creación de organización), pero **no existe ninguna pantalla que llame** `PATCH /account-member/:id` para asignarlo después — solo es alcanzable a mano vía Swagger/Postman. El dueño de una organización recién creada queda con rol `NULL` indefinidamente en la práctica.
- **`account`/`account-member` sin ownership check**: ambos módulos están `@Public()` protegidos solo por `x-api-key` (no JWT), así que cualquier llamador con la API key puede leer/otorgar/revocar/actualizar la membresía de **cualquier** cuenta, no solo las propias. Antes de que este modelo multi-tenant maneje datos reales de clientes hace falta exigir JWT + validar que el llamador sea OWNER/ADMIN de la cuenta objetivo.
- **El catálogo de cuentas no expone `role`/`isActive` de la membresía**: `AccountService.toCatalogEntry()` solo serializa `id`/`name`/`type`/`createdAt`/`organizationDetail.name`. El frontend (`useAuthStore`, `accountsList`) espera un `roleId`/`status` por cuenta y hoy los rellena con valores por defecto (`null`/`'ACTIVE'`) porque el backend no se los manda — ver README de `signature-app`. Extender `appendAccountToCatalog`/`toCatalogEntry` para incluir el `role`/`isActive` reales de la membresía cerraría esto sin necesitar el RBAC completo.
- **Migración `MakeAccountMemberRoleNullable` sin confirmar contra una base con datos reales**: se generó y se verificó que aplica limpio (`ALTER COLUMN role DROP NOT NULL`), pero solo se corrió contra el esquema de desarrollo. Si ya hay un ambiente de staging/producción, `migrationsRun: true` la aplicará sola al desplegar — no requiere acción manual, pero vale confirmarlo la primera vez.
- **Kafka sin caso de uso de negocio para el consumidor**: `DocumentEventsConsumer` hoy solo loggea los eventos de forma estructurada. Falta decidir una acción real (p. ej. desacoplar el envío de emails del request síncrono, alimentar un dashboard, disparar webhooks a terceros).
- **`OTPService`**: implementado pero deliberadamente sin integrar a ningún flujo (decisión del equipo, no es un olvido).
- **Cobertura de tests parcial**: `user.service.spec.ts` y `document.service.spec.ts` (y ahora `account.service.spec.ts`) ya cubren comportamiento real (éxito + errores). El resto de specs (`audit`, `account-member`, etc.) siguen siendo smoke tests (`should be defined`). Pendiente extender el mismo patrón de tests de comportamiento al resto de servicios si se quiere subir la cobertura real. Tampoco hay un e2e que ejercite el flujo completo registro→login→onboarding→crear organización (`test/app.e2e-spec.ts` sigue siendo el scaffold por defecto de Nest).
- **Migración baseline generada contra una base vacía de desarrollo**: `src/migrations/*-InitialSchema.ts` se generó reseteando el schema `public` de la base de dev (confirmado como desechable). Si este proyecto ya tiene un ambiente de staging/producción con datos reales, esa migración **no** debe correrse ahí tal cual — habría que generar una migración de diff real contra ese ambiente, o revisar la baseline a mano antes de aplicarla.

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
El frontend (`signature-app`) consume `PUT /api/v1/users/me/personal-information` para `phoneNumber` y `secondaryEmail` desde `/personal-documents` (ruta movida desde el `PATCH /user/personal-information` original, ver "Resuelto en esta ronda" arriba). `name`, `lastName`, `curp`, `rfc` no tienen UI de edición **por diseño** (no es una tarea pendiente, es la decisión tomada). También consume `GET /api/v1/users/me`, `GET /api/v1/accounts/me`, `POST /api/v1/organizations` y `PUT /api/v1/users/me/signature` para el onboarding y el switcher multi-tenant, con un store de Zustand (`useAuthStore`, Slices Pattern). Ver pendientes propios del README de `signature-app` (incluye una dependencia futura de la migración RBAC/multi-cuenta completa, y los gaps de `roleId`/`status` que dependen de que este backend los exponga).
