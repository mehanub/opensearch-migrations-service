
export interface MigrationMappings {
  properties: Record<string, any>;
  [key: string]: any;
}

export interface MigrationConfig {
  type: 'migrate' | 'create';
  index: string;
  alias: string;
  version: string;
  description?: string;
  values: {
    mappings: MigrationMappings;
  };
  transform:{
    script: string;
  }
}
 