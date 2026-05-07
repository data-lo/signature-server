import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

@Injectable()
export class HashService {

  CIPHER_KEY:any;

  constructor(){
    this.setCipherKey();
  }

  private setCipherKey(){
    if(!process.env.CIPHER_SECRET){
      throw new Error('Variable de Entorno de CHIPHER_SECRET para el Hash Service no están configuradas');
    }
    if(!this.CIPHER_KEY){
      this.CIPHER_KEY = crypto.createHash('sha256')
      .update(process.env.CIPHER_SECRET)
      .digest()
    }
    return;
  }

  async generateFilesHash(files: Express.Multer.File[]): Promise<string[]> {
    try {
      const hashes = [];
      files.forEach(async (file) => {
        hashes.push(await this.generateFileHash(file));
      });
      return hashes;
    } catch (error) {
      throw new Error(`Error: ${error}`);
    }
  }

  async generateFileHash(file: Express.Multer.File): Promise<string> {
    const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
    return hash;
  }

  async generateRegistryHash(registryContent: Object): Promise<string> {
    const normalizedContent = JSON.stringify(
      registryContent,
      Object.keys(registryContent).sort(),
    );

    const hash = crypto.createHash('sha256')
    .update(normalizedContent)
    .digest('hex');

    return hash
  }

  async generateCiperHash(cipherContent: Object): Promise<string> {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm',this.CIPHER_KEY,iv);
    const serialized = JSON.stringify(cipherContent);
    const encrypted = Buffer.concat([
        cipher.update(serialized,'utf-8'),
        cipher.final()
    ])
    const authTag = cipher.getAuthTag();
    return [
        iv.toString('base64'),
        authTag.toString('base64'),
        encrypted.toString('base64')
    ].join(':');
  }

  async reverseCiperHash(cipherHash: string): Promise<object> {
    const [ivB64,authTagB64,encryptedB64] = cipherHash.split(':');
    
    const iv = Buffer.from(ivB64,'base64');
    const authTag = Buffer.from(authTagB64,'base64');
    const encrypted = Buffer.from(encryptedB64,'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm',this.CIPHER_KEY,iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
    ]);
    return JSON.parse(decrypted.toString('utf8'));
  }

}
