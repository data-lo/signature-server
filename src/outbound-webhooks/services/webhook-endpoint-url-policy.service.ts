import { Injectable } from '@nestjs/common';
import { lookup } from 'dns/promises';
import { BlockList, isIP } from 'net';

import {
  WEBHOOK_URL_REJECTION_REASON_ENUM,
  WebhookUrlNotAllowedException,
} from '../exceptions/outbound-webhook.exceptions';

/** Longitud máxima de la URL de destino. */
export const WEBHOOK_URL_MAX_LENGTH = 2048;

/**
 * Rangos a los que un webhook nunca se envía: privados, loopback, link-local (incluidos los
 * metadatos de nube, `169.254.169.254` y `fd00:ec2::254`), CGNAT, documentación, multicast y
 * reservados. Un destino así permitiría usar el emisor para alcanzar la red interna (SSRF).
 */
const BLOCKED_ADDRESSES = (() => {
  const blockList = new BlockList();
  for (const [network, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const) {
    blockList.addSubnet(network, prefix, 'ipv4');
  }
  for (const [network, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['64:ff9b::', 96],
    ['100::', 64],
    ['2001:db8::', 32],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ] as const) {
    blockList.addSubnet(network, prefix, 'ipv6');
  }
  return blockList;
})();

/** Sufijos de nombres que sólo existen en redes internas. */
const BLOCKED_HOST_SUFFIXES = ['localhost', 'local', 'internal', 'localdomain'];

/**
 * Decide si una URL es un destino permitido para los webhooks salientes.
 *
 * Sólo `https://` en el puerto 443, sin usuario ni contraseña en la URL, a un host público. Al
 * configurar se resuelve el DNS y se rechaza si alguna dirección cae en un rango bloqueado; el
 * envío debe volver a comprobarlo, porque el DNS puede cambiar después.
 */
@Injectable()
export class WebhookEndpointUrlPolicy {
  /**
   * Valida la URL y la devuelve normalizada.
   *
   * @param rawUrl - URL que envió el cliente.
   * @returns La URL normalizada por `URL` (host en minúsculas, sin `:443` explícito ni fragmento).
   *
   * @throws {WebhookUrlNotAllowedException} Si la URL es inválida, no es `https`, usa otro puerto,
   *   trae credenciales, apunta a un host interno o no resuelve a direcciones públicas.
   *
   * @example
   * ```ts
   * await policy.assertAllowed('https://erp.cliente.com/webhooks/firmalo');
   * // 'https://erp.cliente.com/webhooks/firmalo'
   * ```
   */
  async assertAllowed(rawUrl: string): Promise<string> {
    const url = this.parse(rawUrl);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

    if (isIP(host)) {
      this.assertPublicAddress(host);
    } else {
      this.assertPublicHostname(host);
      const addresses = await this.resolve(host);
      for (const address of addresses) this.assertPublicAddress(address);
    }

    url.hash = '';
    return url.toString();
  }

  /**
   * Resuelve todas las direcciones del host. Aparte para poder sustituirlo en las pruebas.
   *
   * @param host - Nombre a resolver.
   * @returns Sus direcciones IPv4 e IPv6.
   *
   * @throws {WebhookUrlNotAllowedException} Si el nombre no resuelve.
   *
   * @example
   * ```ts
   * await policy.resolve('erp.cliente.com'); // ['203.0.114.10']
   * ```
   */
  async resolve(host: string): Promise<string[]> {
    try {
      const results = await lookup(host, { all: true, verbatim: true });
      if (results.length === 0) throw new Error('sin direcciones');
      return results.map((result) => result.address);
    } catch {
      throw new WebhookUrlNotAllowedException(
        WEBHOOK_URL_REJECTION_REASON_ENUM.HOST_NOT_RESOLVABLE,
        `El host ${host} no resuelve a ninguna dirección`,
      );
    }
  }

  private parse(rawUrl: string): URL {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new WebhookUrlNotAllowedException(
        WEBHOOK_URL_REJECTION_REASON_ENUM.INVALID_URL,
        'La URL del webhook no es válida',
      );
    }
    if (url.protocol !== 'https:') {
      throw new WebhookUrlNotAllowedException(
        WEBHOOK_URL_REJECTION_REASON_ENUM.HTTPS_REQUIRED,
        'La URL del webhook debe usar https://',
      );
    }
    // `URL` deja `port` vacío cuando es el de omisión del protocolo (443 en https).
    if (url.port !== '') {
      throw new WebhookUrlNotAllowedException(
        WEBHOOK_URL_REJECTION_REASON_ENUM.PORT_NOT_ALLOWED,
        'La URL del webhook sólo puede usar el puerto 443',
      );
    }
    if (url.username || url.password) {
      throw new WebhookUrlNotAllowedException(
        WEBHOOK_URL_REJECTION_REASON_ENUM.CREDENTIALS_NOT_ALLOWED,
        'La URL del webhook no puede llevar usuario ni contraseña',
      );
    }
    return url;
  }

  private assertPublicHostname(host: string): void {
    const labels = host.split('.');
    const isInternal =
      labels.length < 2 ||
      BLOCKED_HOST_SUFFIXES.includes(labels[labels.length - 1]);
    if (isInternal) {
      throw new WebhookUrlNotAllowedException(
        WEBHOOK_URL_REJECTION_REASON_ENUM.HOST_NOT_ALLOWED,
        `El host ${host} no es un destino público`,
      );
    }
  }

  private assertPublicAddress(address: string): void {
    const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    // Una IPv4 escrita como IPv6 (`::ffff:a.b.c.d`, que `URL` normaliza a `::ffff:7f00:1`) se
    // rechaza siempre: ningún destino legítimo la usa, y así no hay que traducirla para revisarla.
    // No va en `BLOCKED_ADDRESSES`: `BlockList` aplica las reglas IPv6 también a las IPv4 mapeadas
    // y bloquearía todas.
    const isMappedIpv4 = family === 'ipv6' && /^::ffff:/i.test(address);
    if (isMappedIpv4 || BLOCKED_ADDRESSES.check(address, family)) {
      throw new WebhookUrlNotAllowedException(
        WEBHOOK_URL_REJECTION_REASON_ENUM.HOST_NOT_ALLOWED,
        'La URL del webhook apunta a una dirección privada o reservada',
      );
    }
  }
}
