'use strict';

// Supports both storage formats:
//   New: "Харьков, Харьковская область, Украина"  → city / region / country
//   Old: "Харьков"                                → city only (legacy)

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseLocation(locationStr) {
  if (!locationStr) return { city: null, region: null, country: null };
  const parts = locationStr.split(',').map(s => s.trim()).filter(Boolean);
  return {
    city: parts[0] || null,
    region: parts[1] || null,
    country: parts[2] || null,
  };
}

/**
 * Returns a MongoDB regex pattern string for the given location + expansion level,
 * or null if no location filter should be applied (show all users).
 *
 * Levels:
 *   0 — city   (e.g. "Харьков")
 *   1 — region (e.g. "Харьковская область")
 *   2 — country(e.g. "Украина")
 *   3 — all users (no filter)
 *
 * Old-format users (city only, no commas) are visible at level 0.
 * At levels 1–2 they are missed until the user updates their location.
 */
function buildLocationPattern(location, expansionLevel) {
  if (!location) return null;

  const level = Number(expansionLevel) || 0;
  if (level >= 3) return null;

  const { city, region, country } = parseLocation(location);

  switch (level) {
    case 0: return city    ? escapeRegex(city)    : null;
    case 1: return region  ? escapeRegex(region)  : null;
    case 2: return country ? escapeRegex(country) : null;
    default: return null;
  }
}

module.exports = { buildLocationPattern };
