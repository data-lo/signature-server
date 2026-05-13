import { ApiProperty } from "@nestjs/swagger";

export class SignatureResponse {
    @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', description: 'UUID de la firma', format: 'uuid' })
    id: string;

    @ApiProperty({ example: 'https://storage.example.com/firma.png?token=...', description: 'URL segura de la firma' })
    secureUrl: string;

    @ApiProperty({ example: 86400, description: 'Tiempo de expiración de la URL en segundos' })
    expiresIn: number;
}