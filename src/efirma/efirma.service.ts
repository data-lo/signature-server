import { Injectable, Logger } from '@nestjs/common';
import {
  X509Certificate,
  KeyObject,
  createPrivateKey,
  createHash,
  createSign,
  createVerify
} from 'node:crypto'

import { CertificateInfo } from './interfaces/certificate.interface';
import { CadenaConfianzaInvalidaException, CertificadoExpiradoException, CertificadoInvalidoException, LLaveNoCorrespondeCertificadoException, LLavePrivadaInvalidException } from './efirma.exceptions';
import { CreateEfirmaDto } from './dto/create-efirma.dto';
import { Create } from 'sharp';
import { create } from 'node:domain';


@Injectable()
export class EfirmaService {
  private readonly logger = new Logger(EfirmaService.name)
  
  parsearCertificado(cerBuffer:Buffer):CertificateInfo{
    let cert:X509Certificate;
    try {
      cert = new X509Certificate(cerBuffer); 
    }catch(err){
      throw new CertificadoInvalidoException((err as Error).message)
    }
    const rfc = this.extaerRfcDeSubject(cert.subject);
    return {
      rfc,
      nombre: this.extraerCampoSubject(cert.subject, 'CN') ?? '',
      emisor: cert.issuer,
      numeroCertificado: this.serialAFormatoSat(cert.serialNumber),
      vigenciaDesde: new Date(cert.validFrom),
      vigenciaHasta: new Date(cert.validTo),
      certificadoPem: cert.toString(),
      certificadoDer: cert.raw,
    };
  }


  private serialAFormatoSat(serialHex: string){
    return BigInt(`0x${serialHex}`).toString();
  }

  private extaerRfcDeSubject(subject:string): string {
     const rfc =
      this.extraerCampoSubject(subject, 'x500UniqueIdentifier') ??
      this.extraerCampoSubject(subject, 'serialNumber');
 
    if (!rfc) {
      throw new CertificadoInvalidoException('No se pudo extraer el RFC del certificado');
    }
 
    // El SAT a veces concatena RFC+CURP en este campo; el RFC son los primeros 12-13 chars
    return rfc.split(' ')[0].trim();
  }

  private extraerCampoSubject(subject:string, campo:string): string | undefined {
    const linea = subject.split('\n').find((l) => l.startsWith(`${campo}=`));
    return linea?.substring(campo.length + 1);  
  }


  validarVigencia(info:CertificateInfo, fechaReferencia: Date = new Date()): void {
    if (fechaReferencia < info.vigenciaDesde || fechaReferencia > info.vigenciaHasta){
      throw new CertificadoExpiradoException(info.vigenciaHasta);
    }
  }

  validarCadenaConfianza(cerBuffer: Buffer, cadenaConfianza: Buffer[]): void {
    const cert = new X509Certificate(cerBuffer);
    const emisorEncontrado = cadenaConfianza.some((caCertBuffer) => {
      const caCert = new X509Certificate(caCertBuffer);
      return caCert.checkIssued(cert);
    });

    if(!emisorEncontrado){
      throw new CadenaConfianzaInvalidaException(
        `Emisor "${cert.issuer} no esta en la cadena de confianza cargada"`
      )
    };
  };

  descifrarLlavePrivada(keyBuffer: Buffer, password:string): KeyObject {
    
    try{
      return createPrivateKey({
        key:keyBuffer,
        format:'der',
        type:'pkcs8',
        passphrase: Buffer.from(password, 'utf-8'),
      })
    }catch(error){
      this.logger.warn(`Fallo al descifar .key ${(error as Error).message}`);
      throw new LLavePrivadaInvalidException((error as Error).message);
    }
  };

  validarParCertificadoLlave(cerBuffer: Buffer, privateKey: KeyObject): void {
    const cert = new X509Certificate(cerBuffer);
    const reto = createHash('sha256').update(`reto-${Date.now()}-${Math.random()}`).digest();
    
    const firmaReto = createSign('RSA-SHA256').update(reto).sign(privateKey);
    const esValida = createVerify('RSA-SHA256').update(reto).verify(cert.publicKey, firmaReto);
    if(!esValida){
      throw new LLaveNoCorrespondeCertificadoException();
    }
  }

  calcularHashDocumento(documento:Buffer): string {
    return createHash('sha256').update(documento).digest('hex');
  }

  firmarDocumento(documento:Buffer, privateKey:KeyObject):string {
    return createSign('RSA-SHA256').update(documento).sign(privateKey).toString('base64');
  }

  firmar(createEfirmaDto:CreateEfirmaDto){

    const {documento, cerBuffer, keyBuffer, password, cadenaConfianzaSat} = createEfirmaDto;
    const infoCertificado = this.parsearCertificado(cerBuffer);
    this.validarVigencia(infoCertificado);
    this.validarCadenaConfianza(cerBuffer, cadenaConfianzaSat);

    const privateKey = this.descifrarLlavePrivada(keyBuffer, password);
    this.validarParCertificadoLlave(cerBuffer,privateKey);

    const hashDocumentoOriginal = this.calcularHashDocumento(documento);
    const firmaBase64 = this.firmarDocumento(documento, privateKey);
    this.logger.log(
      `Documento firmado por RFC ${infoCertificado.rfc}, cert ${infoCertificado.numeroCertificado}`
    );

    return {
      hashDocumentoOriginal,
      firmaBase64,
      algoritmo: 'sha256',
      firmadoEn: new Date(),
      certificado: {
        rfc: infoCertificado.rfc,
        nombre: infoCertificado.nombre,
        numeroCertificado: infoCertificado.numeroCertificado,
        certificadoPem:infoCertificado.certificadoPem
      },
    };
  }
}
