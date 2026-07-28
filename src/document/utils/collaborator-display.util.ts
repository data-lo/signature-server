import { CollaboratorEntity } from '../entities/collaborator.entity';

/** Nombre a mostrar de un colaborador: el de su cuenta si existe, o su email si fue invitado solo por correo. */
export function collaboratorDisplayName(
  collaborator: CollaboratorEntity,
): string {
  if (collaborator.account?.user) {
    return `${collaborator.account.user.firstName} ${collaborator.account.user.lastName}`;
  }
  if (collaborator.firstName || collaborator.lastName) {
    return `${collaborator.firstName ?? ''} ${collaborator.lastName ?? ''}`.trim();
  }
  return collaborator.email ?? '';
}

/** Email de contacto de un colaborador: el de su cuenta si existe, o el email con el que fue invitado. */
export function collaboratorEmail(collaborator: CollaboratorEntity): string {
  return collaborator.account?.user?.email ?? collaborator.email ?? '';
}
