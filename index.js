// index.js
const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { pool } = require("./db");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const swaggerUi = require("swagger-ui-express");
const fs = require("fs");
const YAML = require("yaml");



const app = express();
app.use(cors());
app.use(express.json());

// Swagger docs
const file = fs.readFileSync("./docs/openapi.yaml", "utf8");
const spec = YAML.parse(file);
app.use("/docs", swaggerUi.serve, swaggerUi.setup(spec));


function signToken(user) {
    // only put minimal info in the token
    return jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: "7d" });
  }
  
  function requireAuth(req, res, next) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing token" });
  
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET); // { id, role, iat, exp }
      next();
    } catch (e) {
      return res.status(401).json({ error: "Invalid token" });
    }
  }

  function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "admin only" });
  }
  next();
}


  // --- Cart helpers ---
async function getOrCreateActiveCart(userId) {
  // try existing active
  const existing = await pool.query(
    "SELECT * FROM carts WHERE user_id = $1 AND status = 'active' LIMIT 1",
    [userId]
  );
  if (existing.rows.length) return existing.rows[0];

  // create one
  const created = await pool.query(
    "INSERT INTO carts (user_id) VALUES ($1) RETURNING *",
    [userId]
  );
  return created.rows[0];
}

async function getCartItems(cartId) {
  const { rows } = await pool.query(
    `SELECT ci.product_id,
            ci.quantity,
            p.name, p.description, p.price_cents, p.image_url
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
      WHERE ci.cart_id = $1
      ORDER BY ci.product_id`,
    [cartId]
  );
  return rows;
}

