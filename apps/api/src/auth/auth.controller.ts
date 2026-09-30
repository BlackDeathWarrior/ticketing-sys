import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { type CurrentUser, type LoginInput, loginSchema, refreshSchema } from '@tms/shared';
import { Ctx, Public, type RequestCtx, User } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { AuthService } from './auth.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Ctx() ctx: RequestCtx, @Body(new ZodPipe(loginSchema)) body: LoginInput) {
    return this.auth.login(ctx, body.email, body.password);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body(new ZodPipe(refreshSchema)) body: { refreshToken: string }) {
    return this.auth.refresh(body.refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Body(new ZodPipe(refreshSchema)) body: { refreshToken: string }) {
    await this.auth.logout(body.refreshToken);
  }

  @ApiBearerAuth()
  @Get('me')
  me(@User() user: CurrentUser) {
    return user;
  }
}
