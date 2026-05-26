import net from 'node:net';
import { readFileSync } from 'node:fs';
import { Client as SshClient } from 'ssh2';
import mysql from 'mysql2/promise';

const ORDER_QUERY_ALL = `
SELECT OrderID, OrderDate
FROM mf_user.Orders
WHERE OrderDate >= ?
  AND OrderDate <= ?
ORDER BY OrderDate ASC, OrderID ASC
`;

const ORDER_QUERY_LIMIT = `
SELECT OrderID, OrderDate
FROM mf_user.Orders
WHERE OrderDate >= ?
  AND OrderDate <= ?
ORDER BY OrderDate ASC, OrderID ASC
LIMIT ?
`;

function connectSsh() {
  const sshHost = process.env.SSH_HOST;
  const sshUser = process.env.SSH_USER;
  const sshKeyFile = process.env.SSH_KEY_FILE;
  const sshPort = Number(process.env.SSH_PORT || 22);

  if (!sshHost || !sshUser || !sshKeyFile) {
    return null;
  }

  const sshClient = new SshClient();

  return new Promise((resolve, reject) => {
    sshClient
      .on('ready', () => resolve(sshClient))
      .on('error', reject)
      .connect({
        host: sshHost,
        port: sshPort,
        username: sshUser,
        privateKey: readFileSync(sshKeyFile),
      });
  });
}

async function createSshTunnel(sshClient) {
  const dbHost = process.env.DB_HOST;
  const dbPort = Number(process.env.DB_PORT || 3306);

  const server = net.createServer((socket) => {
    sshClient.forwardOut(
      socket.remoteAddress || '127.0.0.1',
      socket.remotePort || 0,
      dbHost,
      dbPort,
      (error, stream) => {
        if (error) {
          socket.destroy(error);
          return;
        }

        socket.pipe(stream).pipe(socket);
      },
    );
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return server;
}

export async function createDbPool(options = {}) {
  const sshClient = await connectSsh();
  let server = null;

  let host = process.env.DB_HOST;
  let port = Number(process.env.DB_PORT || 3306);

  if (sshClient) {
    console.log(`Opening SSH tunnel via ${process.env.SSH_USER}@${process.env.SSH_HOST}...`);
    server = await createSshTunnel(sshClient);
    ({ port } = server.address());
    host = '127.0.0.1';
    console.log(`SSH tunnel ready. Forwarding localhost:${port} -> ${process.env.DB_HOST}:${process.env.DB_PORT || 3306}`);
  }

  const user = process.env.DB_USER?.trim();
  const password = process.env.DB_PASSWORD?.trim();
  const database = options.database ?? process.env.DB_NAME?.trim();

  const poolConfig = {
    host,
    port,
    user,
    password,
    waitForConnections: true,
    connectionLimit: 5,
  };

  if (database) {
    poolConfig.database = database;
  }

  if (options.ssl ?? process.env.DB_SSL === 'true') {
    const rejectUnauthorized =
      options.sslRejectUnauthorized ??
      process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false';

    poolConfig.ssl = rejectUnauthorized
      ? {}
      : { rejectUnauthorized: false };
  }

  const pool = mysql.createPool(poolConfig);

  const close = async () => {
    await pool.end();
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (sshClient) {
      sshClient.end();
    }
  };

  return { pool, close };
}

export async function fetchOrdersFromDb(pool, { from, to, limit }) {
  if (!limit) {
    const [rows] = await pool.query(ORDER_QUERY_ALL, [from, to]);
    return rows;
  }

  const [rows] = await pool.query(ORDER_QUERY_LIMIT, [from, to, limit]);
  return rows;
}

export function mapOrders(rows) {
  return rows.map((row) => ({
    orderId: row.OrderID,
    orderDate: row.OrderDate,
  }));
}
