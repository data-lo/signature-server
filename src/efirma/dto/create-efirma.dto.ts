export class CreateEfirmaDto {
    documento:Buffer;
    cerBuffer:Buffer;
    keyBuffer:Buffer;
    password: string;
    cadenaConfianzaSat: Buffer[];
}
