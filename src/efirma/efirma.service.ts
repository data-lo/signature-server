import { Injectable, Logger } from '@nestjs/common';
import {
  X509Certificate,
  KeyObject,
  createPrivateKey,
  createHash,
  createSign,
  createVerify,
} from 'node:crypto';
import { CertificateInfo } from './interfaces/certificate.interface';
import {
  CertificadoInvalidoException,
  LLaveNoCorrespondeCertificadoException,
  LLavePrivadaInvalidException,
} from './efirma.exceptions';
import { SignatureResult } from './interfaces/signature-result.interface';
import { CertificateValidationApiService } from './certificate-validation/certificate-validation-api.service';

/**
 * Firma con la e.firma del SAT.
 *
 * Desde la migración a Certificate Validation Service, aquí sólo queda lo que necesita la llave
 * privada (descifrarla, comprobar que corresponde al certificado y firmar) y la lectura de los
 * datos públicos del certificado. La vigencia, la cadena de confianza y la revocación OCSP se
 * validan en ese microservicio (ver `CertificateValidationApiService`): la llave privada y su
 * contraseña nunca salen de este servidor.
 */
@Injectable()
export class EfirmaService {
  private readonly logger = new Logger(EfirmaService.name);

  constructor(
    private readonly certificateValidationApiService: CertificateValidationApiService,
  ) {}

  parsearCertificado(cerBuffer: Buffer): CertificateInfo {
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(cerBuffer);
    } catch (err) {
      throw new CertificadoInvalidoException((err as Error).message);
    }

