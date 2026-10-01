import { Injectable, Logger, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { type DomainEvent, type DomainEventType, PORTAL_LINK_MINUTES } from '@tms/shared';
import { ChannelsModule } from '../channels/channels.module';
import { CsatModule } from '../csat/csat.module';
import { CustomersModule } from '../customers/customers.module';
import { ChannelConfigService } from '../settings/channel-config.service';
import { SystemMailer } from '../settings/system-mailer.service';
import { TicketsModule } from '../tickets/tickets.module';
import type { DomainEventHandler } from '../worker/domain-events';
import { WorkflowModule } from '../workflow/workflow.module';
import { PortalController, PortalGuard, PortalSignInController } from './portal.controller';
import { PortalService } from './portal.service';

/** Emails the sign-in link a customer asked for (worker). */
@Injectable()
export class PortalMailHandler implements DomainEventHandler {
  readonly name = 'portal-mail';
  private readonly logger = new Logger(PortalMailHandler.name);

  constructor(
    private readonly portal: PortalService,
    private readonly mailer: SystemMailer,
    private readonly channels: ChannelConfigService,
  ) {}

  handles(type: DomainEventType): boolean {
    return type === 'portal.link_requested';
  }

  async handle(event: DomainEvent): Promise<void> {
    const { loginId } = event.payload as { loginId: string };
    const mail = await this.portal.linkMail(loginId);
    if (!mail) return;
    const team = (await this.channels.email())?.fromName ?? 'Support';
    const sent = await this.mailer.send({
      to: mail.to,
      subject: `Your sign-in link for ${team}`,
      text: [
        `Hi ${mail.name},`,
        '',
        'Open this link to see your requests:',
        mail.link,
        '',
        `It works once and expires in ${PORTAL_LINK_MINUTES} minutes. If you didn't ask for it, you can ignore this email.`,
        '',
        team,
      ].join('\n'),
      id: `portal-${loginId}`,
    });
    if (!sent) this.logger.warn('sign-in link not sent: the email channel is off');
  }
}

/** The customer portal behind the help center's "My requests" (ADR 0019). */
@Module({
  imports: [
    ChannelsModule,
    CustomersModule,
    TicketsModule,
    WorkflowModule,
    CsatModule,
    JwtModule.register({}),
  ],
  controllers: [PortalSignInController, PortalController],
  providers: [PortalService, PortalGuard, PortalMailHandler],
  exports: [PortalService, PortalMailHandler],
})
export class PortalModule {}
