export const demoPage = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Universal Parcel Scraper</title>
<style>body{max-width:44rem;margin:10vh auto;padding:1.5rem;font:16px system-ui;color:#173a36;background:#f4f6ef}h1{font-size:2.5rem}form{display:grid;gap:.8rem}input,select,button{font:inherit;padding:.8rem;border:1px solid #a0b8ae;border-radius:.5rem}button{background:#173a36;color:white;cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere}small{color:#516862}</style>
<h1>A parcel. One timeline.</h1><p>Look up a parcel with the sources enabled on this server.</p>
<form><input id="number" placeholder="Tracking number or carrier link" required aria-label="Tracking input">
<select id="carrier" aria-label="Carrier"><option value="">Detect carrier</option></select>
<input id="postcode" placeholder="Delivery postcode, if required" aria-label="Delivery postcode">
<input id="token" type="password" placeholder="Server token, if required" aria-label="Server token">
<button>Track parcel</button></form><p id="detection" role="status"></p><pre id="result"></pre>
<small>Detection runs in your browser. Tracking sends the number and any required inputs to this server and its enabled sources.</small>
<script type="module">
import { parseTrackingInput, CARRIER_CATALOG } from '/assets/scraper.js';
const field = id => document.getElementById(id);
for (const [id, carrier] of Object.entries(CARRIER_CATALOG)) {
 if (!carrier.selectable) continue;
 const option = document.createElement('option'); option.value = id; option.textContent = carrier.displayName; field('carrier').append(option);
}
field('number').addEventListener('input', () => {
 const match = parseTrackingInput(field('number').value);
 field('detection').textContent = match.confidence === 'high' ? CARRIER_CATALOG[match.carrier].displayName : 'Choose a carrier if detection is uncertain.';
});
document.querySelector('form').addEventListener('submit', async event => {
 event.preventDefault(); const button = document.querySelector('button'); button.disabled = true; field('result').textContent = 'Looking up history…';
 try {
  const match = parseTrackingInput(field('number').value);
  const token = field('token').value;
  const response = await fetch('/v1/track', { method:'POST', headers:{'Content-Type':'application/json', ...(token ? {Authorization:'Bearer '+token} : {})}, body:JSON.stringify({number:match.trackingNumber, carrier:field('carrier').value || undefined, postcode:field('postcode').value || undefined, trackingUrl:match.trackingUrl}) });
  field('result').textContent = JSON.stringify(await response.json(), null, 2);
 } catch { field('result').textContent = 'The tracking server could not be reached.'; }
 finally { button.disabled = false; }
});
</script></html>`;
