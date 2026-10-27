const VALID_SYMBOL = /^[A-Z0-9][A-Z0-9.\-]{0,19}$/;
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

function selectPeers(rows, symbol, profile = {}) {
  const candidates = (Array.isArray(rows) ? rows : []).flatMap(row => Array.isArray(row?.peersList)
    ? row.peersList.map(ticker => ({ symbol: ticker })) : [row]);
  const seen = new Set([symbol]);
  const selected = candidates.filter(row => {
    if (!row || typeof row.symbol !== 'string' || !VALID_SYMBOL.test(row.symbol) || seen.has(row.symbol)) return false;
    seen.add(row.symbol);
    return true;
  }).sort((a, b) => (finite(b.mktCap) || 0) - (finite(a.mktCap) || 0)).slice(0, 4)
    .map(row => ({ ticker: row.symbol,
      companyName: typeof row.companyName === 'string' && row.companyName.trim() ? row.companyName : row.symbol,
      comparisonType: 'fmp_peer' }));
  return [{ ticker: symbol, companyName: profile.companyName || symbol, comparisonType: 'target' }, ...selected];
}

function issuerKeys(profile) {
  const keys = [];
  if (/^\d+$/.test(String(profile.cik || '')) && Number(profile.cik) > 0) keys.push('cik:' + String(profile.cik).replace(/^0+/, ''));
  if (/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(profile.isin || '')) keys.push('isin:' + profile.isin);
  if (typeof profile.companyName === 'string' && profile.companyName.trim()) {
    keys.push('name:' + profile.companyName.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''));
  }
  return keys;
}

function calculateTtmMargin(rows, symbol, { quarterly = false, now = Date.now() } = {}) {
  if (!Array.isArray(rows)) return null;
  const validDate = row => typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date)
    && Number.isFinite(Date.parse(row.date)) && Date.parse(row.date) <= now
    && new Date(row.date).toISOString().slice(0, 10) === row.date;
  const candidates = rows.filter(row => row?.symbol === symbol && validDate(row))
    .sort((a, b) => b.date.localeCompare(a.date));
  let selected;
  if (quarterly) {
    const quarters = new Map();
    for (const row of candidates) {
      const year = Number(row.fiscalYear);
      if (!/^Q[1-4]$/.test(row.period || '') || !Number.isInteger(year) || year < 1900 || year > 3000) continue;
      const ordinal = year * 4 + Number(row.period.slice(1)) - 1;
      if (!quarters.has(ordinal)) quarters.set(ordinal, row);
    }
    const sequence = [...quarters.entries()].sort((a, b) => b[0] - a[0]).slice(0, 4);
    if (sequence.length !== 4 || sequence.some(([ordinal, row], index) => {
      if (!index) return false;
      const gap = (Date.parse(sequence[index - 1][1].date) - Date.parse(row.date)) / 86400000;
      return sequence[index - 1][0] - ordinal !== 1 || gap < 60 || gap > 120;
    })) return null;
    selected = sequence.map(([, row]) => row);
  } else selected = candidates.slice(0, 1);
  if (!selected.length || !/^[A-Z]{3}$/.test(selected[0].reportedCurrency || '')
      || selected.some(row => row.reportedCurrency !== selected[0].reportedCurrency
        || finite(row.revenue) === null || row.revenue <= 0 || finite(row.operatingIncome) === null)) return null;
  const revenue = selected.reduce((sum, row) => sum + row.revenue, 0);
  const income = selected.reduce((sum, row) => sum + row.operatingIncome, 0);
  const operatingMargin = income / revenue * 100;
  if (!Number.isFinite(revenue) || !Number.isFinite(income) || !Number.isFinite(operatingMargin)) return null;
  return { operatingMargin, operatingMarginSource: quarterly ? 'four_quarters' : 'income_statement_ttm',
    operatingMarginPeriodEnd: selected[0].date, operatingMarginCurrency: selected[0].reportedCurrency };
}

