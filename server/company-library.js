function libraryError(message, statusCode = 503, code = 'COMPANY_LIBRARY_UNAVAILABLE') {
  return Object.assign(new Error(message), { statusCode, code });
}

function createCompanyLibrary(supabase) {
  async function rpc(name, args) {
    const { data, error } = await supabase.rpc(name, args);
    if (error) {
      console.error('[公司研究保存]', { operation: name, code: error.code });
      throw libraryError('公司研究保存服務暫時無法使用，請稍後再試。');
    }
    return data;
  }
  return {
    list: userId => rpc('company_library_state', { p_user_id: userId }),
    async read(userId, symbol) {
      const { data, error } = await supabase.from('company_saved_reports').select('payload')
        .eq('user_id', userId).eq('symbol', symbol).maybeSingle();
      if (error) throw libraryError('暫時無法讀取已保存報告。');
      if (!data) throw libraryError('找不到這份已保存報告。', 404, 'COMPANY_REPORT_NOT_FOUND');
      return { ...data.payload, saved: true };
    },
    remove: (userId, symbol) => rpc('company_library_remove', { p_user_id: userId, p_symbol: symbol }),
    async claim(userId, symbol, requestId) {
      const claim = await rpc('company_library_claim', { p_user_id: userId, p_symbol: symbol, p_request_id: requestId });
      if (claim?.status === 'saved') return { ...claim.payload, saved: true };
      if (claim?.status === 'reserved') return null;
      const limit = claim?.limit === 5 ? 5 : 3;
      const messages = {
        full: `最多可保存 ${limit} 檔公司研究，請先移除一檔再新增。移除不會退回本週額度。`,
        quota: `已達本週 ${limit} 份研究額度（含處理中的請求），已保存的報告仍可免費查看。`,
        busy: '這檔股票正在生成研究報告，請稍後從保存清單查看。'
      };
      throw libraryError(messages[claim?.status] || '公司研究保存服務暫時無法使用。',
        claim?.status === 'busy' ? 409 : ['full', 'quota'].includes(claim?.status) ? 403 : 503,
        `COMPANY_LIBRARY_${String(claim?.status || 'UNAVAILABLE').toUpperCase()}`);
    },
    finish: (requestId, payload) => rpc('company_library_finish', { p_request_id: requestId, p_payload: payload }),
    async release(requestId) {
      const { error } = await supabase.from('company_report_reservations').delete().eq('request_id', requestId);
      if (error) console.error('[公司研究保存]', { operation: 'release', code: error.code });
    }
  };
}

module.exports = { createCompanyLibrary };
