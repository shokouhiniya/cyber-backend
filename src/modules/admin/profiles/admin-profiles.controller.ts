import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Response } from 'express';

import { AdminProfilesService } from './admin-profiles.service';
import { CreateProfileDto, UpdateProfileDto } from '../admin.dto';
import { Roles } from '../../auth/roles.decorator';
import { RolesGuard } from '../../auth/roles.guard';

@Controller('admin/profiles')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('super_admin')
export class AdminProfilesController {
  constructor(private readonly service: AdminProfilesService) {}

  @Get()
  list() {
    return this.service.list();
  }

  /**
   * Download a sample CSV template showing all importable columns.
   * Clients can fill this in and re-upload via batch-import.
   */
  @Get('sample-csv')
  sampleCsv(@Res() res: Response) {
    const headers = [
      'name', 'sort_name', 'role', 'organization', 'tier', 'is_active',
      'keywords', 'excluded_keywords',
      'promtic_external_id', 'promtic_display_name', 'promtic_type',
      'primary_color', 'plan',
      'channel_telegram', 'channel_eitaa', 'channel_rubika', 'channel_bale', 'channel_x', 'channel_instagram',
      'context_default',
      'promises_count', 'promises_json',
    ];

    const example = [
      'علی مثالی', 'مثالی', 'نماینده مجلس', 'مجلس شورای اسلامی', 'medium', 'true',
      'علی مثالی|نماینده مثالی', 'مثال دیگر|تکراری',
      'ali_mesali', 'علی مثالی', 'political_figure',
      '#1565C0', 'standard',
      'ali_mesali_channel', '', '', '', 'ali_mesali_x', 'ali.mesali',
      'Ali Mesali is a member of parliament representing ...',
      '0', '',
    ];

    const esc = (v) => {
      if (v == null || v === '') return '';
      const s = String(v).replace(/"/g, '""');
      return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s}"` : s;
    };

    const csv = '\uFEFF' + [headers.join(','), example.map(esc).join(',')].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="profiles-import-template.csv"');
    res.send(csv);
  }

  /**
   * Batch import profiles from a JSON array.
   * Each item follows the same flat structure as the CSV columns.
   * Skips rows where `name` is empty.
   * Returns { created, skipped, errors[] }.
   */
  @Post('batch-import')
  async batchImport(@Body() body: { profiles: Record<string, string>[] }) {
    return this.service.batchImport(body.profiles ?? []);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post()
  create(@Body() dto: CreateProfileDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateProfileDto) {
    return this.service.update(id, dto);
  }

  @Post(':id/archive')
  archive(@Param('id') id: string) {
    return this.service.archive(id);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}

/** Unscoped helper endpoint — available to every authenticated user. */
@Controller('admin/accessible-profiles')
@UseGuards(AuthGuard('jwt'))
export class AccessibleProfilesController {
  constructor(private readonly service: AdminProfilesService) {}

  @Get()
  list(@Req() req: any) {
    return this.service.listAccessibleFor(req.user.sub, req.user.role);
  }
}
