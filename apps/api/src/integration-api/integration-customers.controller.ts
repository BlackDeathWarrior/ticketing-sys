import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type CheckPhoneVerificationInput,
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
import { CustomerNoticeService } from './customer-notice.service';
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
