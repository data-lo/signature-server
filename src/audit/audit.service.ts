import { Model } from 'mongoose';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';

import { CreateAuditDto } from './dto/create-audit.dto';
import { AuditDocument } from './schema/audit-document';

@Injectable()
export class AuditService {
  constructor(
    @InjectModel(AuditDocument.name)
    private readonly auditModel: Model<AuditDocument>,
  ) { }

  async create(createAuditDto: CreateAuditDto) {
    const previousDocument = await this.auditModel.findOne({
      documentId: createAuditDto.documentId
    });

    let chainIndex: number = 1;

    if (previousDocument) chainIndex = previousDocument.chainIndex + 1;

    return this.auditModel.create({
      ...createAuditDto,
      chainIndex
    });

  }
}