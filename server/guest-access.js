const { createHash } = require('crypto');

const LIMITS = { company_intro: 1, chat_query: 3 };
const entries = new Map();

function getEntry(address, now = Date.now()) {
  const day = Math.floor((now + 8 * 3600000) / 86400000);
  for (const [key, entry] of entries) {
    if (entry.day !== day) entries.delete(key);
  }
  const key = createHash('sha256').update(address || 'unknown').digest('hex');
  if (!entries.has(key)) {
    if (entries.size >= 10000) {
      const error = new Error('訪客試用目前繁忙，請登入後使用。');
      error.statusCode = 503;
      throw error;
    }
    entries.set(key, { day, used: { company_intro: 0, chat_query: 0 }, pending: { company_intro: 0, chat_query: 0 } });
  }
  return entries.get(key);
}

function getUsage(address, now) {
  return { plan: 'guest', used: { ...getEntry(address, now).used }, limits: LIMITS };
}

function reserve(address, action, now) {
  const entry = getEntry(address, now);
  if (entry.used[action] + entry.pending[action] >= LIMITS[action]) {
    const error = new Error('今日訪客試用額度已用完，登入免費會員即可使用更多。');
    error.statusCode = 403;
    error.loginRequired = true;
    throw error;
  }
  entry.pending[action] += 1;
  let settled = false;
  return success => {
    if (settled) return;
    settled = true;
    entry.pending[action] -= 1;
    if (success) entry.used[action] += 1;
  };
}

module.exports = { getUsage, reserve };
