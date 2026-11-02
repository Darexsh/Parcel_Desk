import { createTracker } from 'universal-parcel-scraper/node';
const number = process.argv[2] ?? process.env.PARCEL_NUMBER;
if (!number) throw new Error('Supply a parcel number as an argument or PARCEL_NUMBER');
const tracker = createTracker({ chromiumPath: process.env.TRACKING_CHROMIUM_PATH,
  trawlUrl: process.env.FLARESOLVERR_URL });
console.log(JSON.stringify(await tracker.track({ number, carrier: process.argv[3] }), null, 2));