function normalizePeerMetrics(peer, metricsRows, ratiosRows, target) {
  const rowFor = rows => Array.isArray(rows) ? rows.find(row => row?.symbol === peer.ticker) || {} : {};
  const metrics = rowFor(metricsRows), ratios = rowFor(ratiosRows);
  const margin = finite(ratios.operatingProfitMarginTTM);
  const earnings = finite(ratios.netIncomePerShareTTM);
  const pe = finite(ratios.priceToEarningsRatioTTM);
  const ev = finite(metrics.evToEBITDATTM);
  const fcf = finite(metrics.freeCashFlowYieldTTM);
  return { ...peer, companyName: String(peer.companyName), isTarget: peer.ticker === target,
    operatingMargin: margin === null || !Number.isFinite(margin * 100) ? null : margin * 100,
    operatingMarginSource: margin === null ? null : 'ratios_ttm',
    peRatio: pe !== null && pe > 0 && (earnings === null || earnings > 0) ? pe : null,
    marketCap: finite(metrics.marketCap) > 0 ? metrics.marketCap : null,
    evToEbitda: ev !== null && ev > 0 ? ev : null,
    fcfYield: fcf !== null && Number.isFinite(fcf * 100) ? fcf * 100 : null,
    // Retrieval time is not a common fiscal period; retain any dates supplied by FMP.
    metricDate: typeof ratios.date === 'string' ? ratios.date : null };
}

function createValuationSnapshot(symbol, target, retrievedAt) {
  return { symbol, retrievedAt, source: 'Financial Modeling Prep',
    marketCap: target?.marketCap ?? null,
    currency: /^[A-Z]{3}$/.test(target?.currency || '') ? target.currency : null,
    peRatio: target?.peRatio ?? null, evToEbitda: target?.evToEbitda ?? null,
    fcfYield: target?.fcfYield ?? null };
}

