export enum EmailSubject {
    VERIFICATION = 'Código de verificación',
    SIGNATURE_REQUEST = 'Nuevo documento pendiente de firma',
    DOCUMENT_PENDING = 'Documento enviado para autorización',
    CANCELLATION_PENDING = 'Solicitud de cancelación de documento',
    CANCELLATION_CODE = 'Código de verificación para cancelación',
    REJECTION_CODE = 'Código de verificación para rechazo',
}