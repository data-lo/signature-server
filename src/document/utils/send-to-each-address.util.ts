import { CollaboratorEntity } from '../entities/collaborator.entity';
import { collaboratorEmail } from './collaborator-display.util';

/**
 * Manda un correo por dirección —la primera vez que aparece, sin distinguir mayúsculas— y deja
 * que cada envío falle por su cuenta: `allSettled` en vez de `all`, para que el correo que falla
 * no se lleve por delante a los demás.
 *
 * @param collaborators - Destinatarios, en el orden en que se quiere enviar.
 * @param send - Cómo se le manda el correo a uno de ellos.
 * @param onError - Qué hacer con cada envío fallido (registrarlo).
 * @param skipAddresses - Direcciones que no deben recibir este correo (p. ej. el creador, que
 *   recibe su propia versión).
 * @returns Nada.
 *
 * @example
 * ```ts
 * await sendToEachAddress(collaborators, (c, to) => email.send(to), (to, e) => log(to, e));
 * ```
 */
export async function sendToEachAddress(
  collaborators: CollaboratorEntity[],
  send: (collaborator: CollaboratorEntity, to: string) => Promise<void>,
  onError: (to: string, error: unknown) => void,
  skipAddresses: string[] = [],
): Promise<void> {
  const seen = new Set(skipAddresses.map((address) => address.toLowerCase()));
  const deliveries: Array<{ to: string; delivery: Promise<void> }> = [];

  for (const collaborator of collaborators) {
    const to = collaboratorEmail(collaborator);
    const key = to.toLowerCase();
    if (!to || seen.has(key)) continue;
    seen.add(key);
    // `Promise.resolve().then` para que un `send` que lance en síncrono también quede como un
    // envío fallido más, y no corte el ciclo.
    deliveries.push({
      to,
      delivery: Promise.resolve().then(() => send(collaborator, to)),
    });
  }

  const results = await Promise.allSettled(
    deliveries.map(({ delivery }) => delivery),
  );
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      onError(deliveries[index].to, result.reason);
    }
  });
}
