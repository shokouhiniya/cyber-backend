import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

import { ROLES } from '../auth/roles';
import { normalizeIranPhone } from '../../libs/sms/phone';

// -------- Profiles --------

const TIERS = ['heavy', 'medium', 'light'];

export class CreateProfileDto {
  @IsNotEmpty() name: string;
  @IsOptional() sortName?: string;
  @IsOptional() @IsString() @MaxLength(100) honorific?: string | null;
  @IsOptional() role?: string;
  @IsOptional() organization?: string;
  @IsOptional() avatar?: string;
  @IsOptional() @IsArray() keywords?: string[];
  @IsOptional() @IsArray() excludedKeywords?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) contextKeywords?: string[];
  @IsOptional() sortCriteria?: string;
  @IsOptional() plan?: string;
  @IsOptional() primaryColor?: string;
  @IsOptional() logoUrl?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() officialChannels?: any[];
  @IsOptional() @IsIn(TIERS) tier?: string;
  @IsOptional() @IsNumber() @Min(0) dailyAvgPosts?: number;
  @IsOptional() @IsObject() sourceWeights?: Record<string, number>;
  @IsOptional() @IsInt() @Min(0) @Max(1000) priority?: number;
}

export class UpdateProfileDto {
  @IsOptional() name?: string;
  @IsOptional() sortName?: string;
  @IsOptional() @IsString() @MaxLength(100) honorific?: string | null;
  @IsOptional() role?: string;
  @IsOptional() organization?: string;
  @IsOptional() avatar?: string;
  @IsOptional() @IsArray() keywords?: string[];
  @IsOptional() @IsArray() excludedKeywords?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) contextKeywords?: string[];
  @IsOptional() sortCriteria?: string;
  @IsOptional() plan?: string;
  @IsOptional() primaryColor?: string;
  @IsOptional() logoUrl?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() officialChannels?: any[];
  @IsOptional() @IsIn(TIERS) tier?: string;
  @IsOptional() @IsNumber() @Min(0) dailyAvgPosts?: number;
  @IsOptional() @IsObject() sourceWeights?: Record<string, number>;
  @IsOptional() @IsInt() @Min(0) @Max(1000) priority?: number;
  @IsOptional() @IsObject() profileContexts?: Record<string, string>;
  @IsOptional() @IsArray() promises?: any[];
  @IsOptional() @IsArray() hiddenWidgets?: string[];
}

// -------- Users --------


/**
 * Normalises an Iranian mobile number to `09xxxxxxxxx` with the shared
 * normalizeIranPhone (Persian/Arabic digits, spaces/dashes, +98 / 0098 / 98).
 * Empty → null. Anything that is not a mobile number is returned as-is so
 * @Matches rejects it with a Persian message.
 */
export function normalisePhone(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || !String(value).trim()) return null;
  return normalizeIranPhone(value) ?? String(value);
}

const PHONE_RE = /^09\d{9}$/;
const PHONE_MSG = 'شماره موبایل باید به شکل ۰۹xxxxxxxxx باشد';

export class CreateUserDto {
  @IsNotEmpty() name: string;
  @IsNotEmpty() username: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @Transform(({ value }) => normalisePhone(value)) @Matches(PHONE_RE, { message: PHONE_MSG }) phone?: string | null;
  @IsNotEmpty() @MinLength(6) password: string;
  @IsIn(ROLES as unknown as string[]) role: string;
  @IsOptional() organization?: string;
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) profileIds?: string[];
}

export class UpdateUserDto {
  @IsOptional() name?: string;
  @IsOptional() username?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @Transform(({ value }) => normalisePhone(value)) @Matches(PHONE_RE, { message: PHONE_MSG }) phone?: string | null;
  @IsOptional() @IsIn(ROLES as unknown as string[]) role?: string;
  @IsOptional() organization?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) profileIds?: string[];
}

// -------- Profile access (permission matrix) --------

export class AccessPairDto {
  @IsUUID('4') userId: string;
  @IsUUID('4') profileId: string;
}

/** Grant and revoke user↔profile links in one request (the permission matrix "save"). */
export class ApplyAccessDto {
  @IsOptional() @IsArray() @ArrayMaxSize(5000) @ValidateNested({ each: true }) @Type(() => AccessPairDto) grant?: AccessPairDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(5000) @ValidateNested({ each: true }) @Type(() => AccessPairDto) revoke?: AccessPairDto[];
}

export class ResetPasswordDto {
  @IsNotEmpty() @MinLength(6) password: string;
}

// -------- Global context --------

export class UpsertContextDto {
  @IsString() @IsNotEmpty() value: string;
}

// -------- Data sources --------

export class CreateDataSourceDto {
  @IsNotEmpty() name: string;
  @IsNotEmpty() type: string;
  @IsOptional() @IsUUID('4') profileId?: string;
  @IsOptional() apiEndpoint?: string;
  @IsOptional() credentials?: Record<string, any>;
  @IsOptional() params?: Record<string, any>;
  @IsOptional() scheduleCron?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateDataSourceDto {
  @IsOptional() name?: string;
  @IsOptional() type?: string;
  @IsOptional() @IsUUID('4') profileId?: string;
  @IsOptional() apiEndpoint?: string;
  @IsOptional() credentials?: Record<string, any>;
  @IsOptional() params?: Record<string, any>;
  @IsOptional() scheduleCron?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

// -------- Usage events --------

export class WriteUsageEventDto {
  @IsIn(['page_view', 'feature_use', 'api_call', 'admin.action'])
  eventType: string;

  @IsString()
  @IsNotEmpty()
  eventName: string;

  @IsOptional()
  metadata?: Record<string, any>;
}
