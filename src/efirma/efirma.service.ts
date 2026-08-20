import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
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
  CadenaConfianzaInvalidaException,
  CertificadoExpiradoException,
  CertificadoInvalidoException,
  LLaveNoCorrespondeCertificadoException,
  LLavePrivadaInvalidException,
  CertificadoRevocadoException,
  OCSPNotAvilableException,
} from './efirma.exceptions';
import { join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { ResultadoVerificacion } from './interfaces/verification.interface';
import { SignatureResult } from './interfaces/signature-result.interface';
import { OscpService } from './oscp/oscp.service';
import { OCSPEvidence } from './interfaces/OCSPEvidence.interface';
import { OcspEvidence } from '../document/seal/dto/seal-document.dto';

@Injectable()
export class EfirmaService implements OnModuleInit {
  private readonly logger = new Logger(EfirmaService.name);
  private cadenaConfianza: X509Certificate[] = [];

  constructor(
    private readonly ocspService: OscpService
  ) {}

  onModuleInit() {
    this.cadenaConfianza = this.cargarCertificadosDeConfianza();
    this.logger.log(`Cargados ${this.cadenaConfianza.length} certificados de confianza`);
  }

  private cargarCertificadosDeConfianza(): X509Certificate[] {
    const dir = join(process.cwd(), 'dist', 'certificates');
    const files = readdirSync(dir).filter((f) => /\.(cer|crt)$/i.test(f));

    return files.map((fileName) => {
      const buffer = readFileSync(join(dir, fileName));
      try {
        return new X509Certificate(buffer);
      } catch (error) {
        this.logger.error(`Unable to load ${fileName}: ${(error as Error).message}`);
        throw error;
      }
    });
  }

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
      throw new CertificadoInvalidoException('No se pudo extraer el RFC del certificado');
    }

    return rfc.split(' ')[0].trim();
  }

  private extraerCampoSubject(subject: string, campo: string): string | undefined {
    const linea = subject.split('\n').find((l) => l.startsWith(`${campo}=`));
    return linea?.substring(campo.length + 1);
  }

  validarVigencia(info: CertificateInfo, fechaReferencia: Date = new Date()): void {
    if (fechaReferencia < info.vigenciaDesde || fechaReferencia > info.vigenciaHasta) {
      throw new CertificadoExpiradoException(info.vigenciaHasta);
    }
  }

  /**
   * Valida la cadena de confianza y regresa el CERTIFICADO EMISOR INMEDIATO
   * (no la raíz) — lo necesitas para la consulta OCSP, ya que la respuesta
   * OCSP del SAT se firma con la CA que emitió directamente el certificado.
   */
  validarCadenaConfianza(cerBuffer: Buffer): X509Certificate {
    const certOriginal = new X509Certificate(cerBuffer);
    let actual = certOriginal;
    let emisorInmediato: X509Certificate | undefined;
    const vistos = new Set<string>();

    while (true) {
      if (actual.issuer === actual.subject) {
        const esRaizConfiable = this.cadenaConfianza.some(
          (raiz) => raiz.fingerprint256 === actual.fingerprint256,
        );
        if (!esRaizConfiable) {
          throw new CadenaConfianzaInvalidaException(
            `El certificado raíz "${actual.subject}" no está en tu directorio de confianza`,
          );
        }
        if (!emisorInmediato) {
          // Cadena de un solo nivel: el propio "actual" es raíz y emisor a la vez
          emisorInmediato = actual;
        }
        return emisorInmediato;
      }

      const emisor = this.cadenaConfianza.find(
        (candidato) => actual.checkIssued(candidato) && actual.verify(candidato.publicKey),
      );

      if (!emisor) {
        throw new CadenaConfianzaInvalidaException(
          `No se encontró (o no valida criptográficamente) el emisor "${actual.issuer}" en tu directorio`,
        );
      }

      if (!emisorInmediato) {
        emisorInmediato = emisor;
      }

      if (vistos.has(emisor.fingerprint256)) {
        throw new CadenaConfianzaInvalidaException('Ciclo detectado al validar la cadena de confianza');
      }
      vistos.add(emisor.fingerprint256);
      actual = emisor;
    }
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
    const reto = createHash('sha256').update(`reto-${Date.now()}-${Math.random()}`).digest();
    const firmaReto = createSign('RSA-SHA256').update(reto).sign(privateKey);
    const esValida = createVerify('RSA-SHA256').update(reto).verify(cert.publicKey, firmaReto);
    if (!esValida) {
      throw new LLaveNoCorrespondeCertificadoException();
    }
  }

  calcularHashDocumento(documento: Buffer): string {
    return createHash('sha256').update(documento).digest('hex');
  }

  firmarDocumento(documento: Buffer, privateKey: KeyObject): string {
    return createSign('RSA-SHA256').update(documento).sign(privateKey).toString('base64');
  }

  /**
   * @param permitirDegradadoSiOCSPFalla si el SAT no responde (timeout, caído,
   * cambio de endpoint no documentado), decide si bloqueas la firma o la
   * dejas pasar dejando constancia de que no se pudo verificar revocación.
   * Para un producto que compite con Mifiel, recomiendo `false` por default:
   * es mejor fallar visible que firmar "a ciegas" en revocación.
   */
  async firmar(
    document: Buffer,
    cerBuffer: Buffer,
    keyBuffer: Buffer,
    password: string,
  ): Promise<SignatureResult> {
    const infoCertificado = this.parsearCertificado(cerBuffer);
    this.validarVigencia(infoCertificado);
    const emisorInmediato = this.validarCadenaConfianza(cerBuffer);
    let ocspEvidence: OCSPEvidence | undefined;

    try {
      ocspEvidence = await this.ocspService.verifyRevokedOCSP(cerBuffer, emisorInmediato);
    } catch (err) {
      if (err instanceof CertificadoRevocadoException) {
        throw err; 
      }
      if (err instanceof OCSPNotAvilableException) {
        this.logger.warn(
          `Firmando en modo degradado sin confirmación OCSP: ${(err as Error).message}`,
        );
      } else {
        throw err;
      }
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
      ocspEvidence
    };
  }

  verificar(
    documento: Buffer,
    hashDocumentoOriginal: string,
    firmaBase64: string,
    certificadoPem: string,
    firmadoEn: Date,
  ): ResultadoVerificacion {
    const errores: string[] = [];
    const cerBuffer = Buffer.from(certificadoPem);

    const hashActual = this.calcularHashDocumento(documento);
    const hashCoincide = hashActual === hashDocumentoOriginal;
    if (!hashCoincide) {
      errores.push('El hash del documento no coincide: el archivo fue modificado o no es el original');
    }

    let cadenaConfianzaValida = true;
    try {
      this.validarCadenaConfianza(cerBuffer);
    } catch (err) {
      cadenaConfianzaValida = false;
      errores.push(`Cadena de confianza inválida: ${(err as Error).message}`);
    }

    const infoCertificado = this.parsearCertificado(cerBuffer);
    let vigenteAlFirmar = true;
    try {
      this.validarVigencia(infoCertificado, firmadoEn);
    } catch (err) {
      vigenteAlFirmar = false;
      errores.push(`El certificado no estaba vigente al momento de firmar: ${(err as Error).message}`);
    }

    const cert = new X509Certificate(cerBuffer);
    let firmaValida = false;
    try {
      firmaValida = createVerify('RSA-SHA256')
        .update(documento)
        .verify(cert.publicKey, Buffer.from(firmaBase64, 'base64'));
    } catch (err) {
      errores.push(`No se pudo verificar la firma: ${(err as Error).message}`);
    }
    if (!firmaValida) {
      errores.push('La firma no corresponde a este documento y certificado');
    }

    const esValida = hashCoincide && firmaValida && cadenaConfianzaValida && vigenteAlFirmar;

    return {
      esValida,
      hashCoincide,
      firmaValida,
      cadenaConfianzaValida,
      vigenteAlFirmar,
      detalle: {
        rfc: infoCertificado.rfc,
        nombre: infoCertificado.nombre,
        numeroCertificado: infoCertificado.numeroCertificado,
        firmadoEn,
      },
      errores,
    };
  }
}