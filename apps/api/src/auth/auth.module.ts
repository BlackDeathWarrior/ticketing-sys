import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import type { Env } from '../config/env';
import { ENV } from '../infra/tokens';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthGuard, PermissionsGuard } from './auth.guard';
import { AuthService } from './auth.service';

@Module({
  imports: [
    UsersModule,
    JwtModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        secret: env.JWT_SECRET,
        signOptions: { expiresIn: env.JWT_ACCESS_TTL as `${number}m`, issuer: 'tms' },
        verifyOptions: { issuer: 'tms' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    // Order matters: authenticate first, then check permissions.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}
