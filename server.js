const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'pos.db');

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Unable to open SQLite database:', err.message);
    process.exit(1);
  }
});

const sampleProducts = [
  { id: '0001', name: 'Bottled Water 500ml', sku: '0001', barcode: '100000001', category: 'Beverages', price: 1.25, stock: 50, image: '/images/water.jpg' },
  { id: '0002', name: 'Croissant', sku: '0002', barcode: '100000002', category: 'Bakery', price: 2.50, stock: 30, image: '/images/crossaint.jpeg' },
  { id: '0003', name: 'Banana (per lb)', sku: '0003', barcode: '100000003', category: 'Produce', price: 0.69, stock: 100, image: '/images/bunch-bananas-6175887.jpg.webp' },
  { id: '0004', name: 'Whole Milk 1L', sku: '0004', barcode: '100000004', category: 'Dairy', price: 3.10, stock: 40, image: '/images/milk.jpeg' },
  { id: '0005', name: 'Potato Chips', sku: '0005', barcode: '100000005', category: 'Snacks', price: 2.99, stock: 25, image: '/images/Lays_XL_Classic_Laydown.png' },
  { id: '0006', name: 'Coffee Beans 250g', sku: '0006', barcode: '100000006', category: 'Beverages', price: 6.75, stock: 20, image: '/images/coffee.jpeg' },
  { id: '0007', name: 'Dish Soap 750ml', sku: '0007', barcode: '100000007', category: 'Household', price: 3.45, stock: 35, image: '/images/soap.jpg' },
  { id: '0008', name: 'USB-C Cable 1m', sku: '0008', barcode: '100000008', category: 'Electronics', price: 8.99, stock: 15, image: '/images/usb-c.jpeg' },
];