// GET current user's cart
app.get("/api/cart", requireAuth, async (req, res) => {
  try {
    const cart = await getOrCreateActiveCart(req.user.id);
    const items = await getCartItems(cart.id);
    res.json({ cart_id: cart.id, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to fetch cart" });
  }
});

// ADD/SET an item in cart
app.post("/api/cart/items", requireAuth, async (req, res) => {
  try {
    const { productId, quantity } = req.body;
    if (!Number.isInteger(productId) || productId <= 0)
      return res.status(400).json({ error: "productId must be a positive integer" });
    if (!Number.isInteger(quantity) || quantity <= 0)
      return res.status(400).json({ error: "quantity must be a positive integer" });

    // ensure product exists
    const prod = await pool.query("SELECT id FROM products WHERE id = $1", [productId]);
    if (prod.rows.length === 0) return res.status(404).json({ error: "product not found" });

    const cart = await getOrCreateActiveCart(req.user.id);

    // upsert: set quantity
    await pool.query(
      `INSERT INTO cart_items (cart_id, product_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (cart_id, product_id)
       DO UPDATE SET quantity = EXCLUDED.quantity`,
      [cart.id, productId, quantity]
    );

    const items = await getCartItems(cart.id);
    res.status(201).json({ cart_id: cart.id, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to add item" });
  }
});

// UPDATE quantity
app.patch("/api/cart/items/:productId", requireAuth, async (req, res) => {
  try {
    const productId = Number(req.params.productId);
    const { quantity } = req.body;
    if (!Number.isInteger(productId) || productId <= 0)
      return res.status(400).json({ error: "invalid productId" });
    if (!Number.isInteger(quantity) || quantity <= 0)
      return res.status(400).json({ error: "quantity must be a positive integer" });

    const cart = await getOrCreateActiveCart(req.user.id);
    const result = await pool.query(
      "UPDATE cart_items SET quantity = $1 WHERE cart_id = $2 AND product_id = $3",
      [quantity, cart.id, productId]
    );
    if (result.rowCount === 0)
      return res.status(404).json({ error: "item not in cart" });

    const items = await getCartItems(cart.id);
    res.json({ cart_id: cart.id, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to update item" });
  }
});

// REMOVE item
app.delete("/api/cart/items/:productId", requireAuth, async (req, res) => {
  try {
    const productId = Number(req.params.productId);
    if (!Number.isInteger(productId) || productId <= 0)
      return res.status(400).json({ error: "invalid productId" });

    const cart = await getOrCreateActiveCart(req.user.id);
    const result = await pool.query(
      "DELETE FROM cart_items WHERE cart_id = $1 AND product_id = $2",
      [cart.id, productId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "item not in cart" });

    const items = await getCartItems(cart.id);
    res.json({ cart_id: cart.id, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to remove item" });
  }
});

// PLACE ORDER: converts active cart into an order (transaction)
app.post("/api/orders", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const cart = await getOrCreateActiveCart(req.user.id);
    const items = await client.query(
      `SELECT ci.product_id, ci.quantity, p.price_cents
         FROM cart_items ci
         JOIN products p ON p.id = ci.product_id
        WHERE ci.cart_id = $1
        ORDER BY ci.product_id`,
      [cart.id]
    );

    if (items.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "cart is empty" });
    }

    const total = items.rows.reduce(
      (sum, r) => sum + r.quantity * r.price_cents,
      0
    );

    const orderIns = await client.query(
      `INSERT INTO orders (user_id, total_cents)
       VALUES ($1, $2)
       RETURNING id, user_id, total_cents, status, created_at`,
      [req.user.id, total]
    );
    const order = orderIns.rows[0];

    // order items snapshot
    for (const r of items.rows) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, unit_price_cents, quantity)
         VALUES ($1, $2, $3, $4)`,
        [order.id, r.product_id, r.price_cents, r.quantity]
      );
    }

    // mark cart converted & clear items
    await client.query("UPDATE carts SET status = 'converted' WHERE id = $1", [cart.id]);

    await client.query("COMMIT");
    res.status(201).json({ order });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "failed to place order" });
  } finally {
    client.release();
  }
});

// LIST my orders (with items)
app.get("/api/orders", requireAuth, async (req, res) => {
  try {
    const { rows: orders } = await pool.query(
      "SELECT * FROM orders WHERE user_id = $1 ORDER BY id DESC",
      [req.user.id]
    );

    // fetch items per order
    const ids = orders.map(o => o.id);
    let itemsByOrder = {};
    if (ids.length) {
      const { rows } = await pool.query(
        `SELECT oi.order_id, oi.product_id, oi.unit_price_cents, oi.quantity, p.name, p.image_url
           FROM order_items oi
           JOIN products p ON p.id = oi.product_id
          WHERE oi.order_id = ANY($1::int[])
          ORDER BY oi.order_id, oi.product_id`,
        [ids]
      );
      for (const r of rows) {
        itemsByOrder[r.order_id] = itemsByOrder[r.order_id] || [];
        itemsByOrder[r.order_id].push(r);
      }
    }

    const result = orders.map(o => ({
      ...o,
      items: itemsByOrder[o.id] || []
    }));

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to list orders" });
  }
});


  app.get("/health", (req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  // NEW: DB ping
app.get("/db-ping", async (req, res) => {
    try {
      const result = await pool.query("SELECT 1 as ok");
      res.json({ db: "up", result: result.rows[0] });
    } catch (err) {
      console.error(err);
      res.status(500).json({ db: "down", error: err.message });
    }
  });
  

// GET all products with search & pagination (pure JS)
app.get("/api/products", async (req, res) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const min = req.query.min !== undefined ? Number(req.query.min) : undefined;
    const max = req.query.max !== undefined ? Number(req.query.max) : undefined;

    const page = req.query.page !== undefined ? String(req.query.page) : "1";
    const limit = req.query.limit !== undefined ? String(req.query.limit) : "10";

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10)));
    const offset = (pageNum - 1) * limitNum;

    const conditions = [];
    const params = [];
    let p = 1;

    if (q) {
      conditions.push(`(name ILIKE $${p} OR description ILIKE $${p + 1})`);
      params.push(`%${q}%`, `%${q}%`);
      p += 2;
    }
    if (!Number.isNaN(min)) {
      conditions.push(`price_cents >= $${p}`);
      params.push(min);
      p += 1;
    }
    if (!Number.isNaN(max)) {
      conditions.push(`price_cents <= $${p}`);
      params.push(max);
      p += 1;
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    // total count for current filter
    const countSql = `SELECT COUNT(*)::int AS count FROM products ${where}`;
    const { rows: countRows } = await pool.query(countSql, params);
    const total = countRows[0]?.count ?? 0;

    // page data
    const dataSql = `
      SELECT id, name, description, price_cents, image_url
      FROM products
      ${where}
      ORDER BY id
      LIMIT $${p} OFFSET $${p + 1}
    `;
    const { rows } = await pool.query(dataSql, [...params, limitNum, offset]);

    res.json({
      page: pageNum,
      limit: limitNum,
      total,
      pages: Math.max(1, Math.ceil(total / limitNum)),
      data: rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});



  // CREATE a product
app.post("/api/products",requireAuth, requireAdmin, async (req, res) => {
    try {
      const { name, description, price_cents, image_url } = req.body;
  
      // basic validation
      if (!name || typeof name !== "string") {
        return res.status(400).json({ error: "name is required (string)" });
      }
      if (!Number.isInteger(price_cents) || price_cents < 0) {
        return res.status(400).json({ error: "price_cents must be a non-negative integer" });
      }
  
      const { rows } = await pool.query(
        `INSERT INTO products (name, description, price_cents, image_url)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, description, price_cents, image_url`,
        [name, description ?? null, price_cents, image_url ?? null]
      );
  
      res.status(201).json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to create product" });
    }
  });

  // UPDATE a product (partial)
app.patch("/api/products/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
  
      const { name, description, price_cents, image_url } = req.body;
  
      if (price_cents !== undefined && (!Number.isInteger(price_cents) || price_cents < 0)) {
        return res.status(400).json({ error: "price_cents must be a non-negative integer" });
      }
  
      // Use COALESCE to keep existing values when a field is not provided
      const { rows } = await pool.query(
        `UPDATE products
         SET
           name = COALESCE($1, name),
           description = COALESCE($2, description),
           price_cents = COALESCE($3, price_cents),
           image_url = COALESCE($4, image_url),
           updated_at = NOW()
         WHERE id = $5
         RETURNING id, name, description, price_cents, image_url`,
        [
          name ?? null,
          description ?? null,
          price_cents ?? null,
          image_url ?? null,
          id
        ]
      );
  
      if (rows.length === 0) return res.status(404).json({ error: "Not found" });
      res.json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to update product" });
    }
  });
  
  // DELETE a product
  app.delete("/api/products/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
  
      const result = await pool.query("DELETE FROM products WHERE id = $1", [id]);
      if (result.rowCount === 0) return res.status(404).json({ error: "Not found" });
  
      res.status(204).send(); // No Content
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to delete product" });
    }
  });
  
  // REGISTER
app.post("/api/auth/register", async (req, res) => {
    try {
      const { email, password, role } = req.body;
  
      // super basic validation
      if (!email || typeof email !== "string" || !email.includes("@")) {
        return res.status(400).json({ error: "valid email is required" });
      }
      if (!password || typeof password !== "string" || password.length < 6) {
        return res.status(400).json({ error: "password must be at least 6 chars" });
      }
  
      const hash = bcrypt.hashSync(password, 10);
  
      const { rows } = await pool.query(
        `INSERT INTO users (email, password_hash, role)
         VALUES ($1, $2, COALESCE($3, 'user'))
         RETURNING id, email, role`,
        [email.toLowerCase(), hash, role]
      );
  
      const user = rows[0];
      const token = signToken(user);
      res.status(201).json({ user, token });
    } catch (err) {
      // unique violation: duplicate email
      if (err.code === "23505") {
        return res.status(409).json({ error: "email already registered" });
      }
      console.error(err);
      res.status(500).json({ error: "failed to register" });
    }
  });
  
  // LOGIN
  app.post("/api/auth/login", async (req, res) => {
    try {
      const { email, password } = req.body;
  
      if (!email || !password) return res.status(400).json({ error: "email and password required" });
  
      const { rows } = await pool.query(
        "SELECT id, email, role, password_hash FROM users WHERE email = $1",
        [email.toLowerCase()]
      );
      if (rows.length === 0) return res.status(401).json({ error: "invalid credentials" });
  
      const user = rows[0];
      const ok = bcrypt.compareSync(password, user.password_hash);
      if (!ok) return res.status(401).json({ error: "invalid credentials" });
  
      const token = signToken(user);
      // don’t leak password_hash
      delete user.password_hash;
      res.json({ user, token });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "failed to login" });
    }
  });
  
  // WHO AM I
  app.get("/api/users/me", requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        "SELECT id, email, role, created_at FROM users WHERE id = $1",
        [req.user.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: "user not found" });
      res.json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "failed to fetch user" });
    }
  });
  

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`API running on http://localhost:${PORT}`);
  });
}

module.exports = app; // ← so tests can import the app without starting a server

