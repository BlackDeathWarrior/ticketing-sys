import { Controller, Get, HttpCode, Post, PayloadTooLargeException, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { WEB_FORM_MAX_FILE_BYTES, WEB_FORM_MAX_FILES, webFormSchema } from '@tms/shared';
import type { FastifyRequest } from 'fastify';
import { Public } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { type FormFile, WebFormService } from './web-form.service';

const MB = 1024 * 1024;

/**
 * Public endpoints behind the help center's "Submit a request" page. They
 * only ever create; nothing here reads a ticket back.
 */
@ApiTags('public')
@Public()
@Controller('public')
export class WebFormController {
  constructor(private readonly form: WebFormService) {}

  @Get('request-form')
  config() {
    return this.form.config();
  }

  /** multipart/form-data (fields plus up to 3 `files`), or JSON without files. */
  @Post('requests')
  @HttpCode(201)
  async submit(@Req() req: FastifyRequest) {
    const { fields, files } = req.isMultipart()
      ? await readForm(req)
      : { fields: (req.body ?? {}) as Record<string, unknown>, files: [] };
    const form = new ZodPipe(webFormSchema).transform(fields);
    return this.form.submit(form, files);
  }
}

async function readForm(req: FastifyRequest) {
  const fields: Record<string, string> = {};
  const files: FormFile[] = [];
  const parts = req.parts({
    // One more file than allowed, so the service can say how many are allowed.
    limits: { fileSize: WEB_FORM_MAX_FILE_BYTES, files: WEB_FORM_MAX_FILES + 1, fields: 20 },
  });
  try {
    for await (const part of parts) {
      if (part.type === 'field') {
        if (typeof part.value === 'string') fields[part.fieldname] = part.value;
        continue;
      }
      const content = await part.toBuffer();
      if (content.length) {
        files.push({ filename: part.filename, contentType: part.mimetype, content });
      }
    }
  } catch (err) {
    // @fastify/multipart signals size and count limits with a 413.
    if ((err as { statusCode?: number }).statusCode === 413) {
      throw new PayloadTooLargeException(
        `Each file can be up to ${WEB_FORM_MAX_FILE_BYTES / MB} MB, and at most ${WEB_FORM_MAX_FILES} files`,
      );
    }
    throw err;
  }
  return { fields, files };
}
