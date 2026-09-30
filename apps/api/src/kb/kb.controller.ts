import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  PayloadTooLargeException,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type CreateKbDocumentInput,
  createKbDocumentSchema,
  type CurrentUser,
  type KbSearchQuery,
  kbSearchQuerySchema,
  listKbDocumentsQuerySchema,
  setKbStatusSchema,
  type UpdateKbDocumentInput,
  updateKbDocumentSchema,
  uploadKbFieldsSchema,
} from '@tms/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { Ctx, type RequestCtx, RequirePermission, User } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { KbSearchService } from './kb-search.service';
import { KbService } from './kb.service';

interface UploadedFile {
  filename: string;
  contentType: string;
  content: Buffer;
  fields: Record<string, string>;
}

/** Reads the single file of a multipart request, with its text fields. */
async function readUpload(req: FastifyRequest): Promise<UploadedFile> {
  if (!req.isMultipart()) throw new BadRequestException('Send the file as multipart/form-data');
  const part = await req.file();
  if (!part) throw new BadRequestException('No file in the request');
  const content = await part.toBuffer();
  if (part.file.truncated) throw new PayloadTooLargeException('The file is larger than 20 MB');
  const fields: Record<string, string> = {};
  for (const [name, field] of Object.entries(part.fields)) {
    const f = Array.isArray(field) ? field[0] : field;
    if (f && f.type === 'field' && typeof f.value === 'string') fields[name] = f.value;
  }
  return { filename: part.filename, contentType: part.mimetype, content, fields };
}

@ApiTags('knowledge base')
@ApiBearerAuth()
@Controller('kb')
export class KbController {
  constructor(
    private readonly kb: KbService,
    private readonly search: KbSearchService,
  ) {}

  /** Hybrid search with citations. `audience=customer` keeps to public documents. */
  @Get('search')
  @RequirePermission('kb:read')
  find(@User() user: CurrentUser, @Query(new ZodPipe(kbSearchQuerySchema)) q: KbSearchQuery) {
    return this.search.search({ user }, q);
  }

  @Get('documents')
  @RequirePermission('kb:read')
  list(
    @User() user: CurrentUser,
    @Query(new ZodPipe(listKbDocumentsQuerySchema)) q: z.infer<typeof listKbDocumentsQuerySchema>,
  ) {
    return this.kb.list(user, q);
  }

  @Get('documents/:id')
  @RequirePermission('kb:read')
  get(@User() user: CurrentUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.kb.get(user, id);
  }

  @Get('documents/:id/file')
  @RequirePermission('kb:read')
  async file(
    @User() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const { stream, doc } = await this.kb.file(user, id);
    void res.header('content-type', doc.contentType ?? 'application/octet-stream');
    void res.header(
      'content-disposition',
      `inline; filename="${encodeURIComponent(doc.filename ?? 'document')}"`,
    );
    return new StreamableFile(stream);
  }

  /** FAQ entries, text and URLs. Files use POST /kb/documents/upload. */
  @Post('documents')
  @RequirePermission('kb:manage')
  create(
    @Ctx() ctx: RequestCtx,
    @Body(new ZodPipe(createKbDocumentSchema)) body: CreateKbDocumentInput,
  ) {
    return this.kb.create(ctx, body);
  }

  /** multipart/form-data: `file`, plus optional `title`, `visibility`, `teamId`, `language`. */
  @Post('documents/upload')
  @RequirePermission('kb:manage')
  async upload(@Ctx() ctx: RequestCtx, @Req() req: FastifyRequest) {
    const file = await readUpload(req);
    const fields = new ZodPipe(uploadKbFieldsSchema).transform({
      ...file.fields,
      teamId: file.fields.teamId || null,
      language: file.fields.language || null,
    });
    return this.kb.upload(ctx, file, fields);
  }

  /** A new file for a file document (a new version). */
  @Post('documents/:id/upload')
  @RequirePermission('kb:manage')
  async replaceFile(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.kb.replaceFile(ctx, id, await readUpload(req));
  }

  @Patch('documents/:id')
  @RequirePermission('kb:manage')
  update(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateKbDocumentSchema)) body: UpdateKbDocumentInput,
  ) {
    return this.kb.update(ctx, id, body);
  }

  /** Review state: draft, approved (searchable) or archived. */
  @Post('documents/:id/status')
  @HttpCode(200)
  @RequirePermission('kb:manage')
  setStatus(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(setKbStatusSchema)) body: z.infer<typeof setKbStatusSchema>,
  ) {
    return this.kb.setStatus(ctx, id, body.status);
  }

  @Post('documents/:id/reindex')
  @HttpCode(202)
  @RequirePermission('kb:manage')
  reindexOne(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.kb.requestReindex(ctx, id);
  }

  @Post('reindex')
  @HttpCode(202)
  @RequirePermission('kb:manage')
  reindexAll(@Ctx() ctx: RequestCtx) {
    return this.kb.requestReindex(ctx);
  }

  @Delete('documents/:id')
  @HttpCode(204)
  @RequirePermission('kb:manage')
  async remove(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) {
    await this.kb.delete(ctx, id);
  }
}
