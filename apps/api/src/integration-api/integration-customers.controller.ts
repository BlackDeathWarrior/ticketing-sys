import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type CallRequestInput,
  callRequestSchema,
  type CheckPhoneVerificationInput,
  type CustomerEmailInput,
  type CustomerPhoneLookupInput,
  customerPhoneLookupSchema,
  type LinkCustomerPhoneInput,
  linkCustomerPhoneSchema,
  type CustomerEmailResult,
  customerEmailSchema,
  type CustomerNoticeInput,
  type CustomerNoticeResult,
  customerNoticeSchema,
  checkPhoneVerificationSchema,
  type StartPhoneVerificationInput,
  startPhoneVerificationSchema,
} from '@tms/shared';
import {
  ApiKey,
  ApiKeyAuth,
  type ApiKeyContext,
  RequirePermission,
} from '../common/request-context';
import { ZodBody } from '../common/zod-openapi';
import { ZodPipe } from '../common/zod.pipe';
import { CallRequestService } from './call-request.service';
import { CustomerEmailService } from './customer-email.service';
import { CustomerNoticeService } from './customer-notice.service';
import { CustomerPhoneService } from './customer-phone.service';
import { PhoneVerificationService } from './phone-verification.service';

/**
 * Proving a customer's phone number (ADR 0023): the app asks for a code to be
 * sent to the number over WhatsApp, then passes on what the customer typed.
 */
@ApiTags('integration API')
@ApiBearerAuth('apiKey')
@ApiKeyAuth()
@RequirePermission('integration:customer')
@Controller('integration/customers/phone-verifications')
export class IntegrationCustomersController {
  constructor(private readonly phones: PhoneVerificationService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: "Send a verification code to a customer's WhatsApp" })
  @ZodBody(startPhoneVerificationSchema)
  start(
    @ApiKey() key: ApiKeyContext,
    @Body(new ZodPipe(startPhoneVerificationSchema)) body: StartPhoneVerificationInput,
  ) {
    return this.phones.start(key, body);
  }

  @Post('check')
  @HttpCode(200)
  @ApiOperation({ summary: 'Check the code the customer typed' })
  @ZodBody(checkPhoneVerificationSchema)
  check(
    @ApiKey() key: ApiKeyContext,
    @Body(new ZodPipe(checkPhoneVerificationSchema)) body: CheckPhoneVerificationInput,
  ) {
    return this.phones.check(key, body);
  }
}

/**
 * Telling a customer something in writing after the fact (ADR 0039): the app
 * gives its own sentence, the desk sends it to the number that customer has
 * proven. The answer says whether it went; not sent is not an error.
 */
@ApiTags('integration API')
@ApiBearerAuth('apiKey')
@ApiKeyAuth()
@RequirePermission('integration:customer')
@Controller('integration/customers/notices')
export class IntegrationCustomerNoticesController {
  constructor(private readonly notices: CustomerNoticeService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a customer a short written notice on WhatsApp' })
  @ZodBody(customerNoticeSchema)
  send(
    @ApiKey() key: ApiKeyContext,
    @Body(new ZodPipe(customerNoticeSchema)) body: CustomerNoticeInput,
  ): Promise<CustomerNoticeResult> {
    return this.notices.send(key, body);
  }
}

/**
 * Emailing a customer for an app that has no mail server of its own: the link that
 * finishes an account started on a phone call. It goes out from the support mailbox.
 */
@ApiTags('integration API')
@ApiBearerAuth('apiKey')
@ApiKeyAuth()
@RequirePermission('integration:customer')
@Controller('integration/customers/emails')
export class IntegrationCustomerEmailsController {
  constructor(private readonly emails: CustomerEmailService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a customer an email from the support mailbox' })
  @ZodBody(customerEmailSchema)
  send(
    @ApiKey() key: ApiKeyContext,
    @Body(new ZodPipe(customerEmailSchema)) body: CustomerEmailInput,
  ): Promise<CustomerEmailResult> {
    return this.emails.send(key, body);
  }
}

/** "Call me": the app asks for its customer to be rung by the phone agent (ADR 0040). */
@ApiTags('integration API')
@ApiBearerAuth('apiKey')
@ApiKeyAuth()
@RequirePermission('integration:customer')
@Controller('integration/customers/:externalId/call-requests')
export class IntegrationCallRequestsController {
  constructor(private readonly calls: CallRequestService) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({ summary: 'Ask for a customer to be rung on their confirmed number' })
  @ZodBody(callRequestSchema)
  request(
    @ApiKey() key: ApiKeyContext,
    @Param('externalId') externalId: string,
    @Body(new ZodPipe(callRequestSchema)) body: CallRequestInput,
  ): Promise<{ requested: true }> {
    return this.calls.request(key, externalId.slice(0, 200), body);
  }
}

/**
 * A customer's phone number without a WhatsApp code, for an app that proves its people by
 * a code sent to their email address: the app tells the desk a number it linked, and asks
 * which number the desk linked on a call.
 */
@ApiTags('integration API')
@ApiBearerAuth('apiKey')
@ApiKeyAuth()
@RequirePermission('integration:customer')
@Controller('integration/customers')
export class IntegrationCustomerPhonesController {
  constructor(private readonly phones: CustomerPhoneService) {}

  @Post('phones')
  @HttpCode(200)
  @ApiOperation({ summary: 'Tell the desk the phone number the app linked to a customer' })
  @ZodBody(linkCustomerPhoneSchema)
  link(
    @ApiKey() key: ApiKeyContext,
    @Body(new ZodPipe(linkCustomerPhoneSchema)) body: LinkCustomerPhoneInput,
  ) {
    return this.phones.link(key, body);
  }

  @Post('phone-lookup')
  @HttpCode(200)
  @ApiOperation({ summary: 'The phone number linked to the customer with this email address' })
  @ZodBody(customerPhoneLookupSchema)
  lookup(@Body(new ZodPipe(customerPhoneLookupSchema)) body: CustomerPhoneLookupInput) {
    return this.phones.lookup(body);
  }
}
