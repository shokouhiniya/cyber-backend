import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ProfileService } from './profile.service';
import { CurrentProfile } from '../auth/current-profile.decorator';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';

@Controller('profile')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('super_admin', 'client_admin', 'client_viewer')
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @Get()
  getActiveProfile(@CurrentProfile() profileId: string | null) {
    return this.profileService.getActiveProfile(profileId);
  }
}
