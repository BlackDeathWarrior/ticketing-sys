import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  type AttachmentRef,
  formatTicketNumber,
  WEB_FORM_MAX_FILE_BYTES,
  WEB_FORM_MAX_FILES,
  type WebForm,
  type WebFormConfig,
  type WebFormReceipt,
} from '@tms/shared';
import { InboundService } from '../channels/inbound.service';
import { OrgService } from '../org/org.service';
import { BrandingService } from '../settings/branding.service';
import { StorageService } from '../storage/storage.service';
import { TicketsService } from '../tickets/tickets.service';

export interface FormFile {
  filename: string;
  contentType: string;
  content: Buffer;
}

/**
 * The public request form: a channel adapter like email or chat. It turns a
 * submission into a `web_form` envelope for `InboundService`, which opens a
 * new ticket (the submission id is the thread key, so it never joins an
 * existing one). The acknowledgement email is sent by the worker.
 */
@Injectable()
export class WebFormService {
  constructor(
    private readonly inbound: InboundService,
    private readonly org: OrgService,
    private readonly tickets: TicketsService,
    private readonly storage: StorageService,
    private readonly branding: BrandingService,
  ) {}

  /** What the form offers: top-level categories as topics, the upload limits, and whose form it is. */
  async config(): Promise<WebFormConfig> {
    const categories = await this.org.activeCategories();
    return {
      categories: categories.map((c) => ({ id: c.id, name: c.name })),
      maxFiles: WEB_FORM_MAX_FILES,
      maxFileBytes: WEB_FORM_MAX_FILE_BYTES,
      branding: await this.branding.get(),
    };
  }

  async submit(form: WebForm, files: FormFile[]): Promise<WebFormReceipt> {
    if (files.length > WEB_FORM_MAX_FILES) {
      throw new BadRequestException(`Attach at most ${WEB_FORM_MAX_FILES} files`);
    }
    if (form.categoryId) {
      const known = (await this.org.activeCategories()).some((c) => c.id === form.categoryId);
      if (!known) throw new BadRequestException('Unknown topic');
    }
    if (files.length && !this.storage.enabled) {
      throw new ServiceUnavailableException('File uploads are unavailable right now');
    }

    const attachments: AttachmentRef[] = [];
    for (const f of files) attachments.push(await this.storage.putAttachment(f));

    // A reference typed while the field was shown is kept even if the field has been hidden since.
    const label = (await this.branding.get()).referenceLabel ?? 'Reference';
    const text = form.orderNumber
      ? `${form.description}\n\n${label}: ${form.orderNumber}`
      : form.description;
    const result = await this.inbound.handle({
      channel: 'web_form',
      threadKey: `form-${form.submissionId}`,
      channelMessageId: `form-${form.submissionId}`,
      from: {
        identity: { type: 'email', value: form.email },
        displayName: form.name,
      },
      subject: form.subject,
      text,
      attachments,
      receivedAt: new Date().toISOString(),
      metadata: form.orderNumber ? { orderNumber: form.orderNumber } : {},
      ticket: { categoryId: form.categoryId },
    });
    if (result.duplicate && attachments.length) {
      // A resubmission of a form we already stored: drop the second copies.
      await Promise.allSettled(attachments.map((a) => this.storage.delete(a.key)));
    }

    const ticket = await this.tickets.get(result.ticketId);
    return { reference: formatTicketNumber(ticket.number), email: form.email };
  }
}
