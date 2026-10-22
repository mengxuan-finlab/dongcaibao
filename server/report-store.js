const { safeErrorMessage } = require('./gemini-runtime');

function createSupabaseReportStore({ client, now = Date.now, log = () => {}, timeoutMs = 2000 }) {
  let retryAt = 0;
  const failed = error => {
    retryAt = now() + 60000;
    log({ event: 'report_store_unavailable', errorSource: 'report_cache', code: error.code || null,
      message: safeErrorMessage(error), retryAt: new Date(retryAt).toISOString() });
  };
  return {
    async read(key) {
      if (now() < retryAt) return null;
      try {
        const { data, error } = await client.from('company_report_cache')
          .select('payload, expires_at').eq('cache_key', key)
          .gt('expires_at', new Date(now()).toISOString()).maybeSingle()
          .abortSignal(AbortSignal.timeout(timeoutMs));
        if (error) throw error;
        return data ? { value: data.payload, expires: Date.parse(data.expires_at) } : null;
      } catch (error) {
        failed(error);
        return null;
      }
    },
    async write(key, value, expires) {
      if (now() < retryAt) return;
      try {
        const { error } = await client.from('company_report_cache').upsert({
          cache_key: key, payload: value, expires_at: new Date(expires).toISOString(),
          updated_at: new Date(now()).toISOString()
        }, { onConflict: 'cache_key' }).abortSignal(AbortSignal.timeout(timeoutMs));
        if (error) throw error;
      } catch (error) { failed(error); }
    }
  };
}

module.exports = { createSupabaseReportStore };
