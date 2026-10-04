import { Module } from '@nestjs/common';
import { MeController, RolesController, UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController, RolesController, MeController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
