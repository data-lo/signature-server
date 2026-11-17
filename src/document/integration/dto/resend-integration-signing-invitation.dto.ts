import { CreateIntegrationSigningAccessDto } from './create-integration-signing-access.dto';

/**
 * A quién se le reenvía la invitación: el correo del firmante, con las mismas reglas que el acceso
 * temporal. Sólo LOCALIZA al colaborador dentro del documento.
 */
export class ResendIntegrationSigningInvitationDto extends CreateIntegrationSigningAccessDto {}
