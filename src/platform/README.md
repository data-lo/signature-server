# Módulo Platform

## Objetivo

Este módulo es el **control plane privado** de Firmalo. Su responsabilidad actual es dejar una
organización lista para consumir la API de integración documental sin pasar por el registro de la
aplicación web, Stripe, CAPTCHA, OTP ni una contraseña de usuario.

No forma parte de la API de integración que usa un cliente final (`/api/v1/integration/*`). La
operación la ejecuta un sistema propio de plataforma o backoffice, con una credencial distinta a
las keys `fma_live_*` de cada organización.

## Qué aprovisiona

`POST /api/v1/platform/organizations/provision` crea, en una sola transacción:

```text
Usuario PROVISIONED
  └─ cuenta personal
Organización activa
  └─ membresía OWNER para el propietario
Perfil de facturación MANUAL
  └─ periodo Enterprise con créditos de documentos
API key de integración fma_live_*
```

Si cualquiera de esos pasos falla, la transacción se revierte por completo: no quedan
organizaciones, créditos ni API keys creadas parcialmente.

El backend decide el plan (`enterprise`), el importe manual (`0 MXN`), el origen de facturación y
los permisos de la API key. El consumidor sólo proporciona los datos de organización,
propietario, periodo, créditos y el nombre administrativo de la key.

## Frontera de seguridad

- La ruta exige `x-api-key: <INTERNAL_PLATFORM_API_KEY>` mediante `@InternalPlatformAuth()`.
  No acepta JWT de un usuario, la `API_KEY` general de servicios ni una `fma_live_*`.
- El controller se excluye del Swagger público con `@ApiExcludeController()`.
- Emitir una API key requiere `INTEGRATION_API_KEY_HMAC_SECRET`; el servidor guarda sólo la huella
  HMAC de su secreto, no la key completa.
- La key completa sólo aparece en la primera respuesta exitosa. El sistema que llama debe guardar
  `data.apiKey` de inmediato en un almacén seguro.

## Idempotencia

El header `Idempotency-Key` es obligatorio en el aprovisionamiento. El sistema de plataforma debe
generarlo una vez por operación y reutilizarlo ante timeouts o reintentos.

- Misma clave y mismo payload: responde lo ya creado, sin duplicar recursos; `apiKey` es `null`.
- Misma clave y payload distinto: responde `409 IDEMPOTENCY_KEY_MISMATCH`.
- Una nueva operación debe usar una nueva clave y un `billing.externalReference` distinto.

## Estructura

| Archivo o carpeta                                  | Responsabilidad                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `platform.module.ts`                               | Integra las dependencias de cuentas, roles, facturación y API keys.                |
| `internal-organization-provisioning.controller.ts` | Expone y protege el endpoint, valida headers y evita campos que decide el backend. |
| `applications/`                                    | Orquesta el aprovisionamiento transaccional y la idempotencia.                     |
| `services/`                                        | Crea o reutiliza al propietario provisional.                                       |
| `dto/`                                             | Define y valida el contrato de entrada.                                            |
| `constants/`                                       | Declara las condiciones fijas Enterprise y el perfil de permisos de integración.   |
| `entities/`                                        | Guarda la huella de cada aprovisionamiento para resolver reintentos.               |
| `exceptions/`                                      | Expone errores de negocio estables para el consumidor de plataforma.               |

## Cambios futuros

Si se cambia el prefijo público de estas operaciones, la intención del módulo se conserva: debe
seguir siendo una API privada de plataforma, separada de `/integration/*` y de las rutas usadas por
usuarios autenticados de una organización.
