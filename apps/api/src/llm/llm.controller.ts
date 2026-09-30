import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type CreateLlmModelInput,
  createLlmModelSchema,
  type CreateLlmProviderInput,
  createLlmProviderSchema,
  llmUsageQuerySchema,
  MODEL_ROLES,
  type ModelRole,
  type SetLlmRoleInput,
  setLlmRoleSchema,
  testLlmRoleSchema,
  type UpdateLlmModelInput,
  updateLlmModelSchema,
  type UpdateLlmProviderInput,
  updateLlmProviderSchema,
} from '@tms/shared';
import { Ctx, type RequestCtx, RequirePermission } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { LlmClientService, LlmUnavailableError } from './llm-client.service';
import { LlmSettingsService } from './llm-settings.service';

const rolePipe = new ParseEnumPipe(Object.fromEntries(MODEL_ROLES.map((r) => [r, r])));

/** Handling an API key also needs settings:secrets (admins only; ADR 0009). */
function assertMayHandleKeys(ctx: RequestCtx, apiKey: unknown) {
  if (apiKey !== undefined && !ctx.user?.permissions.includes('settings:secrets')) {
    throw new ForbiddenException('Missing permission: settings:secrets');
  }
}

@ApiTags('settings')
@ApiBearerAuth()
@Controller('settings/llm')
@RequirePermission('settings:llm')
export class LlmController {
  constructor(
    private readonly settings: LlmSettingsService,
    private readonly llm: LlmClientService,
  ) {}

  @Get('providers')
  listProviders() {
    return this.settings.listProviders();
  }

  @Post('providers')
  createProvider(
    @Ctx() ctx: RequestCtx,
    @Body(new ZodPipe(createLlmProviderSchema)) body: CreateLlmProviderInput,
  ) {
    assertMayHandleKeys(ctx, body.apiKey);
    return this.settings.createProvider(ctx, body);
  }

  @Patch('providers/:id')
  updateProvider(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateLlmProviderSchema)) body: UpdateLlmProviderInput,
  ) {
    assertMayHandleKeys(ctx, body.apiKey);
    return this.settings.updateProvider(ctx, id, body);
  }

  @Delete('providers/:id')
  @HttpCode(204)
  @RequirePermission('settings:secrets')
  async deleteProvider(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) {
    await this.settings.deleteProvider(ctx, id);
  }

  @Post('providers/:id/test')
  @HttpCode(200)
  testProvider(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.settings.testProvider(ctx, id);
  }

  @Get('models')
  listModels() {
    return this.settings.listModels();
  }

  @Post('models')
  createModel(
    @Ctx() ctx: RequestCtx,
    @Body(new ZodPipe(createLlmModelSchema)) body: CreateLlmModelInput,
  ) {
    return this.settings.createModel(ctx, body);
  }

  @Patch('models/:id')
  updateModel(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateLlmModelSchema)) body: UpdateLlmModelInput,
  ) {
    return this.settings.updateModel(ctx, id, body);
  }

  @Delete('models/:id')
  @HttpCode(204)
  async deleteModel(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) {
    await this.settings.deleteModel(ctx, id);
  }

  @Get('roles')
  listRoles() {
    return this.settings.listRoles();
  }

  @Put('roles/:role')
  setRole(
    @Ctx() ctx: RequestCtx,
    @Param('role', rolePipe) role: ModelRole,
    @Body(new ZodPipe(setLlmRoleSchema)) body: SetLlmRoleInput,
  ) {
    return this.settings.setRole(ctx, role, body);
  }

  /** Sends one prompt through the role's routing, as the app would. */
  @Post('roles/:role/try')
  @HttpCode(200)
  async tryRole(
    @Param('role', rolePipe) role: ModelRole,
    @Body(new ZodPipe(testLlmRoleSchema)) body: { prompt: string },
  ) {
    try {
      if (role === 'embedding') {
        const r = await this.llm.embed([body.prompt]);
        const { vectors, ...meta } = r;
        return { ok: true, ...meta, output: `${vectors[0]?.length ?? 0}-dimension vector` };
      }
      const r = await this.llm.chat({
        role,
        messages: [{ role: 'user', content: body.prompt }],
        maxTokens: 50,
        timeoutMs: 30_000,
      });
      const { completion, ...meta } = r;
      return { ok: true, ...meta, output: completion.choices[0]?.message.content ?? '' };
    } catch (err) {
      const reason = err instanceof LlmUnavailableError ? err.reason : 'error';
      return { ok: false, reason, error: (err as Error).message.slice(0, 300) };
    }
  }

  @Get('usage')
  usage(@Query(new ZodPipe(llmUsageQuerySchema)) q: { days: number }) {
    return this.settings.usage(q.days);
  }
}
