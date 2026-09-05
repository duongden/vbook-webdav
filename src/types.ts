export type Env = {
  USER_KV: KVNamespace;
  STORAGE_R2: R2Bucket;
  ADMIN_PIN: string;
  PASSWORD_VAULT_KEY?: string;
  USER_STORAGE: DurableObjectNamespace;
};

export interface UserConfig {
  password_hash: string;
  password_encrypted?: string;
  salt?: string;          // PBKDF2 salt (hex). Absent on legacy plain-text accounts.
  quota_mb: number;
  max_file_size_mb: number;
  status: 'active' | 'suspended';
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: UserConfig;
    username: string;
    _csrf: string;
    _parsedBody: Record<string, unknown>;
  };
};
