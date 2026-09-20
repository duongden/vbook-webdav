export type Env = {
  USER_KV: KVNamespace;
  STORAGE_R2: R2Bucket;
  ADMIN_PIN: string;
  ADMIN_SESSION_SECRET?: string;
  PASSWORD_VAULT_KEY?: string;
  DRIVE_VAULT_KEY?: string;
  USER_STORAGE: DurableObjectNamespace;
};

export interface UserConfig {
  password_hash: string;
  password_encrypted?: string;
  salt?: string;          // PBKDF2 salt (hex). Absent on legacy plain-text accounts.
  quota_mb: number;
  max_file_size_mb: number;
  status: 'active' | 'suspended';
  drive_folder_id?: string;
}

export interface WebDavShare {
  id: string;
  label: string;
  prefix: string;
  secret_hash: string;
  created_at: number;
  expires_at?: number;
  status: 'active' | 'revoked';
}

export type PublicWebDavShare = Omit<WebDavShare, 'secret_hash'>;

export interface BookMetadata {
  title?: string;
  author?: string;
  language?: string;
  category?: string;
  description?: string;
  coverUrl?: string;
}

export interface BookMetadataRecord {
  path: string;
  metadata: BookMetadata;
  updated_at: number;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: UserConfig;
    username: string;
    driveApiKey: string;
    _csrf: string;
    _parsedBody: Record<string, unknown>;
  };
};