function createPeerFeed({ fetchRows, discoverPeers, now = Date.now, log = () => {} }) {
  const cache = new Map(), pending = new Map();
  return async symbol => {
    const saved = cache.get(symbol);
    if (saved?.expires > now()) return saved.value;
    if (pending.has(symbol)) return pending.get(symbol);
    if (pending.size >= 2) return { status: 'busy', items: [] };
    const task = (async () => {
      const signal = AbortSignal.timeout(20000);
      let failed = false;
      let blocked = false;
      const read = async (endpoint, ticker, params = {}) => {
        if (signal.aborted || blocked) { failed = true; return []; }
        try { return await fetchRows(endpoint, ticker, { signal, params }); }
        catch (error) {
          failed = true;
          if ([401, 429].includes(error?.response?.status)) blocked = true;
          log({ event: 'peer_data_error', endpoint, ticker, status: error?.response?.status || null });
          return [];
        }
      };
      const [peers, profiles, targetMetrics, targetRatios] = await Promise.all([
        read('stock-peers', symbol), read('profile', symbol),
        read('key-metrics-ttm', symbol), read('ratios-ttm', symbol)
      ]);
      const profile = Array.isArray(profiles) ? profiles.find(row => row?.symbol === symbol) || {} : {};
      const initial = selectPeers(peers, symbol, profile);
      const selected = [{ ...initial[0], industry: profile.industry || null, sector: profile.sector || null,
        currency: profile.currency || null }];
      const seenSymbols = new Set([symbol]);
      const seenIssuers = new Set(issuerKeys(profile));
      const verifyCandidates = async candidates => {
        const unique = candidates.filter(peer => {
          if (seenSymbols.has(peer.ticker)) return false;
          seenSymbols.add(peer.ticker);
          return true;
        }).slice(0, 4);
        const verified = new Array(unique.length);
        let nextProfile = 0;
        await Promise.all(Array.from({ length: Math.min(2, unique.length) }, async () => {
          while (nextProfile < unique.length) {
            const index = nextProfile++, peer = unique[index];
            const rows = await read('profile', peer.ticker);
            const identity = Array.isArray(rows) ? rows.find(row => row?.symbol === peer.ticker) : null;
            if (!identity || typeof identity.companyName !== 'string' || !identity.companyName.trim()
                || identity.isEtf === true || identity.isFund === true || identity.isActivelyTrading === false) continue;
            if (peer.comparisonType === 'search_peer') {
              const nameKey = value => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
              const claimed = nameKey(peer.companyName), actual = nameKey(identity.companyName);
              if (claimed.length < 3 || !(claimed === actual || actual.startsWith(claimed) || claimed.startsWith(actual))) continue;
            }
            verified[index] = { ...peer, companyName: identity.companyName,
              industry: identity.industry || null, sector: identity.sector || null, identity };
          }
        }));
        for (const candidate of verified.filter(Boolean)) {
          const keys = issuerKeys(candidate.identity);
          if (keys.some(key => seenIssuers.has(key))) continue;
          keys.forEach(key => seenIssuers.add(key));
          const { identity, ...peer } = candidate;
          selected.push(peer);
          if (selected.length >= 5) break;
        }
      };
      await verifyCandidates(initial.slice(1));
      let discoverySources = [];
      let discoverySearchQueries = [];
      let discoveryEntryPointHtml = '';
      if (selected.length < 4 && discoverPeers && !signal.aborted && !blocked) {
        try {
          const discovery = await discoverPeers({ symbol, profile,
            existing: selected.map(peer => peer.ticker), signal });
          discoverySources = Array.isArray(discovery?.sources) ? discovery.sources.filter(source => {
            try { const url = new URL(source.url); return url.protocol === 'https:' && !url.username && !url.password; }
            catch { return false; }
          }) : [];
          discoverySearchQueries = Array.isArray(discovery?.searchQueries)
            ? discovery.searchQueries.filter(query => typeof query === 'string') : [];
          discoveryEntryPointHtml = typeof discovery?.searchEntryPointHtml === 'string' ? discovery.searchEntryPointHtml : '';
          // Search suggestions without tool evidence are not promoted to financial comparators.
          if (discoverySources.length) {
            const candidates = selectPeers(discovery.peers, symbol, profile).slice(1)
              .map(peer => ({ ...peer, comparisonType: 'search_peer' }));
            await verifyCandidates(candidates);
          }
        } catch {
          failed = true;
          log({ event: 'peer_discovery_failed', symbol });
        }
      }
      const items = new Array(selected.length);
      let next = 0;
      // Two company workers, two endpoints per company: at most four concurrent requests per report.
      await Promise.all(Array.from({ length: Math.min(2, selected.length) }, async () => {
        while (next < selected.length) {
          const index = next++, peer = selected[index];
          if (peer.ticker === symbol) {
            items[index] = normalizePeerMetrics(peer, targetMetrics, targetRatios, symbol);
            continue;
          }
          const [metrics, ratios] = await Promise.all([
            read('key-metrics-ttm', peer.ticker), read('ratios-ttm', peer.ticker)
          ]);
          items[index] = normalizePeerMetrics(peer, metrics, ratios, symbol);
        }
      }));
      // Resolve primary metrics for all companies before spending the shared budget on fallbacks.
      const missing = items.filter(item => item.operatingMargin === null);
      let nextMissing = 0;
      await Promise.all(Array.from({ length: Math.min(2, missing.length) }, async () => {
        while (nextMissing < missing.length && !signal.aborted) {
          const item = missing[nextMissing++];
          let calculated = calculateTtmMargin(await read('income-statement-ttm', item.ticker, { limit: 1 }), item.ticker, { now: now() });
          if (!calculated && !signal.aborted) {
            calculated = calculateTtmMargin(await read('income-statement', item.ticker, { period: 'quarter', limit: 8 }), item.ticker,
              { quarterly: true, now: now() });
          }
          if (calculated) Object.assign(item, calculated);
        }
      }));
      const target = items.find(item => item.isTarget);
      const comparable = ['operatingMargin', 'peRatio'].some(key => Number.isFinite(target?.[key])
        && items.some(item => !item.isTarget && Number.isFinite(item[key])));
      const value = { status: comparable ? 'ok' : 'unavailable', source: 'Financial Modeling Prep',
        retrievedAt: new Date(now()).toISOString(), items, discoverySources, discoverySearchQueries, discoveryEntryPointHtml };
      value.valuationData = createValuationSnapshot(symbol, target, value.retrievedAt);
      if (cache.size >= 128) cache.delete(cache.keys().next().value);
      cache.set(symbol, { value, expires: now() + (!failed && comparable ? 86400000 : 300000) });
      log({ event: 'peer_data_result', symbol, status: value.status, itemCount: items.length, partial: failed,
        searchPeerCount: items.filter(item => item.comparisonType === 'search_peer').length,
        calculatedCount: items.filter(item => ['income_statement_ttm', 'four_quarters'].includes(item.operatingMarginSource)).length });
      return value;
    })();
    pending.set(symbol, task);
    try { return await task; } finally { pending.delete(symbol); }
  };
}

module.exports = { selectPeers, calculateTtmMargin, normalizePeerMetrics, createValuationSnapshot, createPeerFeed };
