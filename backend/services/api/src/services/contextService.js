const net = require('net');
const geoip = require('geoip-lite');
const config = require('../config/config');
const { sha256 } = require('../utils/hash');

/**
 * Dynamic login: a context-aware trust score computed on the server.
 *
 *   Trust score = Location (35) + Device (25) + Time (20) + Network (20) - Behaviour penalty
 *               clamped to 0..100
 *
 *   Location  distance between where the IP address is (offline GeoIP database) and
 *             where the browser says it is (GPS): < 50 km 35, < 350 km 20, farther 5
 *             (likely VPN or spoofed position); either side unknown 15
 *   Device    this user's trusted browser (cookie + same user-agent) 25, otherwise 10
 *   Time      inside duty hours (hospital time zone) 20, otherwise 10
 *   Network   hospital network (configured address ranges) 20, a network this user
 *             signed in from before 15, a new network 5
 *   Behaviour failed attempts (password, code or security answer) since the last
 *             successful login: minus 10 each, at most minus 30
 *
 *   score > 80   low risk     password only
 *   50 - 80      medium risk  password + emailed code
 *   score < 50   high risk    password + emailed code + security question
 *
 * The IP is observed by the server and never taken from the browser. Only hashes of
 * the IP and of the network prefix are stored; GPS coordinates are used and discarded.
 */
const WEIGHTS = { location: 35, device: 25, time: 20, network: 20 };
const BEHAVIOUR_PENALTY = { perFailure: 10, max: 30 };
const MAX_KNOWN_NETWORKS = 10;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** "::ffff:10.1.2.3" -> "10.1.2.3" (Express reports IPv4 clients this way on dual-stack sockets). */
function normaliseIp(ip) {
  if (!ip) return '';
  return ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
}

/** The network an address belongs to: IPv4 /24 or IPv6 /48. */
function networkPrefix(ip) {
  const addr = normaliseIp(ip);
  if (net.isIPv4(addr)) return `${addr.split('.').slice(0, 3).join('.')}.0/24`;
  if (net.isIPv6(addr)) return `${addr.split(':').slice(0, 3).join(':')}::/48`;
  return 'unknown';
}

function hospitalBlockList(cidrs = config.context.hospitalNetworks) {
  const list = new net.BlockList();
  cidrs.forEach((cidr) => {
    const [addr, bits] = cidr.split('/');
    const type = net.isIPv6(addr) ? 'ipv6' : 'ipv4';
    if (bits === undefined) list.addAddress(addr, type);
    else list.addSubnet(addr, Number(bits), type);
  });
  return list;
}

function isHospitalNetwork(ip) {
  const addr = normaliseIp(ip);
  if (!addr || !config.context.hospitalNetworks.length) return false;
  return hospitalBlockList().check(addr, net.isIPv6(addr) ? 'ipv6' : 'ipv4');
}

/** Hour of day in the hospital's time zone. */
function localHour(now = new Date(), timeZone = config.context.timezone) {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(now));
}

function validGps(gps) {
  return gps && Number.isFinite(gps.lat) && Number.isFinite(gps.lon) && Math.abs(gps.lat) <= 90 && Math.abs(gps.lon) <= 180;
}

