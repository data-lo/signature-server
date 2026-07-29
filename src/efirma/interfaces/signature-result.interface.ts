
export interface SignatureResult {
    
    hashDocumentoOriginal: string;
    firmaBase64: String;
    algoritmo: 'sha256';
    firmadoEn: Date;
    certificado:{
        rfc: string;
        nombre: string;
        numeroCertificado: string;
        certificadoPem: string;
    }
}