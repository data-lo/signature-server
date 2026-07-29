export interface CertificateInfo {
    rfc: string;
    nombre: string;
    numeroCertificado: string;
    numeroSerial: string;
    emisor: string;
    vigenciaDesde: Date;
    vigenciaHasta: Date;
    certificadoPem: string;
    certificadoDer: Buffer;
}