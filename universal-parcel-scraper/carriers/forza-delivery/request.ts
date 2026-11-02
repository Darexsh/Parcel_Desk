export const FORZA_ORIGIN = 'https://rastreo.forzadelivery.com';
export const FORZA_API = `${FORZA_ORIGIN}/fd2/Home.aspx/API`;

/** The current public page's guest lookup; private detail requests need a phone. */
export function forzaLookupBody(number: string): string {
  return JSON.stringify({ path: 'Tracking/GetNewDeliveryTracking', data: JSON.stringify({ Method: 'GetNewDeliveryTracking',
    Params: { GuideSerie: 'FD', GuideNumber: number.slice(2), TicketNumber: '', NirPhone: 0, Phone: 0 } }) });
}
