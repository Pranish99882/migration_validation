import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createDbPool, fetchOrdersFromDb, mapOrders } from './db.js';
import { checkOrdersInShopify } from './shopify.js';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function writeOrderIdCsv(filePath, orderIds) {
  const lines = ['OrderID', ...orderIds.map(String)];
  writeFileSync(filePath, `${lines.join('\n')}\n`);
}

function printSummary({ orders, result, outputDir }) {
  const { found, missing, errors } = result;
  const missingOrderIds = missing.map((item) => item.dbOrder.orderId);
  const foundOrderIds = found.map((item) => item.dbOrder.orderId);

  console.log('\n=== Order availability check ===');
  console.log(`DB orders checked: ${orders.length}`);
  console.log(`Found in Shopify:    ${found.length}`);
  console.log(`Missing in Shopify:  ${missing.length}`);
  console.log(`Errors:              ${errors.length}`);

  if (missing.length) {
    console.log('\nMissing order IDs (sample):');
    for (const orderId of missingOrderIds.slice(0, 20)) {
      console.log(`  - ${orderId}`);
    }
    if (missing.length > 20) {
      console.log(`  ... and ${missing.length - 20} more (see CSV)`);
    }
  }

  if (errors.length) {
    console.log('\nErrors (sample):');
    for (const item of errors.slice(0, 10)) {
      console.log(`  - OrderID ${item.dbOrder.orderId}: ${item.error}`);
    }
    if (errors.length > 10) {
      console.log(`  ... and ${errors.length - 10} more`);
    }
  }

  mkdirSync(outputDir, { recursive: true });
  const timestamp = Date.now();
  const missingCsvPath = join(outputDir, `missing-orders-${timestamp}.csv`);
  const foundCsvPath = join(outputDir, `found-orders-${timestamp}.csv`);

  writeOrderIdCsv(missingCsvPath, missingOrderIds);
  writeOrderIdCsv(foundCsvPath, foundOrderIds);

  console.log(`\nMissing orders CSV: ${missingCsvPath}`);
  console.log(`Found orders CSV:   ${foundCsvPath}`);
}

async function loadOrdersFromDb() {
  const from = process.env.ORDER_DATE_FROM || '2013-01-01 00:00:00';
  const to = process.env.ORDER_DATE_TO || '2013-01-31 23:59:59';
  const limit = Number(process.env.ORDER_LIMIT || 0);

  requireEnv('DB_HOST');
  requireEnv('DB_USER');
  requireEnv('DB_PASSWORD');
  requireEnv('DB_NAME');

  const { pool, close } = await createDbPool();

  try {
    console.log(
      limit
        ? `Fetching up to ${limit} orders from ${from} to ${to}...`
        : `Fetching all orders from ${from} to ${to}...`,
    );
    const rows = await fetchOrdersFromDb(pool, { from, to, limit });
    const orders = mapOrders(rows);
    console.log(`Loaded ${orders.length} orders.`);
    return orders;
  } finally {
    await close();
  }
}

async function main() {
  let orders;

  try {
    orders = await loadOrdersFromDb();
  } catch (error) {
    if (error.code === 'ENOTFOUND') {
      console.error(`Cannot resolve DB host "${process.env.DB_HOST}".`);
      console.error('If Workbench uses "Standard TCP/IP over SSH", add SSH_* settings to .env.');
    }
    throw error;
  }

  requireEnv('SHOPIFY_ACCESS_TOKEN');
  requireEnv('SHOPIFY_SHOP');

  console.log('Checking Shopify availability...');
  const result = await checkOrdersInShopify(orders);
  printSummary({ orders, result, outputDir: join(process.cwd(), 'output') });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
