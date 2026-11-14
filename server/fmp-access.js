function createFmpAccess({ auth, fetchRows, now = Date.now }) {
  const requests = new Map();
  const cache = new Map();
  const pending = new Map();

  async function requireMember(req, res, next) {
    res.set('Cache-Control', 'no-store');
    const token = req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token) return res.status(401).json({ error: '請先登入會員。' });
    let user;
    try {
      const result = await auth.getUser(token);
      if (!result.error) user = result.data?.user;
    } catch {
      return res.status(503).json({ error: '登入驗證暫時無法使用，請稍後再試。' });
    }
    if (!user || user.is_anonymous) return res.status(401).json({ error: '請先登入會員。' });
    const symbol = typeof req.query.symbol === 'string' ? req.query.symbol.trim().toUpperCase() : '';
    if (!/^[A-Z][A-Z0-9.\-]{0,19}$/.test(symbol)) {
      return res.status(400).json({ error: '請輸入有效格式的美股代碼。' });
    }
    const time = now();
    for (const [id, entry] of requests) if (entry.until <= time) requests.delete(id);
    const entry = requests.get(user.id) || { count: 0, until: time + 60000 };
    if (entry.count >= 20 || (!requests.has(user.id) && requests.size >= 10000)) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((entry.until - time) / 1000))));
      return res.status(429).json({ error: '圖表查詢過於頻繁，請稍後再試。' });
    }
    entry.count++;
    requests.set(user.id, entry);
    req.fmpSymbol = symbol;
    return next();
  }

  async function readRows(endpoint, symbol) {
    const key = `${endpoint}:${symbol}`;
    const saved = cache.get(key);
    if (saved?.expires > now()) return saved.rows;
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 4) {
      throw Object.assign(new Error('FMP_BUSY'), { statusCode: 429 });
    }
    const task = (async () => {
      const rows = await fetchRows(endpoint, symbol);
      if (!Array.isArray(rows)) throw new Error('FMP_INVALID_RESPONSE');
      if (cache.size >= 200) cache.delete(cache.keys().next().value);
      cache.set(key, { rows, expires: now() + 600000 });
      return rows;
    })();
    pending.set(key, task);
    try { return await task; }
    finally { pending.delete(key); }
  }

  return { requireMember, readRows };
}

module.exports = { createFmpAccess };
