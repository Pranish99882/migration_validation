const SHOPIFY_ORDERS_BATCH_QUERY = `
query FindOrdersByName($query: String!, $first: Int!) {
  orders(first: $first, query: $query) {
    edges {
      node {
        name
      }
    }
  }
}
`;

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_CONCURRENCY = 4;

function getShopifyConfig() {
  const shop = process.env.SHOPIFY_SHOP;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-01';

  if (!shop || !token) {
    throw new Error('SHOPIFY_SHOP and SHOPIFY_ACCESS_TOKEN must be set in .env');
  }

  return {
    endpoint: `https://${shop}/admin/api/${apiVersion}/graphql.json`,
    token,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk(items, size) {
  const batches = [];

  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }

  return batches;
}

function getNamePrefix(prefix) {
  return prefix ?? process.env.SHOPIFY_ORDER_NAME_PREFIX ?? '#';
}

function buildShopifyOrderSearchQuery(orderId, { prefix, suffix = '' } = {}) {
  const namePrefix = getNamePrefix(prefix);
  return `name:'${namePrefix}${orderId}${suffix}'`;
}

function buildBatchSearchQuery(orderIds, { prefix, suffix = '' } = {}) {
  return orderIds
    .map((orderId) => buildShopifyOrderSearchQuery(orderId, { prefix, suffix }))
    .join(' OR ');
}

function shopifyNameToOrderId(name, namePrefix) {
  if (name.startsWith(namePrefix)) {
    return name.slice(namePrefix.length);
  }

  return name.replace(/^#/, '');
}

async function shopifyGraphql(query, variables) {
  const { endpoint, token } = getShopifyConfig();

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`Shopify HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }

  if (payload.errors?.length) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(payload.errors)}`);
  }

  return payload;
}

async function throttleIfNeeded(payload) {
  const throttle = payload.extensions?.cost?.throttleStatus;
  if (!throttle) {
    return;
  }

  if (throttle.currentlyAvailable < 100) {
    const waitMs = Math.ceil((100 - throttle.currentlyAvailable) / throttle.restoreRate) * 1000;
    await sleep(Math.min(waitMs, 2000));
  }
}

async function findShopifyOrdersBatch(orderIds, { namePrefix, nameSuffix = '' } = {}) {
  const query = buildBatchSearchQuery(orderIds, { prefix: namePrefix, suffix: nameSuffix });
  const payload = await shopifyGraphql(SHOPIFY_ORDERS_BATCH_QUERY, {
    query,
    first: orderIds.length,
  });

  await throttleIfNeeded(payload);

  return payload.data?.orders?.edges?.map((edge) => edge.node) ?? [];
}

async function runPool(items, concurrency, worker) {
  let nextIndex = 0;

  async function runner() {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      await worker(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner));
}

export async function checkOrdersInShopify(orders, options = {}) {
  const namePrefix = getNamePrefix(options.namePrefix);
  const nameSuffix = options.nameSuffix ?? process.env.SHOPIFY_ORDER_NAME_SUFFIX ?? '';
  const batchSize = Number(options.batchSize ?? process.env.SHOPIFY_BATCH_SIZE ?? DEFAULT_BATCH_SIZE);
  const concurrency = Number(options.concurrency ?? process.env.SHOPIFY_CONCURRENCY ?? DEFAULT_CONCURRENCY);
  const batches = chunk(orders, batchSize);
  const found = [];
  const missing = [];
  const errors = [];

  console.log(
    `Checking ${orders.length} orders: ${batches.length} API call(s), ${batchSize} IDs/call, concurrency ${concurrency}.`,
  );

  await runPool(batches, concurrency, async (batch, batchIndex) => {
    try {
      const shopifyOrders = await findShopifyOrdersBatch(
        batch.map((order) => order.orderId),
        { namePrefix, nameSuffix },
      );

      const foundOrderIds = new Set(
        shopifyOrders.map((shopifyOrder) => shopifyNameToOrderId(shopifyOrder.name, namePrefix)),
      );

      for (const order of batch) {
        const orderIdKey = String(order.orderId);

        if (foundOrderIds.has(orderIdKey)) {
          found.push({
            dbOrder: order,
            shopifyOrder: shopifyOrders.find(
              (item) => shopifyNameToOrderId(item.name, namePrefix) === orderIdKey,
            ),
          });
        } else {
          missing.push({ dbOrder: order });
        }
      }
    } catch (error) {
      for (const order of batch) {
        errors.push({ dbOrder: order, error: error.message });
      }
    }

    if ((batchIndex + 1) % 10 === 0 || batchIndex === batches.length - 1) {
      console.log(`  Progress: ${batchIndex + 1}/${batches.length} batches`);
    }
  });

  return { found, missing, errors };
}
