import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { DocumentEntity } from './entities/document.entity';
import { Repository } from 'typeorm';

@Injectable()
export class DocumentService {

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>
  ) { }

  create(createDocumentDto: CreateDocumentDto) {
    return 'This action adds a new document';
  }

  findAll() {
    return `This action returns all document`;
  }

  async findOne(documentId: string): Promise<DocumentEntity> {
    return this.documentRepository.findOne({ where: { id: documentId } });
  }

  update(id: number, updateDocumentDto: UpdateDocumentDto) {
    return `This action updates a #${id} document`;
  }

  remove(id: number) {
    return `This action removes a #${id} document`;
  }
}
