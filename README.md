# Fonts DB → Shopify Order Check

Compares order IDs from the MyFonts database against Shopify and writes CSV reports of **found** and **missing** orders.

## Quick start

```bash
cp .env.example .env   # fill in credentials
npm install
npm run check
```

Output files are written to `output/`:

- `missing-orders-<timestamp>.csv`
- `found-orders-<timestamp>.csv`

---

## Workflow diagram

```mermaid
flowchart TB
    START([START<br/>npm run check]) --> ENV[Load .env<br/>check-orders.js]

    subgraph P1["Phase 1 — Database (db.js)"]
        ENV --> MAIN[main]
        MAIN --> POOL[createDbPool]
        POOL --> SSH[SSH tunnel to bastion]
        SSH --> MYSQL[MySQL query<br/>SELECT OrderID, OrderDate]
        MYSQL --> MAP[mapOrders<br/>rows → orders array]
        MAP --> CLOSE[Close DB + SSH]
    end

    subgraph RAM1["In memory"]
        ORDERS[(orders array<br/>orderId, orderDate)]
    end

    CLOSE --> ORDERS

    subgraph P2["Phase 2 — Shopify (shopify.js)"]
        ORDERS --> CHUNK[Split into batches of 50]
        CHUNK --> PARALLEL[Run 4 batches in parallel]
        PARALLEL --> API[Shopify GraphQL API<br/>name:'#25100' OR name:'#25101' ...]
        API --> MATCH{Order name<br/>returned?}
        MATCH -->|Yes| FOUND[(found list)]
        MATCH -->|No| MISSING[(missing list)]
        API -->|API error| ERR[(errors list)]
    end

    subgraph P3["Phase 3 — Report (check-orders.js)"]
        FOUND --> SUMMARY[printSummary]
        MISSING --> SUMMARY
        ERR --> SUMMARY
        SUMMARY --> CONSOLE[Console counts + sample IDs]
        SUMMARY --> CSV1[missing-orders.csv]
        SUMMARY --> CSV2[found-orders.csv]
    end

    CSV2 --> END([END<br/>exit 0])
    MAIN -.->|failure| FAIL([END<br/>exit 1])

    style START fill:#e8f5e9
    style END fill:#e8f5e9
    style FAIL fill:#ffebee
    style ORDERS fill:#e3f2fd
    style FOUND fill:#e8f5e9
    style MISSING fill:#fff3e0
```

### Sequence view

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant C as check-orders.js
    participant D as db.js
    participant S as shopify.js
    participant API as Shopify API
    participant O as output/

    U->>C: npm run check
    C->>C: Load .env
    C->>D: loadOrdersFromDb()
    D->>D: SSH tunnel → MySQL → SQL query
    D->>D: mapOrders() → orders[]
    D-->>C: orders[]
    C->>S: checkOrdersInShopify(orders)
    loop Batches of 50 IDs, 4 parallel
        S->>API: POST GraphQL search by name
        API-->>S: Matching order names
        S->>S: Split batch into found / missing
    end
    S-->>C: { found, missing, errors }
    C->>C: printSummary()
    C->>O: missing-orders.csv
    C->>O: found-orders.csv
    C-->>U: Summary in terminal
```

---

## Project structure

| File | Role |
|------|------|
| `src/check-orders.js` | Entry point. Orchestrates DB load → Shopify check → CSV output |
| `src/db.js` | SSH tunnel, MySQL connection, SQL query, row mapping |
| `src/shopify.js` | Shopify GraphQL batch lookups and comparison |
| `src/test-db.js` | Optional: test DB connection only (`npm run test:db`) |
| `scripts/export-orders.sql` | Reference SQL (same query the app uses) |
| `.env` | Credentials and settings |

---

## Code-level workflow (simple terms)

### 1. START — `check-orders.js` → `main()`

When you run `npm run check`, Node executes `src/check-orders.js`, loads `.env`, and calls `main()`.

---

### 2. Load orders from database — `loadOrdersFromDb()`

**File:** `src/check-orders.js` → calls **`src/db.js`**

| Step | Function | What it does |
|------|----------|--------------|
| 2a | `createDbPool()` | SSH to bastion, open tunnel to MySQL, connect with SSL |
| 2b | `fetchOrdersFromDb()` | Run SQL: `SELECT OrderID, OrderDate FROM mf_user.Orders WHERE OrderDate between ? and ?` |
| 2c | `mapOrders()` | Convert rows to `[{ orderId, orderDate }, ...]` |
| 2d | `close()` | Close MySQL pool and SSH tunnel |

Data is stored in the `orders` array **in memory (RAM)**.

---

### 3. Check Shopify — `checkOrdersInShopify(orders)`

**File:** `src/shopify.js`

1. Split DB orders into **batches of 50** (`SHOPIFY_BATCH_SIZE`).
2. Run **4 batches in parallel** (`SHOPIFY_CONCURRENCY`).
3. Each API call searches Shopify with:
   ```
   name:'#25100' OR name:'#25101' OR ... OR name:'#25149'
   ```
4. For each ID in the batch: if Shopify returned a matching name → **found**, else → **missing**.
5. Returns `{ found, missing, errors }` in memory.

For 175k orders: ~3,500 API calls (175k ÷ 50), run 4 at a time.

---

### 4. Write report — `printSummary()`

**File:** `src/check-orders.js`

1. Logs counts to the console (sample of missing IDs).
2. Writes `output/missing-orders-<timestamp>.csv` and `output/found-orders-<timestamp>.csv`.

---

### 5. END

Success → exit 0. Error → exit 1.

---

## How DB OrderID maps to Shopify

| Source | Value |
|--------|-------|
| Database | `OrderID = 25170` |
| Shopify order name | `#25170` |
| API search | `name:'#25170'` |

```env
SHOPIFY_ORDER_NAME_PREFIX='#'
```

---

## Configuration (.env)

| Variable | Purpose |
|----------|---------|
| `SSH_*` | SSH tunnel to reach MySQL |
| `DB_*` | MySQL credentials |
| `DB_SSL` | Required `true` for this server |
| `ORDER_DATE_FROM` / `ORDER_DATE_TO` | Date range to query from DB |
| `ORDER_LIMIT` | `0` = all orders in range |
| `SHOPIFY_SHOP` | Shopify shop hostname |
| `SHOPIFY_ACCESS_TOKEN` | Admin API token |
| `SHOPIFY_ORDER_NAME_PREFIX` | Usually `'#'` |
| `SHOPIFY_BATCH_SIZE` | Order IDs per API call (default 50) |
| `SHOPIFY_CONCURRENCY` | Parallel API calls (default 4) |

---

## Commands

| Command | Description |
|---------|-------------|
| `npm run check` | Full run: DB → Shopify → CSV |
| `npm run test:db` | Test MySQL connection only |

---

## Memory vs disk

```mermaid
flowchart LR
    subgraph RAM["In memory during run"]
        O[orders array]
        R[found / missing arrays]
    end
    subgraph Disk["Written at end"]
        M[missing-orders.csv]
        F[found-orders.csv]
    end
    O --> R
    R --> M
    R --> F
```

CSV files are the only persistent output.
