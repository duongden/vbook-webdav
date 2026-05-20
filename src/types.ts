export type Env = {
  USER_KV: KVNamespace;
  STORAGE_R2: R2Bucket;
  ADMIN_PIN: string;
};

export interface UserConfig {
  password_hash: string;
  quota_mb: number;
  max_file_size_mb: number;
  status: 'active' | 'suspended';
}
