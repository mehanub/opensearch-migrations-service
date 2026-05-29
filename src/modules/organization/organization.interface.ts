export interface Organization {
  uuid: string;
  name: string;
  inn: string;
  kpp: string;
  is_key_client: boolean;
  date_begin: string;
  created_at: string;
  updated_at: string;
  updated_by?: string;
}

export const ORGANIZATION_ALIAS = 'organizations';

export const EXAMPLE_ORGANIZATIONS: Organization[] = [
  {
    uuid: 'a1b2c3d4-0001-0001-0001-000000000001',
    name: 'ООО Ромашка',
    inn: '7701234567',
    kpp: '770101001',
    is_key_client: true,
    date_begin: '2020-01-15T00:00:00.000Z',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    updated_by: 'admin',
  },
  {
    uuid: 'a1b2c3d4-0002-0002-0002-000000000002',
    name: 'АО Северсталь',
    inn: '3522000014',
    kpp: '352201001',
    is_key_client: false,
    date_begin: '2015-06-01T00:00:00.000Z',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];
