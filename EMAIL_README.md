# Email Service with SendGrid

Este módulo proporciona servicios de envío de emails utilizando SendGrid en tu aplicación NestJS.

## Instalación

Primero, instala las dependencias necesarias:

```bash
npm install @sendgrid/mail @nestjs/config class-validator class-transformer
```

## Configuración

1. Crea un archivo `.env` en la raíz del proyecto con las siguientes variables:

```env
SENDGRID_API_KEY=tu_clave_api_de_sendgrid
SENDGRID_FROM_EMAIL=noreply@tudominio.com
FRONTEND_URL=http://localhost:3000
```

2. Obtén tu API Key de SendGrid desde [https://app.sendgrid.com/settings/api_keys](https://app.sendgrid.com/settings/api_keys)

## Uso

### Inyección del Servicio

```typescript
import { EmailService } from './email/email.service';

@Injectable()
export class UserService {
  constructor(private emailService: EmailService) {}

  async createUser(userData: CreateUserDto) {
    // Crear usuario...
    await this.emailService.sendWelcomeEmail(userData.email, userData.name);
  }
}
```

### Métodos Disponibles

#### `sendEmail(to: string, subject: string, html: string, from?: string)`
Envía un email personalizado.

```typescript
await emailService.sendEmail(
  'usuario@example.com',
  'Asunto del email',
  '<h1>Contenido HTML</h1>',
  'remitente@ejemplo.com' // opcional
);
```

#### `sendWelcomeEmail(to: string, userName: string)`
Envía un email de bienvenida.

```typescript
await emailService.sendWelcomeEmail('usuario@example.com', 'Juan Pérez');
```

#### `sendPasswordResetEmail(to: string, resetToken: string)`
Envía un email para restablecer contraseña.

```typescript
await emailService.sendPasswordResetEmail('usuario@example.com', 'token123');
```

#### `sendSignatureNotification(to: string, documentName: string, signerName: string)`
Envía una notificación de documento pendiente de firma.

```typescript
await emailService.sendSignatureNotification(
  'usuario@example.com',
  'Contrato de Servicios',
  'Juan Pérez'
);
```

## Endpoints API

### POST /email/send

Envía un email personalizado a través de la API.

**Body:**
```json
{
  "to": "destinatario@example.com",
  "subject": "Asunto del email",
  "html": "<h1>Contenido HTML</h1>",
  "from": "remitente@ejemplo.com" // opcional
}
```

**Respuesta:**
```json
{
  "message": "Email sent successfully"
}
```

## Estructura de Archivos

```
src/email/
├── dto/
│   └── send-email.dto.ts
├── email.controller.ts
├── email.module.ts
├── email.service.ts
└── email.service.spec.ts (pendiente)
```

## Notas

- Asegúrate de configurar correctamente tu dominio en SendGrid para evitar que los emails vayan a spam.
- Los emails de bienvenida y notificaciones están predefinidos pero pueden personalizarse.
- El servicio incluye manejo básico de errores y logging.