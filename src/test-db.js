import 'dotenv/config';
import { createDbPool } from './db.js';

async function tryConnect(label, options) {
  const { pool, close } = await createDbPool(options);

  try {
    const [rows] = await pool.query('SELECT 1 AS ok, CURRENT_USER() AS mysqlUser, DATABASE() AS db');
    console.log(`${label}: OK`, rows[0]);
    return true;
  } catch (error) {
    console.error(`${label}: FAILED -> ${error.message}`);
    return false;
  } finally {
    await close();
  }
}

async function main() {
  requireEnv('DB_USER');
  requireEnv('DB_PASSWORD');

  console.log('Config check:');
  console.log(`  DB_USER=${process.env.DB_USER}`);
  console.log(`  DB_NAME=${process.env.DB_NAME || '(not set)'}`);
  console.log(`  DB_PASSWORD length=${process.env.DB_PASSWORD.trim().length}`);
  console.log(`  DB_SSL=${process.env.DB_SSL || 'false'}`);

  const attempts = [
    ['With DB_NAME from .env', {}],
    ['Without default database', { database: undefined }],
    ['With DB_NAME=myfonts', { database: 'myfonts' }],
    ['With SSL and no default database', { database: undefined, ssl: true, sslRejectUnauthorized: false }],
  ];

  for (const [label, options] of attempts) {
    const ok = await tryConnect(label, options);
    if (ok) {
      return;
    }
  }

  console.error('\nAll connection attempts failed.');
  console.error('Next steps:');
  console.error('1. In Workbench, click Test Connection on the ldrprod profile.');
  console.error('2. Copy the exact MySQL password from Keychain into .env as DB_PASSWORD.');
  console.error('3. Set DB_NAME=myfonts (ldrprod is the connection name, not a database).');
  process.exit(1);
}

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`Missing required env var: ${name}`);
  }
}

main().catch((error) => {
  console.error('Unexpected error:', error.message);
  process.exit(1);
});