    const rfc = this.extaerRfcDeSubject(cert.subject);
    return {
      rfc,
      nombre: this.extraerCampoSubject(cert.subject, 'CN') ?? '',
      emisor: this.extraerCampoSubject(cert.issuer, 'O') ?? '',
      numeroCertificado: this.serialAFormatoSat(cert.serialNumber),
      numeroSerial: cert.serialNumber,
      vigenciaDesde: new Date(cert.validFrom),
      vigenciaHasta: new Date(cert.validTo),
      certificadoPem: cert.toString(),
      certificadoDer: cert.raw,
    };
  }

  private serialAFormatoSat(serialHex: string) {
    return BigInt(`0x${serialHex}`).toString();
  }

  private extaerRfcDeSubject(subject: string): string {
    const rfc =
      this.extraerCampoSubject(subject, 'x500UniqueIdentifier') ??
      this.extraerCampoSubject(subject, 'serialNumber');

    if (!rfc) {
      throw new CertificadoInvalidoException(
        'No se pudo extraer el RFC del certificado',
      );
    }

    return rfc.split(' ')[0].trim();
  }

  private extraerCampoSubject(
    subject: string,
    campo: string,
  ): string | undefined {
    const linea = subject.split('\n').find((l) => l.startsWith(`${campo}=`));
    return linea?.substring(campo.length + 1);
  }

  descifrarLlavePrivada(keyBuffer: Buffer, password: string): KeyObject {
    try {
      return createPrivateKey({
        key: keyBuffer,
        format: 'der',
        type: 'pkcs8',
        passphrase: Buffer.from(password, 'utf-8'),
      });
    } catch (error) {
      this.logger.warn(`Fallo al descifar .key ${(error as Error).message}`);
      throw new LLavePrivadaInvalidException((error as Error).message);
    }
  }

  validarParCertificadoLlave(cerBuffer: Buffer, privateKey: KeyObject): void {
    const cert = new X509Certificate(cerBuffer);
    const reto = createHash('sha256')
      .update(`reto-${Date.now()}-${Math.random()}`)
      .digest();
    const firmaReto = createSign('RSA-SHA256').update(reto).sign(privateKey);
    const esValida = createVerify('RSA-SHA256')
      .update(reto)
      .verify(cert.publicKey, firmaReto);
    if (!esValida) {
      throw new LLaveNoCorrespondeCertificadoException();
    }
  }

  calcularHashDocumento(documento: Buffer): string {
    return createHash('sha256').update(documento).digest('hex');
  }

  firmarDocumento(documento: Buffer, privateKey: KeyObject): string {
    return createSign('RSA-SHA256')
      .update(documento)
      .sign(privateKey)
      .toString('base64');
  }

  /**
   * Firma un documento con la e.firma del SAT.
   *
   * Un certificado inválido, expirado, revocado o cuya llave no corresponda detiene la firma. La
   * indisponibilidad del respondedor OCSP NO: se firma sin esa evidencia y el sellado queda
   * pendiente hasta poder obtenerla (ver `documents.sealing_pending_at`). La diferencia es entre
   * un "no" del SAT y un silencio del SAT.
   *
   * La vigencia, la cadena de confianza y la revocación se validan en Certificate Validation
   * Service con `allowUnverifiedRevocation`: si el SAT no responde, el servicio contesta 200 sin
   * `ocspEvidence` en vez de un error, y la firma continúa. Si el que no responde es el propio
   * microservicio, la firma NO continúa: no se sabría ni si el certificado está vigente.
   *
   * @param document - Contenido del documento a firmar.
   * @param cerBuffer - Certificado (.cer) del firmante.
   * @param keyBuffer - Llave privada (.key) cifrada, en DER PKCS#8.
   * @param password - Contraseña de la llave privada.
   * @returns La firma en Base64 con los datos públicos del certificado, y `ocspEvidence` sólo si el
   * SAT respondió.
   *
   * @throws {CertificadoInvalidoException} Si el certificado no es legible o no trae RFC.
   * @throws {CertificadoExpiradoException} Si el certificado está vencido o aún no vigente.
   * @throws {CadenaConfianzaInvalidaException} Si no encadena a una AC del SAT.
   * @throws {CertificadoRevocadoException} Si el SAT lo reporta revocado.
   * @throws {CertificateValidationServiceUnavailableException} Si no se pudo validar el certificado.
   * @throws {LLavePrivadaInvalidException} Si la contraseña no descifra la llave.
   * @throws {LLaveNoCorrespondeCertificadoException} Si la llave no corresponde al certificado.
   *
   * @example
   * ```ts
   * const result = await efirmaService.firmar(pdf, cerFile.buffer, keyFile.buffer, password);
   * const pendingSeal = !result.ocspEvidence;
   * ```
   */
  async firmar(
    document: Buffer,
    cerBuffer: Buffer,
    keyBuffer: Buffer,
    password: string,
  ): Promise<SignatureResult> {
    const infoCertificado = this.parsearCertificado(cerBuffer);
    const { ocspEvidence } =
      await this.certificateValidationApiService.validateCertificate(
        cerBuffer,
        { allowUnverifiedRevocation: true },
      );

    if (!ocspEvidence) {
      this.logger.warn(
        `El SAT no respondió la consulta OCSP del certificado ${infoCertificado.numeroCertificado}: ` +
          'se firma sin comprobación de revocación y el documento quedará pendiente de sellar.',
      );
    }

    const privateKey = this.descifrarLlavePrivada(keyBuffer, password);
    this.validarParCertificadoLlave(cerBuffer, privateKey);
    const signatureBase64 = this.firmarDocumento(document, privateKey);
    this.logger.log(
      `Documento firmado por RFC ${infoCertificado.rfc}, cert ${infoCertificado.numeroCertificado}`,
    );

    return {
      signatureBase64,
      algorithm: 'sha256',
      signedAt: new Date(),
      certificate: {
        rfc: infoCertificado.rfc,
        name: infoCertificado.nombre,
        issuer: infoCertificado.emisor,
        serialNumber: infoCertificado.numeroSerial,
        certificateNumber: infoCertificado.numeroCertificado,
        certificatePem: infoCertificado.certificadoPem,
      },
      /**
       * Se omite la propiedad —no se deja en `undefined`— cuando el SAT no respondió: antes de la
       * migración se leía `ocspEvidence.status` sin comprobar, y justo en ese caso la firma
       * reventaba con un TypeError en vez de quedar pendiente de sellar.
       */
      ...(ocspEvidence && { ocspEvidence }),
    };
  }
}
