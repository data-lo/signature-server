import { IsString } from "class-validator";

export class CreateEfirmaDto {
    documento:Buffer;
    cerBuffer:Buffer;
    keyBuffer:Buffer;
    
    @IsString()
    password: string;
}
