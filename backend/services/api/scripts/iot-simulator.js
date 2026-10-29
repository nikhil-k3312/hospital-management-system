/**
 * IoT device simulator: plays the part of the seeded home-monitoring devices
 * and streams readings to the real ingestion endpoint (POST /api/devices/readings)
 * using each device's API key, exactly as physical hardware would.
 *
 *   npm run demo:iot                   one reading per device every 5 s
 *   npm run demo:iot -- --interval 2   every 2 s
 *   npm run demo:iot -- --spike        the next reading for each device is abnormal (raises alerts)
 *
 * Reads device keys from scripts/.demo-devices.json (written by the seed).
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '.demo-devices.json');
if (!fs.existsSync(file)) {
  console.error('No demo devices found. Run "npm run seed -- --reset" first.');
  process.exit(1);
}
const { apiBase, devices } = JSON.parse(fs.readFileSync(file, 'utf8'));
const argIndex = process.argv.indexOf('--interval');
const intervalSeconds = argIndex > -1 ? Number(process.argv[argIndex + 1]) : 5;
let spike = process.argv.includes('--spike');

const vary = (base, spread) => Math.round((base + (Math.random() * 2 - 1) * spread) * 10) / 10;

function readingFor(device) {
  if (spike) {
    return device.type === 'pulse_oximeter'
      ? { heartRate: Math.round(vary(128, 4)), spo2: Math.round(vary(89, 1)) }
      : { heartRate: Math.round(vary(124, 4)), systolic: Math.round(vary(168, 4)), diastolic: Math.round(vary(104, 3)), spo2: 96, temperature: vary(37.2, 0.2) };
  }
  if (device.type === 'pulse_oximeter') return { heartRate: Math.round(vary(80, 6)), spo2: Math.round(vary(97, 1)) };
  return {
    heartRate: Math.round(vary(74, 6)), systolic: Math.round(vary(126, 5)), diastolic: Math.round(vary(81, 3)),
    spo2: Math.round(vary(97.5, 1)), temperature: vary(36.8, 0.2),
  };
}

async function tick() {
  for (const device of devices) {
    const body = readingFor(device);
    try {
      const res = await fetch(`${apiBase}/api/devices/readings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-device-key': device.apiKey },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      const flag = json.data?.abnormal?.length ? `  ALERT: ${json.data.abnormal.join(', ')}` : '';
      console.log(`${new Date().toLocaleTimeString()}  ${device.serialNumber} (${device.patient})  ${res.status}  ${JSON.stringify(body)}${flag}`);
    } catch (error) {
      console.error(`${device.serialNumber}: cannot reach ${apiBase} (${error.message}). Is the API running?`);
    }
  }
  spike = false; // a spike is a single abnormal burst
}

console.log(`Streaming ${devices.length} device(s) to ${apiBase} every ${intervalSeconds}s. Ctrl+C to stop.`);
tick();
setInterval(tick, intervalSeconds * 1000);
