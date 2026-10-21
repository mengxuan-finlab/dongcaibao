const ADOPTION_API = 'https://data.moa.gov.tw/Service/OpenData/TransService.aspx';
const ADOPTION_SOURCE = 'https://data.gov.tw/dataset/85903';
const ADOPTION_URL = 'https://www.pet.gov.tw/AnimalApp/AnnounceMent.aspx?PageType=Adopt';

function normalizeAnimal(row) {
  if (!row || row.animal_status !== 'OPEN' || !['貓', '狗'].includes(row.animal_kind)) return null;
  let photo;
  try {
    photo = new URL(row.album_file);
    if (photo.protocol !== 'https:' || !photo.hostname.endsWith('.gov.tw') || photo.username || photo.password) return null;
  } catch { return null; }
  const text = value => String(value || '').trim().slice(0, 200);
  if (!text(row.animal_id) || !text(row.shelter_name)) return null;
  return {
    id: text(row.animal_id), reference: text(row.animal_subid), kind: row.animal_kind,
    variety: text(row.animal_Variety), shelter: text(row.shelter_name),
    location: text(row.animal_place), photo: photo.href,
    sourceUpdatedAt: text(row.animal_update || row.cDate), url: ADOPTION_URL
  };
}

function createAdoptionFeed({ fetchRows, now = Date.now, random = Math.random, ttlMs = 3600000, retryMs = 300000 }) {
  let animals = [];
  let fetchedAt = null;
  let expiresAt = 0;
  let pending;
  return async () => {
    if (now() >= expiresAt) {
      if (!pending) {
        pending = Promise.resolve().then(fetchRows).then(rows => {
          if (!Array.isArray(rows)) throw new Error('Invalid adoption response');
          const seen = new Set();
          animals = rows.map(normalizeAnimal).filter(animal => {
            if (!animal || seen.has(animal.id)) return false;
            seen.add(animal.id);
            return true;
          });
          fetchedAt = new Date(now()).toISOString();
          expiresAt = now() + (animals.length ? ttlMs : retryMs);
        }).catch(() => {
          // Do not keep promoting stale records after a failed refresh.
          animals = [];
          fetchedAt = null;
          expiresAt = now() + retryMs;
        }).finally(() => { pending = null; });
      }
      await pending;
    }
    return {
      animal: animals.length ? animals[Math.floor(random() * animals.length)] : null,
      fetchedAt, source: ADOPTION_SOURCE, url: ADOPTION_URL
    };
  };
}

module.exports = { ADOPTION_API, normalizeAnimal, createAdoptionFeed };
