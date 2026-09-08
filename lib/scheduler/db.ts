import { neon } from '@neondatabase/serverless';

if (!process.env.DATABASE_URL) {
  throw new Error('Falta DATABASE_URL en las variables de entorno.');
}

export const sql = neon(process.env.DATABASE_URL);