function initDatabase() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sku TEXT UNIQUE NOT NULL,
        barcode TEXT UNIQUE NOT NULL,
        category TEXT NOT NULL,
        price REAL NOT NULL,
        stock INTEGER NOT NULL,
        image TEXT
      )
    `);

    const ensureColumns = (callback) => {
      db.all('PRAGMA table_info(products)', (err, columns) => {
        if (err) return callback(err);

        const existingNames = columns.map((column) => column.name);
        const tasks = [];

        if (!existingNames.includes('description')) {
          tasks.push((next) => db.run('ALTER TABLE products ADD COLUMN description TEXT', next));
        }
        if (!existingNames.includes('cost')) {
          tasks.push((next) => db.run('ALTER TABLE products ADD COLUMN cost REAL DEFAULT 0', next));
        }
        if (!existingNames.includes('threshold')) {
          tasks.push((next) => db.run('ALTER TABLE products ADD COLUMN threshold INTEGER DEFAULT 0', next));
        }

        const runNext = () => {
          if (!tasks.length) return callback(null);
          const task = tasks.shift();
          task((taskErr) => {
            if (taskErr) return callback(taskErr);
            runNext();
          });
        };

        runNext();
      });
    };

    ensureColumns((ensureErr) => {
      if (ensureErr) {
        console.error('Failed to update product columns:', ensureErr.message);
      }

      db.run(`
        CREATE TABLE IF NOT EXISTS transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT DEFAULT (datetime('now')),
          payment_method TEXT,
          subtotal REAL,
          discount REAL,
          tax REAL,
          total REAL
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS transaction_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          transaction_id INTEGER,
          product_id TEXT,
          name TEXT,
          sku TEXT,
          unit_price REAL,
          quantity INTEGER,
          line_total REAL,
          FOREIGN KEY (transaction_id) REFERENCES transactions(id)
        )
      `);

      const insertOrReplace = db.prepare(
        'INSERT OR REPLACE INTO products (id, name, sku, barcode, category, price, stock, image, description, cost, threshold) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );

      sampleProducts.forEach((product) => {
        insertOrReplace.run(
          product.id,
          product.name,
          product.sku,
          product.barcode,
          product.category,
          product.price,
          product.stock,
          product.image || null,
          product.description || null,
          product.cost || 0,
          product.threshold || 0
        );
      });

      insertOrReplace.finalize((finalizeErr) => {
        if (finalizeErr) {
          console.error('Failed to seed products:', finalizeErr.message);
        }
      });
    });
  });
}

initDatabase();

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Simple PIN-based middleware for protected routes
const POS_PIN = process.env.POS_PIN || '1234';
function checkAuth(req, res, next) {
  const pin = String(req.headers['x-pos-pin'] || '');
  if (pin !== POS_PIN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/scanner-socket' });
const scannerSessions = new Map();

function getScannerSession(sessionId) {
  if (!scannerSessions.has(sessionId)) {
    scannerSessions.set(sessionId, { posClient: null, phoneClient: null });
  }
  return scannerSessions.get(sessionId);
}

function sendJson(socket, data) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(data));
}

wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.split('?')[1] || '');
  const role = params.get('role');
  const sessionId = params.get('sessionId');

  if (!sessionId || !['pos', 'phone'].includes(role)) {
    ws.close(1008, 'Invalid session or role');
    return;
  }

  const session = getScannerSession(sessionId);
  const peer = role === 'pos' ? 'posClient' : 'phoneClient';
  // If there's an existing open socket for this role, close it to avoid
  // silently overwriting connections (e.g., multiple tabs with same sessionId)
  if (session[peer] && session[peer].readyState === WebSocket.OPEN) {
    try {
      session[peer].close(1000, 'Replaced by new connection');
    } catch (closeErr) {
      // ignore errors when closing the old socket
    }
  }
  session[peer] = ws;

  if (role === 'pos') {
    sendJson(ws, { type: 'status', status: 'pos-connected' });
    if (session.phoneClient && session.phoneClient.readyState === WebSocket.OPEN) {
      sendJson(ws, { type: 'device-status', status: 'phone-connected' });
      sendJson(session.phoneClient, { type: 'pos-status', status: 'connected' });
    }
  } else {
    sendJson(ws, { type: 'status', status: 'phone-connected' });
    if (session.posClient && session.posClient.readyState === WebSocket.OPEN) {
      sendJson(session.posClient, { type: 'device-status', status: 'phone-connected' });
      sendJson(ws, { type: 'pos-status', status: 'connected' });
    }
  }

  ws.on('message', (rawMessage) => {
    let message;
    try {
      message = JSON.parse(rawMessage);
    } catch (error) {
      return;
    }

    if (message.type === 'barcode' && role === 'phone') {
      if (session.posClient && session.posClient.readyState === WebSocket.OPEN) {
        sendJson(session.posClient, { type: 'barcode', barcode: String(message.barcode || '').trim() });
        sendJson(ws, { type: 'scan-ack', barcode: message.barcode });
      }
    }
  });

  ws.on('close', () => {
    if (role === 'pos') {
      session.posClient = null;
      if (session.phoneClient && session.phoneClient.readyState === WebSocket.OPEN) {
        sendJson(session.phoneClient, { type: 'pos-status', status: 'disconnected' });
      }
    } else {
      session.phoneClient = null;
      if (session.posClient && session.posClient.readyState === WebSocket.OPEN) {
        sendJson(session.posClient, { type: 'device-status', status: 'phone-disconnected' });
      }
    }
  });
});

app.get('/api/products', (req, res) => {
  const search = String(req.query.search || '').trim();
  const category = String(req.query.category || 'all').trim().toLowerCase();
  const barcode = String(req.query.barcode || '').trim();
  const stockFilter = String(req.query.stock || 'all').trim().toLowerCase();

  let sql = 'SELECT * FROM products';
  const conditions = [];
  const params = [];

  if (barcode) {
    conditions.push('barcode = ?');
    params.push(barcode);
  }

  if (search) {
    conditions.push('(name LIKE ? OR sku LIKE ? OR barcode LIKE ? OR category LIKE ?)');
    const pattern = `%${search}%`;
    params.push(pattern, pattern, pattern, pattern);
  }

  if (category && category !== 'all') {
    conditions.push('LOWER(category) = ?');
    params.push(category);
  }

  if (stockFilter === 'low') {
    conditions.push('stock > 0 AND stock <= 10');
  } else if (stockFilter === 'out') {
    conditions.push('stock = 0');
  }

  if (conditions.length) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  sql += ' ORDER BY name COLLATE NOCASE';

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Product query failed:', err.message);
      return res.status(500).json({ error: 'Unable to load products' });
    }
    res.json(rows);
  });
});

app.post('/api/products', checkAuth, (req, res) => {
  const { name, sku, barcode, category, price, stock, image, description, cost, threshold } = req.body;

  if (!name || !sku || !barcode || !category) {
    return res.status(400).json({ error: 'Name, SKU, barcode, and category are required.' });
  }

  const id = Date.now().toString();
  const product = [id, name, sku, barcode, category, Number(price) || 0, Number(stock) || 0, image || '/images/placeholder.svg', description || '', Number(cost) || 0, Number(threshold) || 0];

  db.run(
    'INSERT INTO products (id, name, sku, barcode, category, price, stock, image, description, cost, threshold) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    product,
    function (err) {
      if (err) {
        console.error('Insert product failed:', err.message);
        return res.status(500).json({ error: 'Unable to save product.' });
      }
      res.json({ id, ...req.body });
    }
  );
});

app.put('/api/products/:id', checkAuth, (req, res) => {
  const id = req.params.id;
  const { name, sku, barcode, category, price, stock, image, description, cost, threshold } = req.body;

  if (!name || !sku || !barcode || !category) {
    return res.status(400).json({ error: 'Name, SKU, barcode, and category are required.' });
  }

  db.run(
    'UPDATE products SET name = ?, sku = ?, barcode = ?, category = ?, price = ?, stock = ?, image = ?, description = ?, cost = ?, threshold = ? WHERE id = ?',
    [name, sku, barcode, category, Number(price) || 0, Number(stock) || 0, image || '/images/placeholder.svg', description || '', Number(cost) || 0, Number(threshold) || 0, id],
    function (err) {
      if (err) {
        console.error('Update product failed:', err.message);
        return res.status(500).json({ error: 'Unable to update product.' });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Product not found.' });
      }
      res.json({ id, ...req.body });
    }
  );
});

app.delete('/api/products/:id', checkAuth, (req, res) => {
  const id = req.params.id;
  db.run('DELETE FROM products WHERE id = ?', [id], function (err) {
    if (err) {
      console.error('Delete product failed:', err.message);
      return res.status(500).json({ error: 'Unable to delete product.' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Product not found.' });
    }
    res.json({ success: true });
  });
});

app.post('/api/checkout', checkAuth, (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const paymentMethod = String(req.body.paymentMethod || 'Unknown');
  const discountPercent = Number(req.body.discountPercent || 0);

  if (!items.length) {
    return res.status(400).json({ error: 'Cart is empty' });
  }

  const subtotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const discount = Math.max(0, Math.min(discountPercent, 100)) * subtotal / 100;
  const tax = Number(((subtotal - discount) * 0.08).toFixed(2));
  const total = Number((subtotal - discount + tax).toFixed(2));

  db.run(
    'INSERT INTO transactions (payment_method, subtotal, discount, tax, total) VALUES (?, ?, ?, ?, ?)',
    [paymentMethod, subtotal, discount, tax, total],
    function (err) {
      if (err) {
        console.error('Checkout insert failed:', err.message);
        return res.status(500).json({ error: 'Unable to save transaction' });
      }

      const transactionId = this.lastID;
      const insertItem = db.prepare(
        'INSERT INTO transaction_items (transaction_id, product_id, name, sku, unit_price, quantity, line_total) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );

      items.forEach((item) => {
        insertItem.run(
          transactionId,
          item.productId,
          item.name,
          item.sku,
          item.unitPrice,
          item.quantity,
          Number((item.unitPrice * item.quantity).toFixed(2))
        );
      });

      insertItem.finalize((err2) => {
        if (err2) {
          console.error('Checkout items insert failed:', err2.message);
          return res.status(500).json({ error: 'Unable to save transaction items' });
        }

        // Decrement stock for each item sold
        items.forEach((item) => {
          db.run(
            'UPDATE products SET stock = stock - ? WHERE id = ?',
            [item.quantity, item.productId],
            (stockErr) => {
              if (stockErr) {
                console.error(`Failed to update stock for product ${item.productId}:`, stockErr.message);
              }
            }
          );
        });

        res.json({ transactionId, total, subtotal, discount, tax });
      });
    }
  );
});

app.get('/api/transactions', (req, res) => {
  db.all('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 20', [], (err, rows) => {
    if (err) {
      console.error('Failed to load transactions:', err.message);
      return res.status(500).json({ error: 'Unable to load transactions' });
    }
    res.json(rows);
  });
});

server.listen(PORT, () => {
  console.log(`POS backend listening on http://localhost:${PORT}`);
});
