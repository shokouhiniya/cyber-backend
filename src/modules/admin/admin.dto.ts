import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MinLength,
} from 'class-validator';

// -------- Profiles --------

const TIERS = ['heavy', 'medium', 'light'];

export class CreateProfileDto {
  @IsNotEmpty() name: string;
  @IsOptional() sortName?: string;
  @IsOptional() role?: string;
  @IsOptional() organization?: string;
  @IsOptional() avatar?: string;
  @IsOptional() @IsArray() keywords?: string[];
  @IsOptional() @IsArray() excludedKeywords?: string[];
  @IsOptional() sortCriteria?: string;
  @IsOptional() plan?: string;
  @IsOptional() primaryColor?: string;
  @IsOptional() logoUrl?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() officialChannels?: any[];
  @IsOptional() @IsIn(TIERS) tier?: string;
  @IsOptional() @IsNumber() @Min(0) dailyAvgPosts?: number;
  @IsOptional() @IsObject() sourceWeights?: Record<string, number>;
}

export class UpdateProfileDto {
  @IsOptional() name?: string;
  @IsOptional() sortName?: string;
  @IsOptional() role?: string;
  @IsOptional() organization?: string;
  @IsOptional() avatar?: string;
  @IsOptional() @IsArray() keywords?: string[];
  @IsOptional() @IsArray() excludedKeywords?: string[];
  @IsOptional() sortCriteria?: string;
  @IsOptional() plan?: string;
  @IsOptional() primaryColor?: string;
  @IsOptional() logoUrl?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() officialChannels?: any[];
  @IsOptional() @IsIn(TIERS) tier?: string;
  @IsOptional() @IsNumber() @Min(0) dailyAvgPosts?: number;
  @IsOptional() @IsObject() sourceWeights?: Record<string, number>;
}

// -------- Users --------

const ROLES = ['super_admin', 'client_admin', 'client_viewer'];

export class CreateUserDto {
  @IsNotEmpty() name: string;
  @IsNotEmpty() username: string;
  @IsOptional() @IsEmail() email?: string;
  @IsNotEmpty() @MinLength(6) password: string;
  @IsIn(ROLES) role: string;
  @IsOptional() organization?: string;
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) profileIds?: string[];
}

export class UpdateUserDto {
  @IsOptional() name?: string;
  @IsOptional() username?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsIn(ROLES) role?: string;
  @IsOptional() organization?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) profileIds?: string[];
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
