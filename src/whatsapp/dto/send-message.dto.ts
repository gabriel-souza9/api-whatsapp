import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { MediaType } from '../providers/messaging-provider.interface';

export class SendTextDto {
  @IsString()
  @IsNotEmpty()
  to: string;

  @IsString()
  @IsNotEmpty()
  text: string;
}

export class SendMediaDto {
  @IsString()
  @IsNotEmpty()
  to: string;

  @IsIn(['image', 'video', 'audio', 'document'])
  type: MediaType;

  @IsOptional()
  @IsString()
  url?: string;

  @IsOptional()
  @IsString()
  base64?: string;

  @IsOptional()
  @IsString()
  caption?: string;

  @IsOptional()
  @IsString()
  mimetype?: string;

  @IsOptional()
  @IsString()
  fileName?: string;
}