const service = {
  WEIGHTS,
  BEHAVIOUR_PENALTY,

  /** Offline lookup (MaxMind GeoLite data bundled with geoip-lite): no request leaves the server. */
  lookupGeo(ip) {
    const hit = geoip.lookup(normaliseIp(ip));
    if (!hit || !hit.ll) return null;
    return { lat: hit.ll[0], lon: hit.ll[1], city: hit.city || '', country: hit.country || '' };
  },

  locationScore(ipGeo, gps) {
    if (!ipGeo || !validGps(gps)) return { score: 15, category: 'Location unknown', distanceKm: null };
    const distanceKm = haversineKm(ipGeo.lat, ipGeo.lon, gps.lat, gps.lon);
    if (distanceKm < 50) return { score: 35, category: 'IP and GPS agree', distanceKm };
    if (distanceKm < 350) return { score: 20, category: 'IP and GPS in the same region', distanceKm };
    return { score: 5, category: 'IP far from GPS (possible VPN)', distanceKm };
  },

  networkScore(ip, user) {
    if (isHospitalNetwork(ip)) return { score: 20, category: 'Hospital network' };
    const prefixHash = sha256(networkPrefix(ip));
    if ((user.knownNetworks || []).some((n) => n.prefixHash === prefixHash)) return { score: 15, category: 'Known network' };
    return { score: 5, category: 'New network' };
  },

  timeScore(now = new Date()) {
    const hour = localHour(now);
    const { dutyStartHour, dutyEndHour } = config.context;
    const onDuty = hour >= dutyStartHour && hour < dutyEndHour;
    return { score: onDuty ? 20 : 10, category: onDuty ? 'Duty hours' : 'Off hours', hour };
  },

  behaviourPenalty(user) {
    const failures = user.failedLoginAttempts || 0;
    const penalty = Math.min(BEHAVIOUR_PENALTY.max, failures * BEHAVIOUR_PENALTY.perFailure);
    return { score: penalty ? -penalty : 0, failures, category: failures ? `${failures} failed attempt(s) since the last login` : 'No failed attempts' };
  },

  tierFor(score) {
    if (score > 80) return { risk: 'low', tier: 'full', factors: ['password'] };
    if (score >= 50) return { risk: 'medium', tier: 'limited', factors: ['password', 'otp'] };
    return { risk: 'high', tier: 'restricted', factors: ['password', 'otp', 'security_question'] };
  },

  /**
   * Scores one login attempt.
   * @param {object} p
   * @param {import('express').Request} p.req   gives the IP (server-observed)
   * @param {object} p.user                     the account trying to sign in
   * @param {boolean} p.deviceKnown             true when the trusted-device cookie matched this user
   * @param {{lat:number, lon:number}} [p.gps]  browser position, if the user allowed it
   */
  assess({ req, user, deviceKnown, gps, now = new Date() }) {
    const ip = normaliseIp(req.ip);
    const ipGeo = service.lookupGeo(ip);
    const location = service.locationScore(ipGeo, gps);
    const device = { score: deviceKnown ? 25 : 10, category: deviceKnown ? 'Trusted browser' : 'New browser' };
    const time = service.timeScore(now);
    const network = service.networkScore(ip, user);
    const behaviour = service.behaviourPenalty(user);
    const score = Math.max(0, Math.min(100, location.score + device.score + time.score + network.score + behaviour.score));
    const { risk, tier, factors } = service.tierFor(score);

    // Without a security question on file, the strongest factor available is the emailed code.
    const required = factors.filter((f) => f !== 'security_question' || user.securityAnswerHash);

    return {
      score,
      risk,
      tier,
      factors: required,
      breakdown: {
        location: { ...location, max: WEIGHTS.location, distanceKm: location.distanceKm === null ? null : Math.round(location.distanceKm),
          ipCity: ipGeo ? [ipGeo.city, ipGeo.country].filter(Boolean).join(', ') : null },
        device: { ...device, max: WEIGHTS.device },
        time: { ...time, max: WEIGHTS.time },
        network: { ...network, max: WEIGHTS.network },
        behaviour: { ...behaviour, max: 0, min: -BEHAVIOUR_PENALTY.max },
      },
      ipHash: sha256(ip),
      networkPrefixHash: sha256(networkPrefix(ip)),
    };
  },

  /** After a successful login, remember the network so the next login scores it as known. */
  rememberNetwork(user, assessment) {
    const others = (user.knownNetworks || []).filter((n) => n.prefixHash !== assessment.networkPrefixHash);
    user.knownNetworks = [...others, { prefixHash: assessment.networkPrefixHash, lastSeenAt: new Date() }].slice(-MAX_KNOWN_NETWORKS);
  },

  // exposed for tests
  haversineKm,
  networkPrefix,
  normaliseIp,
  localHour,
};

module.exports = service;
