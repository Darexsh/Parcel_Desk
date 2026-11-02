import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeStatusWording, statusMapAnswer } from '../../app.js';
import { seventeenTrackEvent } from '../../providers/seventeentrack/events.js';
import { event } from '../../providers/shared/result.js';
import { statusMap as universal } from '../../providers/status.js';
import type { CarrierEvent } from '../result/index.js';
import type { CarrierStatusMap } from '../status/statusMap.js';
import { classifyWording } from '../status/wording.js';
import { STATUS_MAPS } from './statusMaps.js';
import ceskaPosta from '../../carriers/ceska-posta/statuses.json' with { type: 'json' };

const carriers = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../carriers');
const answer = (carrier: string, providerCode: string | null, description: string) => statusMapAnswer({ carrier, providerCode, description });
const mapped = (stage: string) => ({ kind: 'mapped', stage });
const gap = { kind: 'intentional_gap', note: expect.any(String) };
const unknown = { kind: 'unknown' };

describe('status map answers', () => {
  it('normalizes wording as the app keys its observations', () => {
    expect(normalizeStatusWording('  Parcel\thanded   to DPD\n')).toBe('parcel handed to dpd');
    const long = `${'A'.repeat(499)} B C`;
    expect(normalizeStatusWording(long)).toBe(`${'a'.repeat(499)} `);
    // Stored wording can be asked again as it is.
    expect(normalizeStatusWording('parcel handed to dpd')).toBe('parcel handed to dpd');
  });

  it("answers DPD's codes, and the codes and labels it leaves unmapped on purpose", () => {
    expect(answer('dpd', 'DLO', 'Your parcel is out for delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('dpd', 'HUI', 'Your parcel arrived at our hub')).toEqual(mapped('in_transit'));
    expect(answer('dpd', 'DELIVERED', 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('dpd', 'PARCEL_HANDED', 'Parcel handed to DPD')).toEqual({
      kind: 'intentional_gap',
      note: "DPD's map leaves it unmapped on purpose: it moves the parcel in transit without a milestone of its own.",
    });
    for (const code of ['IN_TRANSIT', 'AT_DELIVERY_CENTER', 'ORI', 'SPL', 'OTHER', 'SPE', 'MSDLO', 'MIDLI', 'MIA', 'MII', 'ENA']) {
      expect(answer('dpd', code, 'Any wording at all'), code).toEqual(gap);
    }
    // A label gap covers that wording without a code, and only then.
    expect(answer('dpd', null, '  Your parcel is ON its way')).toEqual({
      kind: 'intentional_gap', note: "The label of IN_TRANSIT, which DPD's map leaves unmapped on purpose.",
    });
    // The recipient's delivery instruction and its receipt keep the stage wherever they come without their codes.
    expect(answer('dpd', null, 'Your parcel will be delivered to a safe place according to your instructions')).toEqual({
      kind: 'intentional_gap', note: expect.stringMatching(/keeps the stage it had/),
    });
    expect(answer('dpd', null, 'We received your delivery instructions')).toEqual({
      kind: 'intentional_gap', note: expect.stringMatching(/keeps the stage it had/),
    });
    expect(answer('dpd', 'ZZZ', 'Your parcel is on its way')).toEqual(unknown);
    // A code gap covers no wording that came without the code.
    expect(answer('dpd', null, 'Your parcel arrived at our depot')).toEqual(unknown);
    expect(answer('dpd', null, 'Parcel out for delivery')).toEqual(unknown);
  });

  it("answers DPD Germany's app scans by their wording, and its guest API by DPD's codes", () => {
    expect(answer('dpd-de', null, 'Picked up from Pickup parcelshop by consignee.')).toEqual(mapped('delivered'));
    expect(answer('dpd-de', null, 'delivered by driver to dpd pickup parcelshop/ station.')).toEqual(mapped('ready_for_pickup'));
    expect(answer('dpd-de', null, 'Pickup ordered for: 05.01.2026')).toEqual(mapped('registered'));
    expect(answer('dpd-de', null, 'Parcel handed to DPD')).toEqual(mapped('accepted'));
    expect(answer('dpd-de', 'DLO', 'Your parcel is out for delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('dpd-de', 'PARCEL_HANDED', 'Parcel handed to DPD')).toEqual(gap);
    expect(answer('dpd-de', 'DEX', "We couldn't deliver your parcel, it will soon be available at a retrieval point")).toEqual(mapped('failed_attempt'));
    expect(answer('dpd-de', 'DEHDY', 'Your parcel has been delivered to the retrieval point')).toEqual(mapped('ready_for_pickup'));
    expect(answer('dpd-de', 'DODEYY', 'We received the proof of delivery')).toEqual(gap);
    // The Swiss page's labels are not read for German lookups.
    expect(answer('dpd-de', null, 'Your parcel is on its way')).toEqual(unknown);
    expect(answer('dpd-de', null, 'Picked up')).toEqual(unknown);
  });

  it('answers the other declared maps by their own keys', () => {
    expect(answer('gofo-fr', '205', 'Livré')).toEqual(mapped('delivered'));
    expect(answer('gofo-it', '205', 'Consegnato')).toEqual(mapped('delivered'));
    expect(answer('gofo-fr', '205', 'Consegnato')).toEqual(unknown);
    expect(answer('gofo-it', '205', 'Livré')).toEqual(unknown);
    expect(answer('gofo-fr', '206', "Échec de la livraison, motif : Le destinataire n'est pas chez lui")).toEqual(mapped('failed_attempt'));
    expect(answer('gofo-it', '206', 'Consegna fallita, tipo:Destinatario assente')).toEqual(mapped('failed_attempt'));
    expect(answer('gofo-fr', '206', 'Alerte')).toEqual(mapped('exception'));
    expect(answer('gofo-nl', '205', 'Bezorgd in de brievenbus')).toEqual(mapped('delivered'));
    expect(answer('gofo-nl', '205', 'Consegnato')).toEqual(unknown);
    expect(answer('gofo-nl', '206', 'Waarschuwing')).toEqual(mapped('exception'));
    expect(answer('gofo-es', '205', 'Entregado por En el buzón, PIN: No')).toEqual(mapped('delivered'));
    expect(answer('gofo-es', '205', 'Consegnato')).toEqual(unknown);
    expect(answer('gofo-es', '206', 'Entrega fallida')).toEqual(mapped('failed_attempt'));
    expect(answer('gofo-es', '206', 'Alerta')).toEqual(mapped('exception'));
    expect(answer('omgo', null, 'Completed Unloading at Delivery Location')).toEqual(mapped('in_transit'));
    expect(answer('omgo', null, 'Tendered for Delivery')).toEqual(mapped('in_transit'));
    expect(answer('tnt', 'RES', 'Shipment delivered in good condition')).toEqual(mapped('delivered'));
    expect(answer('tnt', null, 'Livré')).toEqual(mapped('delivered'));
    expect(answer('tnt', 'ZZ', 'Shipment delivered in good condition')).toEqual(unknown);
    expect(answer('postlogistics', 'DLV', 'Livré')).toEqual(mapped('delivered'));
    expect(answer('postlogistics', 'IMG', 'IMAGE')).toEqual(gap);
    expect(answer('postlogistics', null, 'Image')).toEqual(unknown);
    expect(answer('ups', 'OF', 'Out For Delivery Today')).toEqual(mapped('out_for_delivery'));
    expect(answer('ups', 'PC', 'RFID Confirmed Pickup')).toEqual(mapped('accepted'));
    expect(answer('gofo', '414', 'In Transit to Next Facility')).toEqual(mapped('in_transit'));
    expect(answer('gofo', '810', 'In Transit to Next Facility')).toEqual(mapped('in_transit'));
    expect(answer('gofo', '802', 'Pickup Exception, GOFO has not Received the Package from the Warehouse yet.')).toEqual(mapped('registered'));
    expect(answer('gofo', '205', 'Delivered, In Mailbox')).toEqual(mapped('delivered'));
    expect(answer('gofo', '205', 'Synthetic scan')).toEqual(unknown);
    expect(answer('gofo', '202', 'Arrived at GOFO Regional Origin Hub')).toEqual(mapped('accepted'));
    expect(answer('gofo', '202', 'Arrived at GOFO Regional Hub')).toEqual(mapped('in_transit'));
    expect(answer('aliexpress', 'GTMS_ORDER_INFO_UPDATE', 'Delivery details updated')).toEqual(gap);
    // Without a code, UPS's map reads only the rendered page's banner.
    expect(answer('ups', null, 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('ups', null, 'Arrived at Facility')).toEqual(unknown);
    expect(answer('ups', 'ZZ', 'Delivered')).toEqual(unknown);
    expect(answer('yunexpress', null, 'Arrived at GOFO Regional Destination Facility')).toEqual(mapped('in_transit'));
    expect(answer('yunexpress', null, 'REMINDER EMAIL SENT FAILED')).toEqual(gap);
    expect(answer('yunexpress', null, 'Shipping Label Created')).toEqual(mapped('registered'));
    expect(answer('yunexpress', null, 'Shipment is in transit to carrier')).toEqual(mapped('in_transit'));
    expect(answer('yunexpress', null, 'Delivery failed, type: Recipient absent or delivery location inaccessible. We will attempt redelivery soon.'))
      .toEqual(mapped('failed_attempt'));
    expect(answer('yunexpress', null, 'The parcel is being stored in the GLS parcel center. It could not be delivered as the parcel box was occupied.'))
      .toEqual(mapped('failed_attempt'));
    // A card left after a transfer, stored with or without the courier page's markup around it.
    expect(answer('yunexpress', null, '1 item has been transferred to Example (synthville) CARD LEFT')).toEqual(mapped('failed_attempt'));
    expect(answer('yunexpress', null, "1 item has been transferred to Example (synthville) <b><a href='/Contact?tracNum=CP000000000001'>CARD LEFT</a></b>"))
      .toEqual(mapped('failed_attempt'));
    // Ecoscooting's last mile as the feed relays it: its acceptance is a hand-over, its missed round carries a reason.
    expect(answer('yunexpress', null, 'Your shipment has been accepted by delivery carrier')).toEqual(mapped('in_transit'));
    expect(answer('yunexpress', null, 'Your shipment has been processed at sorting center and ready for shipping')).toEqual(mapped('in_transit'));
    expect(answer('yunexpress', null, 'Your shipment is out for delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('yunexpress', null, 'Your shipment delivery attempt failed [Recipient address unknown/incorrect]')).toEqual(mapped('failed_attempt'));
    expect(answer('yunexpress', null, 'Your shipment delivery attempt failed')).toEqual(mapped('failed_attempt'));
    expect(answer('yunexpress', null, 'Your shipment delivery attempt failed [Example] and was returned')).toEqual(unknown);
    expect(answer('four-px', 'FPX_O_IR', 'Order information has been transmitted to DPD.')).toEqual(mapped('registered'));
    expect(answer('four-px', 'FPX_O_IR', 'Order information has been transmitted to Example Post.')).toEqual(mapped('registered'));
    expect(answer('four-px', 'FPX_O_IR', 'Label creation')).toEqual(mapped('registered'));
    expect(answer('four-px', 'FPX_O_IR', 'Manifest created')).toEqual(mapped('in_transit'));
    expect(answer('j-and-t-au', null, 'Your parcel is out for delivery. If you have any questions, please call, Thank you for your patience.')).toEqual(mapped('out_for_delivery'));
    expect(answer('j-and-t-au', null, 'Your parcel has been delivered.If you have any questions,please call. We look forward to serving you again.')).toEqual(mapped('delivered'));
    expect(answer('dhl-express', 'PL', 'Processed at EXAMPLE CITY - FRANCE')).toEqual(mapped('in_transit'));
    expect(answer('dhl-express', null, 'Synthetic checkpoint')).toEqual(unknown);
    expect(answer('dhl-express', 'IC', 'Synthetic checkpoint')).toEqual(mapped('customs'));
    expect(answer('speedx', '57104', 'Out for Delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('speedx', '50001', 'Shipping Label Created')).toEqual(mapped('registered'));
    // A code SpeedX's map does not list is staged by its event's category, which the code alone lacks.
    expect(answer('speedx', '57999', 'Synthetic scan')).toEqual(unknown);
    expect(answer('speedx', null, 'Delivered')).toEqual(unknown);
    expect(answer('j-and-t', '94', 'Package will be delivered')).toEqual(mapped('out_for_delivery'));
    expect(answer('j-and-t', '210', 'Pick-Up')).toEqual(mapped('accepted'));
    // Every router scan carries its code, which alone gives the stage.
    expect(answer('j-and-t', null, 'Delivered')).toEqual(unknown);
    expect(answer('j-and-t', '999', 'Delivered')).toEqual(unknown);
    // HuaHan's scan 17TRACK relays without its code, and JS Express's partners' steps after the import release.
    expect(answer('huahan', null, 'Data processed')).toEqual(mapped('in_transit'));
    expect(answer('huahan', 'ZZ', 'Data processed')).toEqual(unknown);
    // The destination carrier's scans under IA or without a code; its record of a redirection moves nothing.
    expect(answer('huahan', 'IA', 'In Transit, Shipment remained at sorting hub')).toEqual(mapped('in_transit'));
    expect(answer('huahan', null, 'We will pick up your parcel from the sender soon.')).toEqual(mapped('registered'));
    expect(answer('huahan', null, 'The courier will deliver the parcel soon. Additional details are available in the SAMEDAY app, email or SMS.'))
      .toEqual(mapped('out_for_delivery'));
    expect(answer('huahan', null, 'The parcel was redirected. As soon as it is in the couriers possession, it will be processed as requested.')).toEqual(gap);
    expect(answer('huahan', 'ZZ', 'In Transit')).toEqual(unknown);
    // USPS's steps after JS Express hands the parcel over; USPS's record of the label moves nothing.
    expect(answer('js-express', null, 'Accepted at USPS Origin Facility')).toEqual(mapped('in_transit'));
    expect(answer('js-express', null, 'Arrived at Post Office')).toEqual(mapped('in_transit'));
    expect(answer('js-express', null, 'Shipping Label Created, USPS Awaiting Item')).toEqual(gap);
    expect(answer('dhlink', null, 'Departed Destination Hub')).toEqual(mapped('in_transit'));
    expect(answer('sfc', null, 'Delivery notice')).toEqual(gap);
    expect(answer('js-express', null, 'Prepared for last mile handover')).toEqual(mapped('in_transit'));
    expect(answer('js-express', null, 'The cargo tally in the supervised warehouse is in progress.')).toEqual(mapped('in_transit'));
    expect(answer('js-express', null, 'Domestic allocation has begun')).toEqual(mapped('in_transit'));
    expect(answer('js-express', null, 'Under domestic allocation')).toEqual(mapped('in_transit'));
    expect(answer('js-express', null, 'Inbound to customs temporary warehouse')).toEqual(mapped('customs'));
    expect(answer('imile', '1003', '【Sample DS】Shipment out for delivery.')).toEqual(mapped('out_for_delivery'));
    // BYHD's kind codes group wordings; the wording decides.
    expect(answer('byhd', 'ARRIVAL', '到达收货点')).toEqual(mapped('accepted'));
    expect(answer('byhd', 'SHIPMENT', 'Goods leaving the operation center')).toEqual(mapped('in_transit'));
    expect(answer('byhd', 'ARRIVAL', 'Synthetic arrival')).toEqual(unknown);
    // A courier's record of the parcel's data moves nothing.
    expect(answer('js-express', null, 'Your package is being prepared by the sender and will be handed over to us soon')).toEqual(gap);
    // China Post's domestic scans as JS Express and the providers relay them, any office in 【】.
    for (const carrier of ['js-express', 'unknown']) {
      for (const wording of ['邮件到达【示例市国际互换局】', '邮件离开【示例揽投部】，正在发往【示例市】', '邮件已在【示例揽投部】完成分拣，准备发出',
        '【示例市国际互换局】已出口直封', '已交承运商运输', '揽投配发', '航空公司接收', '航空公司启运', '出口海关/放行']) {
        expect(answer(carrier, null, wording), `${carrier} ${wording}`).toEqual(mapped('in_transit'));
      }
      expect(answer(carrier, null, '送交出口海关')).toEqual(mapped('customs'));
      expect(answer(carrier, null, '邮件已在【示例揽投部】完成分拣')).toEqual(unknown);
    }
  });

  it("answers La Poste by the group and code it reads, for every carrier its adapter serves", () => {
    const sort = 'Votre envoi est sur son site de distribution. Nous le préparons pour le mettre en livraison.';
    expect(answer('la-poste', 'DISTOU/MD1', sort)).toEqual(mapped('out_for_delivery'));
    expect(answer('delivengo', 'DISTOU/MD1', sort)).toEqual(mapped('out_for_delivery'));
    expect(answer('la-poste', 'AG1', 'Votre colis vous attend')).toEqual(mapped('ready_for_pickup'));
    expect(answer('la-poste', 'DISARR', 'Votre colis est en cours d’acheminement')).toEqual(mapped('in_transit'));
    // Under keys the map does not read, the stage comes from wording and a default.
    expect(answer('la-poste', null, 'Votre colis vous attend dans votre point de retrait')).toEqual(unknown);
    expect(answer('la-poste', 'XYZ/ZZ9', sort)).toEqual(unknown);
  });

  it('keeps Chronopost codes to the wording seen with them, and its notice is a gap', () => {
    expect(answer('chronopost', 'DC', "Colis en cours de préparation chez l'expéditeur")).toEqual(mapped('registered'));
    expect(answer('chronopost', 'DC', 'Colis livré')).toEqual(unknown);
    expect(answer('chronopost', 'TA', 'Colis en cours de livraison')).toEqual(mapped('out_for_delivery'));
    expect(answer('chronopost', 'RB', 'Colis en cours de livraison au point de retrait')).toEqual(mapped('in_transit'));
    expect(answer('chronopost', 'AN', "Remise du colis annulée par l'expéditeur")).toEqual(mapped('exception'));
    expect(answer('chronopost', 'AB', 'Colis mis à disposition au point de retrait')).toEqual(mapped('ready_for_pickup'));
    expect(answer('chronopost', 'TA', 'Colis en cours de livraison par le livreur')).toEqual(mapped('out_for_delivery'));
    expect(answer('chronopost', 'TA', 'Livraison effectuée')).toEqual(unknown);
    expect(answer('chronopost', 'SM', 'Destinataire informé par SMS ou mail')).toEqual(gap);
    expect(answer('chronopost', 'CL', 'Instruction de livraison reçue')).toEqual(gap);
    expect(answer('chronopost', 'SM', 'Autre message')).toEqual(unknown);
    // A partner's missed round under N, as its postponement is.
    expect(answer('chronopost', 'N', 'Colis non livré : client absent')).toEqual(mapped('failed_attempt'));
    expect(answer('chronopost', 'N', 'Livraison reportée')).toEqual(mapped('in_transit'));
    expect(answer('chronopost', 'P', 'Colis non livré')).toEqual(unknown);
  });

  it('reads the last segment of a Swiss Post code, and a revoked scan has no stage', () => {
    expect(answer('swiss-post', 'PARCEL.*.1.2101', 'Ready for pick-up at PickPost / My Post 24 point')).toEqual(mapped('ready_for_pickup'));
    expect(answer('swiss-post', 'LETTER.*.106.859', 'Your shipment will shortly be handed over to the Swiss Post')).toEqual(mapped('registered'));
    expect(answer('swiss-post', 'LETTER.*.93.9112', 'Enquiry initiated')).toEqual(gap);
    expect(answer('swiss-post', 'PARCEL.*.1.4000', 'Delivered — Revocation')).toEqual(unknown);
    // The tracker's other languages: the code still decides, and a revoked scan has no stage in any of them.
    expect(answer('swiss-post', 'PARCEL.*.1.4000', 'Distribué')).toEqual(mapped('delivered'));
    for (const revoked of ['Distribué — Révocation', 'Zugestellt — Widerruf', 'Recapitato — Revoca']) {
      expect(answer('swiss-post', 'PARCEL.*.1.4000', revoked)).toEqual(unknown);
    }
    expect(answer('swiss-post', 'PARCEL.*.1.9224', 'Order triggered by recipient: forward')).toEqual(gap);
    expect(answer('swiss-post', 'LETTER.*.90.1800', 'Delay')).toEqual(gap);
    expect(answer('swiss-post', 'PARCEL.*.0.501', 'Picked up at the client')).toEqual(mapped('accepted'));
    expect(answer('swiss-post', 'PARCEL.*.1.502', 'Picked up')).toEqual(mapped('accepted'));
    expect(answer('swiss-post', 'PARCEL.*.1.2000', 'Delivered over counter')).toEqual(mapped('delivered'));
    expect(answer('swiss-post', 'PARCEL.*.1.9999', 'Synthetic scan')).toEqual(unknown);
    expect(answer('swiss-post', 'PARCEL.*.6144.4100', 'Delivery failed')).toEqual(mapped('failed_attempt'));
    expect(answer('swiss-post', 'PARCEL.*.6144.1400', 'Arrival in special delivery')).toEqual(mapped('in_transit'));
    expect(answer('swiss-post', 'PARCEL.*.6144.1300', 'Sorting - forwarding')).toEqual(mapped('in_transit'));
    expect(answer('swiss-post', 'PARCEL.*.1.9400', 'Consignment poste restante in post office and ready for collection')).toEqual(mapped('ready_for_pickup'));
  });

  it("answers SFC's origin clearance and Allegro One's refusal at the door by their wording", () => {
    expect(answer('sfc', null, 'shipment started the customs clearance process at origin')).toEqual(mapped('customs'));
    expect(answer('allegro-one', null, 'recipient has refused to accept')).toEqual(mapped('failed_attempt'));
  });

  it("answers Helthjem's night booking and missed night round by their event codes, not their delivering state", () => {
    expect(answer('helthjem', 'DELIVERING/057', 'Budet fikk ikke med seg pakken din ut i natt.')).toEqual(mapped('in_transit'));
    expect(answer('helthjem', 'DELIVERING/113', 'Planlagt levering natt til 24. oktober!')).toEqual(mapped('in_transit'));
  });

  it("answers DPD Germany's full pickup point, its line haul and its failed notice by their codes", () => {
    expect(answer('dpd-de', 'DEXD', 'There was an issue to drop off your parcel due to a lack of space in the retrieval point')).toEqual(mapped('failed_attempt'));
    expect(answer('dpd-de', 'LHI', 'Your parcel is on its way')).toEqual(mapped('in_transit'));
    expect(answer('dpd-de', 'MSDLX', "We couldn't send a notification with your delivery details")).toEqual(gap);
    expect(answer('seur', 'LT859', 'EL ENVÍO ESTÁ EN TRÁNSITO INTERNACIONAL. PRÓXIMAMENTE LLEGARÁ A LAS INSTALACIONES DE DESTINO.')).toEqual(mapped('in_transit'));
  });

  it("answers Pošta Slovenije's departure from its outward office of exchange by its UPU code", () => {
    expect(answer('posta-slovenije', 'EMC', 'Departure from outward OE')).toEqual(mapped('in_transit'));
  });

  it("answers MailAmericas by its codes, and leaves its tax ID checks and the buyer's form out on purpose", () => {
    expect(answer('mailamericas', 'LM-2', 'Delivery office: In distribution')).toEqual(mapped('out_for_delivery'));
    for (const code of ['SM-1', 'SM-2', 'SM-4', 'SM-9']) expect(answer('mailamericas', code, 'Synthetic notice'), code).toEqual(gap);
    expect(answer('mailamericas', null, 'Buyer info: Form Received')).toEqual(unknown);
  });

  it("answers bpost by its English wording, a locker placeholder the parser fills included", () => {
    expect(answer('bpost', null, 'Item available at the bbox locker')).toEqual(mapped('ready_for_pickup'));
    expect(answer('bpost', null, "item on it's way to {{bboxrebrand}}")).toEqual(mapped('in_transit'));
    expect(answer('bpost', null, 'item available at the {{bboxrebrand}}')).toEqual(mapped('ready_for_pickup'));
    expect(answer('bpost', null, 'Item delivered')).toEqual(mapped('delivered'));
    expect(answer('bpost', null, 'drop off item by the customer')).toEqual(mapped('accepted'));
    expect(answer('bpost', null, 'item accepted after deposit by sender')).toEqual(mapped('accepted'));
    expect(answer('bpost', null, 'Synthetic scan')).toEqual(unknown);
    expect(answer('bpost', 'ZZ', 'Item delivered')).toEqual(unknown);
  });

  it("answers Poste Italiane's wording, its failed round with the next day before the round it announces", () => {
    expect(answer('poste-italiane', null, 'non è stato possibile effettuare la consegna. la spedizione sarà in consegna il primo giorno lavorativo utile a partire dal 2026-01-01 00:00'))
      .toEqual(mapped('failed_attempt'));
    expect(answer('poste-italiane', null, 'la spedizione è in consegna')).toEqual(mapped('out_for_delivery'));
    expect(answer('poste-italiane', null, 'la spedizione è stata consegnata')).toEqual(mapped('delivered'));
    expect(answer('poste-italiane', null, 'cambio disposizioni di consegna')).toEqual(mapped('in_transit'));
    expect(answer('poste-italiane', null, "la spedizione è stata presa in carico da un nostro operatore presso l'ufficio postale")).toEqual(mapped('accepted'));
    expect(answer('poste-italiane', null, 'la spedizione è stata presa in carico da un nostro operatore presso il domicilio del mittente')).toEqual(mapped('accepted'));
    expect(answer('poste-italiane', null, 'da un nostro operatore presso l’ufficio postale')).toEqual(mapped('accepted'));
    expect(answer('poste-italiane', null, 'la spedizione è stata presa in carico')).toEqual(mapped('registered'));
    expect(answer('poste-italiane', null, 'a seguito di acquisto da poste.it')).toEqual(mapped('registered'));
    // Registered mail's movements under the label the official page gives their box.
    expect(answer('poste-italiane', null, "Presa in carico da un nostro operatore presso l'Ufficio Postale")).toEqual(mapped('accepted'));
    expect(answer('poste-italiane', null, 'Presa in carico a seguito di acquisto da poste.it')).toEqual(mapped('registered'));
    expect(answer('poste-italiane', null, 'In transito')).toEqual(mapped('in_transit'));
    expect(answer('poste-italiane', null, 'In transito presso il paese estero')).toEqual(mapped('in_transit'));
    expect(answer('poste-italiane', null, 'In consegna')).toEqual(mapped('out_for_delivery'));
    expect(answer('poste-italiane', null, 'Consegnata con successo')).toEqual(mapped('delivered'));
    expect(answer('poste-italiane', null, 'Presa in carico')).toEqual(unknown);
  });

  it("answers Cainiao's action codes, and the wording the queue holds without one", () => {
    expect(answer('aliexpress', 'TD_TRANS_ARRIVE_DCP', 'Awaiting for transit to final delivery office')).toEqual(mapped('in_transit'));
    expect(answer('aliexpress', 'GTMS_SIGNED', 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('aliexpress', 'GWMS_ACCEPT', 'Shipment accepted by the warehouse')).toEqual(mapped('registered'));
    expect(answer('aliexpress', 'GTMS_DEL_FAILURE', 'Delivery attempt failed')).toEqual(mapped('failed_attempt'));
    expect(answer('aliexpress', 'GTMS_STA_SIGN_FAILURE', 'Synthetic failure')).toEqual(mapped('exception'));
    for (const wording of ['Handed over from linehaul office', 'Leaving transit country/region',
      'Awaiting for transit to final delivery office', '[Exampleville] Departed from destination country/region sorting center']) {
      expect(answer('aliexpress', null, wording), wording).toEqual(mapped('in_transit'));
    }
    expect(answer('aliexpress', 'GTMS_DO_DEPART', 'Out for delivery')).toEqual(mapped('out_for_delivery'));
    // Cainiao Express's steps before it has a partner's parcel.
    expect(answer('aliexpress', 'LABEL_CREATED', 'Shipment data information received')).toEqual(mapped('registered'));
    expect(answer('aliexpress', 'PARTNER_OUTBOUND_FR', "Shipment has left Cainiao Express's partner facility")).toEqual(mapped('in_transit'));
    expect(answer('aliexpress', 'IN_TRANSIT_FR', 'Shipment is in transit to Cainiao Express')).toEqual(mapped('in_transit'));
    expect(answer('aliexpress', 'NEW_UNSEEN_CODE', 'Synthetic scan')).toEqual(unknown);
    expect(answer('aliexpress', null, 'Arrived at linehaul office')).toEqual(unknown);
  });

  it("answers the Cainiao scans in front of an iMile history by Cainiao's map, and iMile's own by iMile's", () => {
    expect(answer('imile', 'PU_PICKUP_SUCCESS', 'Received by logistics company')).toEqual(mapped('accepted'));
    expect(answer('imile', 'CC_EX_START', 'Export customs clearance started')).toEqual(mapped('customs'));
    expect(answer('imile', 'LH_DEPART', 'Departed from departure country/region')).toEqual(mapped('in_transit'));
    expect(answer('imile', 'GTMS_ORDER_INFO_UPDATE', 'Delivery details updated')).toEqual(gap);
    expect(answer('imile', 'NEW_UNSEEN_CODE', 'Synthetic scan')).toEqual(unknown);
    // A numeric code is iMile's own, whatever Cainiao's map would say of its wording.
    expect(answer('imile', '1003', 'User not at home')).toEqual(mapped('failed_attempt'));
    expect(answer('imile', '1003', 'Refuse to accept')).toEqual(mapped('failed_attempt'));
    expect(answer('imile', '1003', 'Traffic, Strike, Bad weather')).toEqual(mapped('failed_attempt'));
    expect(answer('dhlink', null, 'Package received and scanned at warehouse')).toEqual(mapped('accepted'));
    expect(answer('globalpost', null, 'Departed from Origin Country')).toEqual(mapped('in_transit'));
    expect(answer('globalpost', null, 'Delayed, No Action Required')).toEqual(mapped('exception'));
    expect(answer('globalpost', null, 'Arrived in Destination Country Tracking updates may take time— rest assured, your package is still on its way.')).toEqual(mapped('in_transit'));
    expect(answer('globalpost', null, 'Arrived in Destination Country, Example note')).toEqual(unknown);
    expect(answer('mayiyinfu', null, 'The shipment has been loaded onto the delivery vehicle')).toEqual(mapped('out_for_delivery'));
    expect(answer('mayiyinfu', null, 'The shipment has been successfully delivered')).toEqual(mapped('delivered'));
    expect(answer('imile', '9999', 'Departed from departure country/region')).toEqual(unknown);
  });

  it("answers DPD France's wording, the only key its trace page has", () => {
    expect(answer('dpd-fr', null, 'Votre colis a été pris en charge dans notre réseau')).toEqual(mapped('accepted'));
    expect(answer('dpd-fr', null, 'Le destinataire est informé par SMS de la prise en charge de son colis dans notre réseau'))
      .toEqual(mapped('accepted'));
    expect(answer('dpd-fr', null, 'Le destinataire est informé par e-mail de la livraison de son colis ce jour'))
      .toEqual(mapped('out_for_delivery'));
    expect(answer('dpd-fr', null, 'Synthetic wording')).toEqual(unknown);
    expect(answer('dpd-fr', 'DLO', 'Votre colis est livré')).toEqual(unknown);
  });

  it("answers Correos by its event code, and its office hold without one", () => {
    expect(answer('correos-spain', 'B030000V', 'En oficina de cambio')).toEqual(mapped('in_transit'));
    expect(answer('correos-spain', 'D050000V', 'Llegada a oficina de cambio')).toEqual(mapped('in_transit'));
    expect(answer('correos-spain', 'G01L020V', 'A disposición del destinatario')).toEqual(mapped('ready_for_pickup'));
    expect(answer('correos-spain', null, 'A disposición del destinatario')).toEqual(mapped('ready_for_pickup'));
    expect(answer('correos-spain', 'A010000V', 'Admitido.')).toEqual(mapped('accepted'));
    expect(answer('correos-spain', 'A010AA0V', 'Accepted')).toEqual(mapped('accepted'));
    // Origin customs holds the parcel; a completed customs processing puts it back in transit.
    expect(answer('correos-spain', 'B170000V', 'En aduana de origen')).toEqual(mapped('customs'));
    expect(answer('correos-spain', 'E510000V', 'Finalizada tramitación aduanera')).toEqual(mapped('in_transit'));
    // An import under customs transit stays in customs until its procedures finish.
    expect(answer('correos-spain', 'E508700V', 'Transit authorised')).toEqual(mapped('customs'));
    expect(answer('correos-spain', 'E190000V', 'Customs procedures finished')).toEqual(mapped('in_transit'));
    expect(answer('correos-spain', 'Z999999Z', 'A disposición del destinatario')).toEqual(unknown);
    expect(answer('correos-spain', null, 'Admitido.')).toEqual(unknown);
  });

  it("answers Thailand Post's scan codes, and leaves its call and COD payment out on purpose", () => {
    expect(answer('thailand-post', '3', 'Posting/Collection [ EXAMPLE Posting Center ]')).toEqual(mapped('accepted'));
    expect(answer('thailand-post', '31', 'Out for delivery [ EXAMPLE Post Office ]')).toEqual(mapped('out_for_delivery'));
    expect(answer('thailand-post', '28', 'Return to the origin post office')).toEqual(mapped('exception'));
    expect(answer('thailand-post', '57', 'Contact recipient')).toEqual(gap);
    expect(answer('thailand-post', '36', 'Successfully transfer money to seller')).toEqual(gap);
    // A final delivery reads its delivery result, and a utility row its status group.
    expect(answer('thailand-post', '35', 'Successful delivery [ EXAMPLE Post Office ]')).toEqual(unknown);
    expect(answer('thailand-post', '34', 'Item held,addressee notified due to Payment of charges')).toEqual(unknown);
    expect(answer('thailand-post', null, 'Contact recipient')).toEqual(unknown);
    expect(answer('thailand-post', 'toString', 'Synthetic scan')).toEqual(unknown);
  });

  it("answers NACEX's labels, and leaves its notices to the scans around them", () => {
    expect(answer('nacex', null, 'Aceptada')).toEqual(mapped('accepted'));
    expect(answer('nacex', null, 'En tránsito')).toEqual(mapped('in_transit'));
    expect(answer('nacex', null, 'Disponible en punto NACEX')).toEqual(mapped('ready_for_pickup'));
    expect(answer('nacex', null, 'Notificado')).toEqual(gap);
    expect(answer('nacex', null, 'Sin estado')).toEqual(gap);
    expect(answer('nacex', null, 'Synthetic label')).toEqual(unknown);
  });

  it("answers Austrian Post's arrival in the destination country by its code, with or without wording", () => {
    expect(answer('austrian-post', 'IMP', 'Tracking update')).toEqual(mapped('in_transit'));
    expect(answer('austrian-post', 'IMP', 'Sendung im Zielland angekommen')).toEqual(mapped('in_transit'));
    expect(answer('austrian-post', 'EXP', 'Tracking update')).toEqual(unknown);
  });

  it("answers Royal Mail's event codes, else its wording", () => {
    expect(answer('royal-mail', 'LOPPA', 'Sender advised item dropped off at parcel locker')).toEqual(mapped('accepted'));
    expect(answer('royal-mail', 'EVPPA', 'Accepted at Parcelshop')).toEqual(mapped('accepted'));
    expect(answer('royal-mail', 'EVKOP', 'Delivered')).toEqual(mapped('delivered'));
    // The destination's customs codes stage the scan whatever their wording.
    expect(answer('royal-mail', 'EVJIC', 'Synthetic scan')).toEqual(mapped('customs'));
    expect(answer('royal-mail', 'EVJBA', 'Synthetic scan')).toEqual(mapped('customs'));
    expect(answer('royal-mail', 'ZZZZZ', 'Out for delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('royal-mail', 'ZZZZZ', 'Synthetic scan')).toEqual(unknown);
  });

  it("answers UPS's parcel on its way to its first facility and DHL Express's supplementary data", () => {
    expect(answer('ups', 'AG', 'Package is in transit to a UPS facility')).toEqual(mapped('accepted'));
    expect(answer('dhl-express', 'EM', 'Supplementary information has been received and merged with applicable shipment data'))
      .toEqual(mapped('registered'));
    // A delivery booked for a later round is no round yet.
    expect(answer('dhl-express', null, 'Shipment is scheduled for delivery')).toEqual(mapped('in_transit'));
    // Huaya's tracker announces the shipment to the destination carrier after the flight's hand-over.
    expect(answer('huaya-express', null, 'Shipment Announced')).toEqual(mapped('in_transit'));
  });

  it("answers DHL by its wording in English and German, and leaves a forecast and unknown wording open", () => {
    expect(answer('dhl', null, 'The instruction data for this shipment have been provided by the sender to DHL electronically')).toEqual(mapped('registered'));
    expect(answer('dhl', null, 'Pick-up was successful.')).toEqual(mapped('accepted'));
    expect(answer('dhl', null, 'Die Sendung wurde im Briefzentrum bearbeitet.')).toEqual(mapped('in_transit'));
    expect(answer('dhl', null, 'The shipment has been loaded into the delivery vehicle')).toEqual(mapped('out_for_delivery'));
    expect(answer('dhl', null, 'Die Sendung wurde nicht erfolgreich zugestellt.')).toEqual(mapped('failed_attempt'));
    expect(answer('dhl', null, 'Die Sendung wurde erfolgreich zugestellt.')).toEqual(mapped('delivered'));
    expect(answer('dhl', null, 'The shipment will be delivered tomorrow')).toEqual(unknown);
    expect(answer('dhl', null, 'Synthetic note')).toEqual(unknown);
  });

  it("answers GLS Germany and Switzerland by their wording, since a row keeps its event number, not its status", () => {
    for (const carrier of ['gls-de', 'gls-ch']) {
      expect(answer(carrier, null, 'The parcel has not been handed over to GLS.'), carrier).toEqual(mapped('registered'));
      expect(answer(carrier, '1.0', 'The parcel was handed over to GLS.'), carrier).toEqual(mapped('accepted'));
      expect(answer(carrier, null, 'The parcel has left the parcel center.'), carrier).toEqual(mapped('in_transit'));
      expect(answer(carrier, null, 'The parcel is expected to be delivered during the day.'), carrier).toEqual(mapped('out_for_delivery'));
      expect(answer(carrier, null, 'The parcel is ready for collection at the ParcelShop.'), carrier).toEqual(mapped('ready_for_pickup'));
      expect(answer(carrier, null, 'The parcel has been delivered.'), carrier).toEqual(mapped('delivered'));
      expect(answer(carrier, null, 'Synthetic note'), carrier).toEqual(unknown);
    }
  });

  it("answers GLS France by its event code, and leaves its delay, a failed attempt for a delivery event, out on purpose", () => {
    expect(answer('gls-fr', 'CON', 'Shipment information received')).toEqual(mapped('registered'));
    expect(answer('gls-fr', 'TRV', 'Out for delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('gls-fr', 'LIP', 'Ready for pickup at GLS ParcelShop')).toEqual(mapped('ready_for_pickup'));
    expect(answer('gls-fr', 'LIV', 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('gls-fr', 'DEL', 'Delivery delayed')).toEqual(gap);
    expect(answer('gls-fr', 'ZZZ', 'GLS France tracking update')).toEqual(unknown);
    expect(answer('gls-fr', null, 'Delivered')).toEqual(unknown);
  });

  it("answers Poczta Polska and CTT Express by their scan codes", () => {
    expect(answer('poczta-polska', 'P_REJ_KN1', 'Electronic item data received')).toEqual(mapped('registered'));
    expect(answer('poczta-polska', 'P_ZWC', 'Customs service')).toEqual(mapped('customs'));
    expect(answer('poczta-polska', 'P_ND', 'In delivery')).toEqual(mapped('exception'));
    expect(answer('poczta-polska', 'P_D', 'Final delivery')).toEqual(mapped('delivered'));
    expect(answer('poczta-polska', 'P_ROZL_CEL', 'Synthetic settlement')).toEqual(unknown);
    expect(answer('poczta-polska', null, 'Final delivery')).toEqual(unknown);
    expect(answer('ctt-express', '0000', 'Pendiente de recepción en CTT Express')).toEqual(mapped('registered'));
    expect(answer('ctt-express', '2310', 'Disponible en Punto Collectt Express')).toEqual(mapped('ready_for_pickup'));
    expect(answer('ctt-express', '2100', 'El envío fue entregado correctamente')).toEqual(mapped('delivered'));
    expect(answer('ctt-express', '9999', 'Synthetic scan')).toEqual(unknown);
  });

  it("answers UniUni by its state code and a Uni Store drop-off by its wording, and leaves 202 out on purpose", () => {
    expect(answer('uniuni', '190', 'Order received')).toEqual(mapped('registered'));
    expect(answer('uniuni', '211', 'Failed delivery attempt, returning to the warehouse')).toEqual(mapped('failed_attempt'));
    expect(answer('uniuni', '203', 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('uniuni', null, 'Parcel dropped off at Uni Store')).toEqual(mapped('accepted'));
    expect(answer('uniuni', '202', 'Out for delivery')).toEqual(gap);
    expect(answer('uniuni', null, 'Delivered')).toEqual(unknown);
  });

  it("answers Spring GDS by PostNL's domestic labels, and an international scan by the category stored with its number", () => {
    expect(answer('spring-gds', 'Z1', 'Shipment received by PostNL')).toEqual(mapped('accepted'));
    expect(answer('spring-gds', null, 'Driver is en route')).toEqual(mapped('out_for_delivery'));
    expect(answer('spring-gds', '37/delivered', 'Shipment delivered')).toEqual(mapped('delivered'));
    expect(answer('spring-gds', '1233/pre-advised', 'Synthetic wording')).toEqual(mapped('registered'));
    // The label refines an overloaded category, as in the adapter.
    expect(answer('spring-gds', '74/processing', 'The item is out for delivery.')).toEqual(mapped('out_for_delivery'));
    expect(answer('spring-gds', '74/processing', 'Synthetic wording')).toEqual(mapped('accepted'));
    expect(answer('spring-gds', '9/undelivered', 'Undeliverable item, has been returned to shipper')).toEqual(mapped('returned'));
    // An international scan reads no domestic label, and an unknown category stays open.
    expect(answer('spring-gds', '9/future category', 'Driver is en route')).toEqual(unknown);
    // A scan stored with its number alone keeps no category.
    expect(answer('spring-gds', '37', 'Shipment delivered')).toEqual(unknown);
  });

  it("answers Amazon Shipping by the description it writes for a rule, and leaves an exception open", () => {
    expect(answer('amazon-shipping', 'CreationConfirmed', 'Shipment information received')).toEqual(mapped('registered'));
    expect(answer('amazon-shipping', 'Departed', 'Departed facility')).toEqual(mapped('in_transit'));
    expect(answer('amazon-shipping', 'OutForDelivery', 'Out for delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('amazon-shipping', 'Delivered', 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('amazon-shipping', null, 'Returning to sender')).toEqual(mapped('returned'));
    expect(answer('amazon-shipping', 'Rejected', 'Shipment exception')).toEqual(unknown);
    expect(answer('amazon-shipping', null, 'Amazon Shipping update')).toEqual(unknown);
  });

  it("answers Australia Post by its event code, and a delivery by the wording the adapter gives it", () => {
    expect(answer('australia-post', 'ADMIN-ER39', 'Shipping information received by Australia Post')).toEqual(mapped('registered'));
    expect(answer('australia-post', 'AFC-ER36', 'Synthetic acceptance')).toEqual(mapped('accepted'));
    expect(answer('australia-post', 'DD-ER15', 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('australia-post', 'DD-ER99', 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('australia-post', 'AFP-ER99', "It's on its way")).toEqual(unknown);
  });

  it('answers an Australia Post scan stored with its milestone label as the adapter stages it', () => {
    // A listed code wins over its label; an unlisted one takes the label.
    expect(answer('australia-post', 'INT-0075/Delivered', 'Awaiting collection at Example Town')).toEqual(mapped('ready_for_pickup'));
    expect(answer('australia-post', "AFP-ER99/It's on its way", 'Synthetic wording')).toEqual(mapped('in_transit'));
    expect(answer('australia-post', 'AFP-ER99/It’s coming today', 'Synthetic wording')).toEqual(mapped('out_for_delivery'));
    expect(answer('australia-post', 'DD-ER99/Delivered', 'Delivered')).toEqual(mapped('delivered'));
    // Neither staged it, so its wording does not either.
    expect(answer('australia-post', 'XX-ER99/A future milestone', 'Delivered')).toEqual(unknown);
  });

  it("answers Paack by the description it writes, an aggregator's copy of its labels, and Evri's scans before the hand-over", () => {
    expect(answer('paack', null, 'Shipment registered')).toEqual(mapped('registered'));
    expect(answer('paack', null, 'Courier assigned')).toEqual(mapped('out_for_delivery'));
    expect(answer('paack', null, 'New delivery attempt scheduled')).toEqual(mapped('failed_attempt'));
    expect(answer('paack', null, "In Paack's distribution centre")).toEqual(mapped('accepted'));
    expect(answer('paack', null, 'Received at Evri')).toEqual(mapped('accepted'));
    expect(answer('paack', null, 'Shipment update')).toEqual(unknown);
  });

  it("answers Posti by its scan labels, and leaves notifications, which it reads as pending, open", () => {
    expect(answer('posti', null, 'The item has been delivered')).toEqual(mapped('delivered'));
    expect(answer('posti', null, 'Item is ready for a pick up')).toEqual(mapped('ready_for_pickup'));
    expect(answer('posti', null, 'Item accepted from transport')).toEqual(mapped('in_transit'));
    expect(answer('posti', null, 'We sent the recipient an email about the item.')).toEqual(unknown);
  });

  it('answers Posti by the label a scan was stored with before its reason, never by the reason', () => {
    expect(answer('posti', null, 'Item is ready for a pick up. Synthetic reason for the change.')).toEqual(mapped('ready_for_pickup'));
    expect(answer('posti', null, 'The item has been delivered. Synthetic reason')).toEqual(mapped('delivered'));
    expect(answer('posti', null, 'We sent the recipient an email about the item. The item has been delivered.')).toEqual(unknown);
  });

  it("answers DHL Express's wait for collection, missed delivery and return", () => {
    expect(answer('dhl-express', 'CC', 'Awaiting collection by the consignee')).toEqual(mapped('ready_for_pickup'));
    expect(answer('dhl-express', 'ND', 'Delivery attempt could not be completed')).toEqual(mapped('failed_attempt'));
    expect(answer('dhl-express', 'RT', 'Returned to shipper')).toEqual(mapped('returned'));
    expect(answer('dhl-express', 'SM', 'Scheduled to depart on the next planned movement')).toEqual(mapped('in_transit'));
    expect(answer('dhl-express', null, 'Scheduled to depart on the next planned movement')).toEqual(mapped('in_transit'));
    // The web feed sends the same wording without a code.
    expect(answer('dhl-express', null, 'Awaiting collection by the consignee')).toEqual(mapped('ready_for_pickup'));
    expect(answer('dhl-express', 'RT', 'Synthetic checkpoint')).toEqual(mapped('returned'));
  });

  it("answers STO's scan types by the wording stored for them, on the way out and back", () => {
    expect(answer('sto', '派件', 'Out for delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('sto', '发件', 'Departed for Example hub')).toEqual(mapped('in_transit'));
    expect(answer('sto', '签收', 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('sto', '签收', 'Returned to the sender')).toEqual(mapped('returned'));
    expect(answer('sto', '派件', 'Out for delivery back to the sender')).toEqual(mapped('out_for_delivery'));
    expect(answer('sto', '退回件', 'Return to the sender started')).toEqual(mapped('exception'));
    expect(answer('sto', '派件', 'Delivered')).toEqual(unknown);
    expect(answer('sto', '问题件', '问题件')).toEqual(unknown);
    expect(answer('sto', null, 'Delivered')).toEqual(unknown);
  });

  it("answers An Post's trace codes, narrowed by wording, and its delivery attempt by the website's wording", () => {
    expect(answer('an-post', '70', 'Your item is now available for collection')).toEqual(mapped('ready_for_pickup'));
    expect(answer('an-post', '35', 'We have received information about your incoming item from the sender')).toEqual(mapped('registered'));
    expect(answer('an-post', '83', 'Synthetic customs wording')).toEqual(mapped('customs'));
    // The app's broad in-transit and return categories take a narrower stage from wording.
    expect(answer('an-post', '1', 'Synthetic scan')).toEqual(mapped('in_transit'));
    expect(answer('an-post', '1', 'Your item is out for delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('an-post', '53', 'Synthetic scan')).toEqual(mapped('returned'));
    // Code 52 at a post office waits there for collection; at any other office it stays the app's sorting.
    expect(answer('an-post', '52', 'Your delivery is in SYNTHETIC TOWN, POST OFFICE')).toEqual(mapped('ready_for_pickup'));
    expect(answer('an-post', '52', 'Your delivery is in SYNTHETIC MAIL CENTRE')).toEqual(mapped('in_transit'));
    expect(answer('an-post', '16', 'Your item was delivered')).toEqual(mapped('delivered'));
    expect(answer('an-post', '16', 'We attempted to deliver your item')).toEqual(mapped('failed_attempt'));
    // Codes the map does not know, and wording without a code, stay open for review.
    expect(answer('an-post', '9999', 'Your item has been delivered')).toEqual(unknown);
    expect(answer('an-post', '014', 'Your item has been delivered')).toEqual(unknown);
    expect(answer('an-post', null, 'Your item has been delivered')).toEqual(unknown);
  });

  it("answers CTT's StateId codes, and leaves wording without one open", () => {
    expect(answer('ctt', '2', 'Aceite')).toEqual(mapped('accepted'));
    expect(answer('ctt', '10', 'Synthetic customs wording')).toEqual(mapped('customs'));
    expect(answer('ctt', '12', 'Entregue')).toEqual(mapped('delivered'));
    expect(answer('ctt', '99', 'Entregue')).toEqual(unknown);
    expect(answer('ctt', '02', 'Aceite')).toEqual(unknown);
    expect(answer('ctt', null, 'Aceite')).toEqual(unknown);
  });

  it("answers China Post by its scan code, and by the state label that replaced a scan's text", () => {
    expect(answer('china-post', '461', '已到达【美国】投递局')).toEqual(mapped('in_transit'));
    expect(answer('china-post', 'EXB', '出口海关/留存待验')).toEqual(mapped('customs'));
    // The code decides: a delivery attempt keeps its stage under the label 运送中.
    expect(answer('china-post', '542', '运送中')).toEqual(mapped('failed_attempt'));
    expect(answer('china-post', '711', '已退回')).toEqual(mapped('returned'));
    // The acceptance dated from the collector record has no code.
    expect(answer('china-post', null, '已揽收')).toEqual(mapped('accepted'));
    expect(answer('china-post', '999', '已签收')).toEqual(mapped('delivered'));
    // An unmapped code with the scan's own text is staged by a label the key does not hold.
    expect(answer('china-post', '999', '【美国】已妥投')).toEqual(unknown);
    // The English the adapter shows answers the same.
    expect(answer('china-post', '461', 'Arrived at the delivery office')).toEqual(mapped('in_transit'));
    expect(answer('china-post', null, 'Accepted')).toEqual(mapped('accepted'));
    expect(answer('china-post', '999', 'Awaiting collection')).toEqual(mapped('ready_for_pickup'));
    expect(answer('china-post', '999', 'Return to the sender pending')).toEqual(mapped('returned'));
    expect(answer('china-post', '999', 'Departed from a transit office abroad')).toEqual(unknown);
  });

  it('answers Old Dominion by its status, which is its provider code', () => {
    expect(answer('old-dominion', 'In Transit', 'Arrived at EXAMPLE CITY, ST (ABC)')).toEqual(mapped('in_transit'));
    expect(answer('old-dominion', 'Returned To Dock', 'Returned To Dock')).toEqual(mapped('in_transit'));
    expect(answer('old-dominion', 'Pickup Confirmed', 'Pickup Confirmed')).toEqual(mapped('registered'));
    expect(answer('old-dominion', 'Agent Handoff', 'Agent Handoff')).toEqual(mapped('out_for_delivery'));
    expect(answer('old-dominion', 'Delivery Confirmed', 'Delivery Confirmed')).toEqual(mapped('delivered'));
    expect(answer('old-dominion', 'Synthetic Status', 'Synthetic Status')).toEqual(unknown);
    // Every scan of the trace service carries its status.
    expect(answer('old-dominion', null, 'Delivered')).toEqual(unknown);
  });

  it("answers PPL by its event code alone, and leaves its cash-on-delivery steps out on purpose", () => {
    expect(answer('ppl', 'Delivered.Parcelshop', 'We have delivered the shipment to the pick-up point')).toEqual(mapped('ready_for_pickup'));
    expect(answer('ppl', 'Delivered', 'Synthetic wording')).toEqual(mapped('delivered'));
    // Several codes share one wording: the code decides.
    expect(answer('ppl', 'PreparingForDelivery', 'The shipment is in transit')).toEqual(mapped('in_transit'));
    expect(answer('ppl', 'BackToSender.Refused', 'Synthetic wording')).toEqual(mapped('returned'));
    expect(answer('ppl', 'Cod.Completed', 'Synthetic wording')).toEqual(gap);
    expect(answer('ppl', 'Synthetic.NewCode', 'We have delivered the shipment to the recipient')).toEqual(unknown);
    expect(answer('ppl', null, 'We have delivered the shipment to the recipient')).toEqual(unknown);
  });

  it('answers SF Express by its operation code, and code 99 by its remark', () => {
    expect(answer('sf-express', '10', 'The shipment has departed from the transit place【CN,EXAMPLE】, flight departure')).toEqual(mapped('in_transit'));
    expect(answer('sf-express', '11', 'The shipment has arrived at the transit place【CH,EXAMPLE】, flight arrival')).toEqual(mapped('in_transit'));
    for (const code of ['1105', '1106']) {
      expect(answer('sf-express', code, 'Shipment in transit at 【DE,EXAMPLE】, please wait in patience')).toEqual(mapped('in_transit'));
    }
    expect(answer('sf-express', '16', 'Under customs clearance, please wait patiently.')).toEqual(mapped('customs'));
    expect(answer('sf-express', '950', 'Synthetic scan')).toEqual(mapped('accepted'));
    expect(answer('sf-express', '80', 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('sf-express', '99', 'The shipment is being returned.')).toEqual(mapped('returned'));
    // Codes 8000 and 70 are read by a reason the code does not carry, and 99 only by the remarks it knows.
    expect(answer('sf-express', '8000', 'Delivered')).toEqual(unknown);
    expect(answer('sf-express', '70', 'Synthetic scan')).toEqual(unknown);
    expect(answer('sf-express', '99', 'Synthetic notice')).toEqual(unknown);
    expect(answer('sf-express', null, 'Delivered')).toEqual(unknown);
  });

  it('answers Hermes Germany by its parcelStatus, and leaves the dropped delivery bookings out on purpose', () => {
    expect(answer('hermes-de', 'INTERNATIONAL_PUDO_READY_FOR_COLLECTION', 'The shipment is ready for pick up in a parcel shop/store.'))
      .toEqual(mapped('ready_for_pickup'));
    expect(answer('hermes-de', 'INTERNATIONAL_PUDO_NOT_COLLECTED', 'The shipment was not picked up in the parcel shop/store.'))
      .toEqual(mapped('exception'));
    expect(answer('hermes-de', 'INTERNATIONAL_UNDELIVERABLE', 'The shipment could not be delivered.')).toEqual(mapped('exception'));
    expect(answer('hermes-de', 'ANNOUNCED', 'Synthetic wording')).toEqual(mapped('registered'));
    expect(answer('hermes-de', 'DELIVERED_NEIGHBOUR', 'Synthetic wording')).toEqual(mapped('delivered'));
    expect(answer('hermes-de', 'DELIVERED_PARCELBOX', 'Synthetic wording')).toEqual(mapped('ready_for_pickup'));
    expect(answer('hermes-de', 'EDL_BOOKED_PARCELSHOP', 'Für die Sendung wurde ein WunschPaketShop gebucht.')).toEqual(gap);
    expect(answer('hermes-de', 'SYNTHETIC_CODE', 'The shipment was delivered.')).toEqual(unknown);
    expect(answer('hermes-de', null, 'The shipment was delivered.')).toEqual(unknown);
  });

  it('answers Canada Post by its scan code, else its wording, and leaves its notices and the signature out on purpose', () => {
    expect(answer('canada-post', '0198', 'Label correction applied')).toEqual(mapped('in_transit'));
    expect(answer('canada-post', '1301', 'Synthetic scan')).toEqual(mapped('accepted'));
    expect(answer('canada-post', '1410', 'Item held at post office at customer request')).toEqual(mapped('ready_for_pickup'));
    expect(answer('canada-post', '1410', 'Delivery on hold at customer request')).toEqual(mapped('in_transit'));
    expect(answer('canada-post', '9999', 'Item out for delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('canada-post', '1496', 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('canada-post', '1496', 'Returned to sender')).toEqual(mapped('returned'));
    expect(answer('canada-post', '20', 'Signature available')).toEqual(gap);
    expect(answer('canada-post', '1200', 'Expected delivery date updated')).toEqual(gap);
    expect(answer('canada-post', '2001', 'Photo available')).toEqual(gap);
    expect(answer('canada-post', '9999', 'Synthetic scan')).toEqual(unknown);
    expect(answer('canada-post', null, 'Item out for delivery')).toEqual(unknown);
  });

  it('answers Yanwen by its wording, and a delivery by its milestone icon', () => {
    expect(answer('yanwen', null, 'Yanwen Pickup Scan')).toEqual(mapped('accepted'));
    expect(answer('yanwen', null, 'Order Submited.')).toEqual(mapped('registered'));
    expect(answer('yanwen', null, 'Shipment order created')).toEqual(mapped('accepted'));
    expect(answer('yanwen', null, 'Your shipment has arrived at sorting center')).toEqual(mapped('in_transit'));
    expect(answer('yanwen', null, 'Votre colissimo va bientôt nous être confié ! il est en cours de préparation chez votre expéditeur.')).toEqual(mapped('registered'));
    expect(answer('yanwen', null, '【EXAMPLE】Arrived.')).toEqual(mapped('in_transit'));
    expect(answer('yanwen', 'LM40', 'Synthetic last-mile wording')).toEqual(mapped('delivered'));
    expect(answer('yanwen', 'XX10', 'Delivered.')).toEqual(mapped('delivered'));
    // Written before Yanwen's pickup scan.
    expect(answer('yanwen', null, 'Shipment information received')).toEqual(mapped('registered'));
    expect(answer('yanwen', 'XX10', 'Synthetic scan')).toEqual(unknown);
  });

  it('answers SpeedPAK by its English wording, the hand-off to the last-mile carrier included', () => {
    expect(answer('speedpak', null, 'LM Carrier: [Example Post] , LM tracking No.: [EXAMPLE0000000]')).toEqual(mapped('in_transit'));
    expect(answer('speedpak', null, '尾程供应商:[Example Post] , 尾程跟踪号：[EXAMPLE0000000]')).toEqual(mapped('in_transit'));
    expect(answer('speedpak', null, "Delivered. (Recipient's front door)")).toEqual(mapped('delivered'));
    expect(answer('speedpak', null, 'Package Received')).toEqual(mapped('accepted'));
    expect(answer('speedpak', null, 'Shipment Data Received')).toEqual(mapped('registered'));
    // The Chinese label that stages a last-mile carrier's wording is not kept on the scan.
    expect(answer('speedpak', null, 'PROCESSED THROUGH SORT FACILITY')).toEqual(unknown);
    expect(answer('speedpak', null, 'LM Carrier: [Example Post] , LM tracking No.: []')).toEqual(unknown);
    expect(answer('speedpak', 'ZZ', 'Package Received')).toEqual(unknown);
  });

  it('answers TIPSA by its labels and the Spanish wording rules it reads them with', () => {
    expect(answer('tipsa', null, 'PENDIENTE DE ENTREGAR A TIPSA')).toEqual(mapped('registered'));
    expect(answer('tipsa', null, 'LECTURA EN AGENCIA DESTINO EJEMPLO 01')).toEqual(mapped('in_transit'));
    expect(answer('tipsa', null, 'Ausente')).toEqual(mapped('failed_attempt'));
    expect(answer('tipsa', null, 'ENTREGADO')).toEqual(mapped('delivered'));
    expect(answer('tipsa', null, 'EL ENVÍO ESTÁ EN REPARTO.')).toEqual(mapped('out_for_delivery'));
    // A round missed for the address's data, a wait for arrival and the agency's hold after a missed round.
    expect(answer('tipsa', null, 'Faltan Datos / Datos incorrectos')).toEqual(mapped('failed_attempt'));
    expect(answer('tipsa', null, 'Pendiente de llegada')).toEqual(mapped('in_transit'));
    expect(answer('tipsa', null, 'DISPONIBLE')).toEqual(mapped('ready_for_pickup'));
    expect(answer('tipsa', null, 'Pendiente de recoger en Tipsa')).toEqual(mapped('ready_for_pickup'));
    // A delivery asked for at another address, and the read at another agency before it.
    expect(answer('tipsa', null, 'Solicitada en otra dirección')).toEqual(mapped('in_transit'));
    expect(answer('tipsa', null, 'LECTURA EN OTRA AGENCIA TIPSA CENTRAL 00')).toEqual(mapped('in_transit'));
    expect(answer('tipsa', null, 'Pendiente de recoger en Example')).toEqual(unknown);
    expect(answer('tipsa', 'ZZ', 'ENTREGADO')).toEqual(unknown);
  });

  it('answers YTO by its operation code, on the way out and back', () => {
    expect(answer('yto', '996', '冬运会安检')).toEqual(mapped('in_transit'));
    expect(answer('yto', '310', 'Picked up')).toEqual(mapped('accepted'));
    expect(answer('yto', '310', '业务员收件')).toEqual(mapped('accepted'));
    expect(answer('yto', '996', 'Security check')).toEqual(mapped('in_transit'));
    expect(answer('yto', '710', 'Out for delivery back to the sender')).toEqual(mapped('out_for_delivery'));
    expect(answer('yto', '745', 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('yto', '745', 'Returned to the sender')).toEqual(mapped('returned'));
    // Code 751 is read by a sign type the code does not carry.
    expect(answer('yto', '751', 'In a parcel locker or pickup station')).toEqual(unknown);
    expect(answer('yto', '999', 'Synthetic scan')).toEqual(unknown);
    expect(answer('yto', null, 'Delivered')).toEqual(unknown);
  });

  it.each(['app', '', 'india', '__proto__', 'constructor', 'toString', 'Unknown'])('does not know %s', (carrier) => {
    expect(answer(carrier, 'DLO', 'Delivered')).toEqual(unknown);
  });

  it('answers SEUR by its code and wording, and leaves its delay notices to the scans around them', () => {
    expect(answer('seur', 'LI521', 'el envío no se ha entregado porque la dirección de entrega está incompleta o errónea.')).toEqual(mapped('failed_attempt'));
    expect(answer('seur', 'LI511', 'el envío está pendiente de llegar a destino. en cuanto se reciba, actualizaremos la situación.')).toEqual(mapped('in_transit'));
    expect(answer('seur', 'LI582', 'el envío ha sufrido un retraso provocando una posible demora en la entrega. disculpa las molestias.')).toEqual(gap);
    expect(answer('seur', 'LI300', 'Any wording at all')).toEqual(gap);
    expect(answer('seur', 'LI557', 'el envío ha sufrido un retraso provocando una posible demora en la entrega. disculpa las molestias.')).toEqual(gap);
    expect(answer('seur', 'LI521', 'el envío está entregado.')).toEqual(unknown);
  });

  it('answers USPS and Evri by their wording, and ZTO International by its code', () => {
    expect(answer('usps', null, 'shipping label printed at post office')).toEqual(mapped('registered'));
    expect(answer('usps', null, 'arrived at post office')).toEqual(mapped('in_transit'));
    expect(answer('evri', null, 'departed origin country')).toEqual(mapped('in_transit'));
    expect(answer('evri', null, 'departed')).toEqual(unknown);
    for (const [code, stage] of [['30', 'registered'], ['100', 'in_transit'], ['375', 'in_transit'], ['415', 'in_transit'], ['-581', 'exception']] as const) {
      expect(answer('zto-international', code, 'Any wording at all'), code).toEqual(mapped(stage));
    }
  });

  it("answers BRT by its labels, and the leg of the partner that brought the parcel by that partner's map", () => {
    expect(answer('brt', null, 'ARRIVED AT DEPOT')).toEqual(mapped('in_transit'));
    expect(answer('brt', null, 'TURMOIL')).toEqual(mapped('exception'));
    expect(answer('brt', null, 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('brt', null, 'Your parcel is on its way')).toEqual(unknown);
    expect(answer('brt', 'HUI', 'Your parcel arrived at our hub')).toEqual(mapped('in_transit'));
    expect(answer('brt', 'DB', "Colis déposé par l'expéditeur")).toEqual(mapped('accepted'));
    expect(answer('brt', 'SM', 'Destinataire informé par SMS ou mail')).toEqual(gap);
    expect(answer('brt', 'SPE', 'Any wording at all')).toEqual(gap);
    // DPD's transit wording moves the parcel once DPD has it, and its intake always gets a stage.
    expect(answer('brt', 'IN_TRANSIT', 'Your parcel is on its way')).toEqual({
      kind: 'intentional_gap',
      note: 'In the DPD leg before BRT it moves the parcel only once DPD has taken it in; before that it names no movement of its own.',
    });
    expect(answer('brt', 'PARCEL_HANDED', 'Parcel handed to DPD')).toEqual(unknown);
    expect(answer('brt', 'ORI', 'Your parcel arrived at our depot')).toEqual(unknown);
  });

  it("answers MRW by its Spanish and Portuguese labels, and leaves its label for a status it does not know out on purpose", () => {
    expect(answer('mrw', null, 'Envío en reparto')).toEqual(mapped('out_for_delivery'));
    expect(answer('mrw', null, 'Envio entregue')).toEqual(mapped('delivered'));
    expect(answer('mrw', null, 'Actualización de seguimiento')).toEqual(gap);
    expect(answer('mrw', null, 'Envío retenido')).toEqual(unknown);
  });

  it('answers FedEx by its scan code, and by its wording a scan whose code it does not know or that has none', () => {
    expect(answer('fedex', 'AR', 'Arrived at FedEx location')).toEqual(mapped('in_transit'));
    expect(answer('fedex', 'HL', 'Synthetic wording')).toEqual(mapped('ready_for_pickup'));
    expect(answer('fedex', 'DL', 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('fedex', 'XX', 'In FedEx possession — At FedEx location')).toEqual(mapped('accepted'));
    expect(answer('fedex', 'constructor', 'Shipment arriving On-Time')).toEqual(unknown);
    expect(answer('fedex', null, 'Arrived at FedEx location')).toEqual(mapped('in_transit'));
    expect(answer('fedex', null, 'In FedEx possession — At FedEx location')).toEqual(mapped('accepted'));
    expect(answer('fedex', null, 'On FedEx vehicle for delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('fedex', null, 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('fedex', null, 'Shipment arriving On-Time')).toEqual(unknown);
  });

  it("answers Mondial Relay by its French wording and InPost Spain by its codes, and leaves the last leg out on purpose", () => {
    expect(answer('mondial-relay', null, 'Colis pris en charge en Locker')).toEqual(mapped('accepted'));
    expect(answer('mondial-relay', null, 'Prise en charge de votre colis sur notre site logistique.')).toEqual(mapped('in_transit'));
    expect(answer('mondial-relay', null, 'Disponible dans votre Point Relais')).toEqual(mapped('ready_for_pickup'));
    expect(answer('mondial-relay', null, 'Retiré par le destinataire')).toEqual(mapped('delivered'));
    // Out for delivery only when a milestone is dated at it.
    expect(answer('mondial-relay', null, 'Colis en route vers le point de livraison')).toEqual(gap);
    // Wording no rule knows gets the parser's movement placeholder, not a stage of its own.
    expect(answer('mondial-relay', null, 'Votre colis est arrivé')).toEqual(unknown);
    expect(answer('mondial-relay', 'LMD.1002', 'Paquete en el destino')).toEqual(mapped('in_transit'));
    expect(answer('mondial-relay', 'LMD.1004', 'Listo para recoger en Punto Pack')).toEqual(mapped('ready_for_pickup'));
    expect(answer('mondial-relay', 'EOL.9999', 'Entregado')).toEqual(mapped('delivered'));
    expect(answer('mondial-relay', 'EOL.9999', 'Any wording at all')).toEqual(unknown);
  });

  it("answers InPost by the wording of the code that staged the scan, and leaves its redirect and delay notice out on purpose", () => {
    expect(answer('inpost', null, 'Collected by the Courier')).toEqual(mapped('accepted'));
    expect(answer('inpost', null, 'Handed over for delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('inpost', null, 'Ready for collection')).toEqual(mapped('ready_for_pickup'));
    expect(answer('inpost', null, 'Returned to Sender')).toEqual(mapped('returned'));
    // A scan the hub sent without wording keeps its code as its wording.
    expect(answer('inpost', null, 'EOL.1001')).toEqual(mapped('delivered'));
    expect(answer('inpost', null, 'INF.9001')).toEqual(unknown);
    expect(answer('inpost', null, 'Possible delivery delay')).toEqual(gap);
    expect(answer('inpost', null, 'Paczka przekierowana')).toEqual(gap);
    expect(answer('inpost', null, 'Something new')).toEqual(unknown);
  });

  it('answers an InPost scan stored with its code by the code, whatever its wording', () => {
    expect(answer('inpost', 'FMD.1001', 'Nadana przez Paczkomat')).toEqual(mapped('accepted'));
    expect(answer('inpost', 'EOL.1001', 'Synthetic wording')).toEqual(mapped('delivered'));
    expect(answer('inpost', 'LMD.3013', 'Synthetic wording')).toEqual(gap);
    expect(answer('inpost', 'INF.9001', 'Possible delivery delay')).toEqual(gap);
    expect(answer('inpost', 'NEW.9999', 'Ready for collection')).toEqual(unknown);
  });

  it('answers PostNord by its code, narrowed by the wording of a milestone or a hold', () => {
    expect(answer('postnord', 'EN_ROUTE', 'The shipment item has been dropped off by sender.')).toEqual(mapped('accepted'));
    expect(answer('postnord', 'EN_ROUTE', 'The delivery of the shipment item is in progress.')).toEqual(mapped('out_for_delivery'));
    expect(answer('postnord', 'EN_ROUTE', 'The transport of the shipment item has started.')).toEqual(mapped('in_transit'));
    expect(answer('postnord', 'STOPPED', 'The shipment item is being customs cleared by us.')).toEqual(mapped('customs'));
    expect(answer('postnord', 'STOPPED', 'The shipment item has been stored.')).toEqual(mapped('exception'));
    expect(answer('postnord', 'AVAILABLE_FOR_DELIVERY', 'The shipment item has been delivered to a service point.')).toEqual(mapped('ready_for_pickup'));
    expect(answer('postnord', 'DELIVERED', 'The shipment item has been delivered.')).toEqual(mapped('delivered'));
    // OTHER moves the parcel only when its wording names a milestone.
    expect(answer('postnord', 'OTHER', 'Your item is being processed at our sorting center.')).toEqual(mapped('in_transit'));
    expect(answer('postnord', 'OTHER', 'Any wording at all')).toEqual(unknown);
    // Without a code, only a milestone's or a hold's own wording stages a scan.
    expect(answer('postnord', null, 'The delivery of the shipment item is in progress.')).toEqual(mapped('out_for_delivery'));
    expect(answer('postnord', null, 'The shipment item has been delivered.')).toEqual(unknown);
  });

  it("answers Colis Privé by its French wording, a missed delivery before the delivery it names", () => {
    expect(answer('colis-prive', null, "Votre colis est en cours de préparation par l'expéditeur.")).toEqual(mapped('registered'));
    expect(answer('colis-prive', null, 'Votre colis est arrivé sur notre agence régionale de distribution.')).toEqual(mapped('in_transit'));
    expect(answer('colis-prive', null, 'Votre colis est en cours de distribution par le livreur')).toEqual(mapped('out_for_delivery'));
    expect(answer('colis-prive', null, 'Nous avons tenté de livrer votre colis.')).toEqual(mapped('failed_attempt'));
    expect(answer('colis-prive', null, 'Votre colis a été livré.')).toEqual(mapped('delivered'));
    expect(answer('colis-prive', null, 'Un nouveau libellé du transporteur')).toEqual(unknown);
  });

  it('answers DPD UK by its own wording, then the shared rules, as the parser reads its scans', () => {
    expect(answer('dpd-uk', null, "We've received your order details, but have not yet received your parcel")).toEqual(mapped('registered'));
    expect(answer('dpd-uk', null, 'Your parcel has been dropped off at a DPD Pickup Shop')).toEqual(mapped('accepted'));
    expect(answer('dpd-uk', null, 'The parcel is undergoing customs clearance')).toEqual(mapped('customs'));
    expect(answer('dpd-uk', null, 'Your parcel will be with you today ')).toEqual(mapped('out_for_delivery'));
    expect(answer('dpd-uk', null, 'Your parcel is waiting for you at home (left in safe place)')).toEqual(mapped('delivered'));
    expect(answer('dpd-uk', null, 'Your delivery has been cancelled, please contact Example Merchant for further details')).toEqual(mapped('exception'));
    expect(answer('dpd-uk', null, 'The parcel has been delivered back to the sender')).toEqual(mapped('returned'));
    // Its notices get no stage: gaps, the dated ones too, that keep the stage before them.
    for (const notice of ['A notification has been sent to advise you when the delivery will take place',
      'As requested, your parcel will now be delivered on Thu 05 November 2026 at 11:00']) {
      expect(answer('dpd-uk', null, notice)).toEqual({ kind: 'intentional_gap', note: expect.stringMatching(/keeps the stage it had/) });
    }
  });

  it("answers Packeta by its event sentences, and not by the parcel's status wording", () => {
    expect(answer('packeta', null, 'We are aware of your parcel and are waiting for the sender to hand it over to us.')).toEqual(mapped('registered'));
    expect(answer('packeta', null, 'We have successfully received the parcel for transport. DEPO Example')).toEqual(mapped('in_transit'));
    expect(answer('packeta', null, 'The parcel is ready for pickup. Z-BOX Example 1')).toEqual(mapped('ready_for_pickup'));
    expect(answer('packeta', null, 'The parcel is with you. Thank you, and we look forward to next time.')).toEqual(mapped('delivered'));
    expect(answer('packeta', null, 'We have returned the parcel back to the sender.')).toEqual(mapped('returned'));
    // The packetStatusId and its wording stage the parcel, never a scan.
    expect(answer('packeta', '3', 'The package has been delivered')).toEqual(unknown);
    expect(answer('packeta', null, 'Synthetic sentence')).toEqual(unknown);
  });

  it("answers Evri UK by its scan's rail and tracking point, and a scan stored without its rail by the wording of a delivery", () => {
    // A ParcelShop arrival is a drop-off on one rail and ready for pickup on another.
    expect(answer('evri-uk', '2/ARRIVED_PARCELSHOP', 'Synthetic scan')).toEqual(mapped('accepted'));
    expect(answer('evri-uk', '4_SHOP/ARRIVED_PARCELSHOP', 'Synthetic scan')).toEqual(mapped('ready_for_pickup'));
    expect(answer('evri-uk', '4_COURIER/NOT_DELIVERED_BUSINESS_CLOSED', 'Synthetic scan')).toEqual(mapped('failed_attempt'));
    expect(answer('evri-uk', '3/LOCAL_DEPOT', 'At the local depot')).toEqual(mapped('in_transit'));
    expect(answer('evri-uk', '5_COURIER/LEFT_GARAGE', 'Delivered')).toEqual(mapped('delivered'));
    // A rail the adapter does not know reaches the review, whatever its wording.
    expect(answer('evri-uk', 'SYNTHETIC_RAIL/SYNTHETIC_POINT', 'Delivered')).toEqual(unknown);
    expect(answer('evri-uk', 'LEFT_GARAGE', 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('evri-uk', null, 'Delivered')).toEqual(mapped('delivered'));
    for (const [code, wording] of [['ARRIVED_PARCELSHOP', 'Synthetic scan'], ['COURIER_DELIVERY', 'Out for delivery'], ['SYNTHETIC_POINT', 'Delivery update']] as const) {
      expect(answer('evri-uk', code, wording), code).toEqual(unknown);
    }
    expect(answer('evri-uk', null, 'Out for delivery')).toEqual(unknown);
  });

  it("answers Correios by its code and subtype", () => {
    expect(answer('correios-br', 'BDE/01', 'Objeto entregue ao destinatário')).toEqual(mapped('delivered'));
    expect(answer('correios-br', 'OEC/01', 'Objeto saiu para entrega ao destinatário')).toEqual(mapped('out_for_delivery'));
    expect(answer('correios-br', 'BDE/20', 'Carteiro não atendido')).toEqual(mapped('failed_attempt'));
    expect(answer('correios-br', 'FC/16', 'Necessidade de informar CPF/CNPJ do destinatário')).toEqual(mapped('customs'));
    expect(answer('correios-br', 'FC/40', 'Objeto em processo de identificação do código de classificação do produto')).toEqual(mapped('customs'));
    expect(answer('correios-br', 'PAR/18', 'Objeto recebido na unidade de exportação no país de origem')).toEqual(mapped('in_transit'));
    expect(answer('correios-br', 'XX/99', 'Objeto em trânsito')).toEqual(unknown);
    // A universal provider's copy, without Correios's code, by the wording of a recorded code.
    expect(answer('correios-br', null, 'Objeto entregue ao destinatário')).toEqual(mapped('delivered'));
    expect(answer('correios-br', 'InfoReceived', 'Objeto postado')).toEqual(mapped('accepted'));
    expect(answer('correios-br', null, 'Objeto em trânsito')).toEqual(unknown);
  });

  it("answers DHL eCommerce by the wording its adapter reads, and leaves what only UTAPI's status code stages open", () => {
    expect(answer('dhl-ecommerce', null, 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('dhl-ecommerce', null, 'Out for delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('dhl-ecommerce', null, 'Label created')).toEqual(mapped('registered'));
    expect(answer('dhl-ecommerce', null, 'Tendered to delivery service provider')).toEqual(mapped('in_transit'));
    expect(answer('dhl-ecommerce', null, 'Returned to sender')).toEqual(mapped('returned'));
    expect(answer('dhl-ecommerce', null, 'Synthetic scan wording')).toEqual(unknown);
  });

  it('answers DHL eCommerce Netherlands by its code, and a copy without one by the wording the tracking page gives a code', () => {
    expect(answer('dhl-ecommerce-nl', 'DELIVERED_AT_NEIGHBOURS', 'Delivered at the neighbours')).toEqual(mapped('delivered'));
    expect(answer('dhl-ecommerce-nl', 'DELIVERED_AT_ACCESSPOINT', 'Delivered at DHL ServicePoint')).toEqual(mapped('ready_for_pickup'));
    expect(answer('dhl-ecommerce-nl', null, 'Delivered at DHL ServicePoint')).toEqual(mapped('ready_for_pickup'));
    expect(answer('dhl-ecommerce-nl', null, 'Address details corrected')).toEqual(mapped('in_transit'));
    // Four codes word a courier's collection alike, at two stages.
    expect(answer('dhl-ecommerce-nl', null, 'Picked up at DHL ServicePoint by the courier')).toEqual(unknown);
    // A code the list does not know was staged by its category, which is not stored.
    expect(answer('dhl-ecommerce-nl', 'SYNTHETIC_CODE', 'Synthetic code')).toEqual(unknown);
  });

  it('answers Nova Poshta by its movement code, and leaves the codes a return shares out on purpose', () => {
    expect(answer('nova-poshta', '4', 'Synthetic movement')).toEqual(mapped('accepted'));
    expect(answer('nova-poshta', '7', 'Synthetic movement')).toEqual(mapped('ready_for_pickup'));
    expect(answer('nova-poshta', '101', 'Synthetic movement')).toEqual(mapped('out_for_delivery'));
    expect(answer('nova-poshta', '115', 'Synthetic movement')).toEqual(mapped('customs'));
    expect(answer('nova-poshta', '10', 'Synthetic movement')).toEqual(mapped('delivered'));
    expect(answer('nova-poshta', '9', 'Synthetic movement')).toEqual(gap);
    expect(answer('nova-poshta', '102', 'Synthetic movement')).toEqual(gap);
    expect(answer('nova-poshta', '999', 'Synthetic movement')).toEqual(unknown);
    expect(answer('nova-poshta', null, 'Synthetic movement')).toEqual(unknown);
  });

  it("answers Swiss Post Cargo by its wording and codes, without the adapter's in-transit default", () => {
    expect(answer('swiss-post-cargo', 'DLV', 'Sendung')).toEqual(mapped('delivered'));
    expect(answer('swiss-post-cargo', null, 'Zugestellt')).toEqual(mapped('delivered'));
    expect(answer('swiss-post-cargo', 'SCA', 'Sendung')).toEqual(mapped('out_for_delivery'));
    expect(answer('swiss-post-cargo', 'NTF', 'Sendung')).toEqual(mapped('registered'));
    expect(answer('swiss-post-cargo', 'RFS', 'Sendung')).toEqual(mapped('accepted'));
    expect(answer('swiss-post-cargo', 'XYZ', 'Retour an Absender')).toEqual(mapped('returned'));
    expect(answer('swiss-post-cargo', 'XYZ', 'Sortierung')).toEqual(unknown);
  });

  it("answers SunYou by its event code, and leaves a code it does not list open", () => {
    expect(answer('sunyou', 'PreAlert', 'Synthetic scan')).toEqual(mapped('registered'));
    expect(answer('sunyou', 'InboundScan', 'Synthetic scan')).toEqual(mapped('accepted'));
    expect(answer('sunyou', 'ClearanceProcess', 'Synthetic scan')).toEqual(mapped('customs'));
    expect(answer('sunyou', 'SyntheticCode', 'Synthetic scan')).toEqual(unknown);
    expect(answer('sunyou', null, 'Synthetic scan')).toEqual(unknown);
  });

  it("answers Japan Post by its exact English labels", () => {
    expect(answer('japan-post', null, 'Posting/Collection')).toEqual(mapped('accepted'));
    expect(answer('japan-post', null, 'Item out for physical delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('japan-post', null, 'Absence. Attempted delivery.')).toEqual(mapped('failed_attempt'));
    expect(answer('japan-post', null, 'Final delivery')).toEqual(mapped('delivered'));
    expect(answer('japan-post', null, 'Final delivery soon')).toEqual(unknown);
  });

  it("answers Hermes Einrichtungs-Service's wording through the id it is recorded with", () => {
    expect(answer('hermes', null, 'Deine Sendung wurde elektronisch angekündigt. Weitere Informationen folgen in Kürze.')).toEqual(mapped('registered'));
    expect(answer('hermes', null, 'Du hast den Liefertermin bestätigt.')).toEqual(mapped('in_transit'));
    expect(answer('hermes', null, 'Deine Sendung wurde erfolgreich zugestellt.')).toEqual(mapped('delivered'));
    expect(answer('hermes', null, 'Eine neue Formulierung')).toEqual(unknown);
  });

  it('answers Purolator by its code', () => {
    expect(answer('purolator', '3010', 'Label information electronically submitted')).toEqual(mapped('registered'));
    expect(answer('purolator', '2300', 'Picked up by Purolator')).toEqual(mapped('accepted'));
    expect(answer('purolator', '9250', 'Attempted delivery - receiver unavailable')).toEqual(mapped('failed_attempt'));
    expect(answer('purolator', '9000', 'Shipment delivered')).toEqual(mapped('delivered'));
    expect(answer('purolator', '0001', 'Synthetic scan')).toEqual(unknown);
    expect(answer('purolator', null, 'Shipment delivered')).toEqual(unknown);
  });

  it('answers Relais Colis by its French sentence, and leaves a return it only announces open', () => {
    expect(answer('relais-colis', null, 'Colis pris en charge')).toEqual(mapped('in_transit'));
    expect(answer('relais-colis', null, 'Colis en cours de livraison')).toEqual(mapped('out_for_delivery'));
    expect(answer('relais-colis', null, 'Colis retiré par le destinataire')).toEqual(mapped('delivered'));
    expect(answer('relais-colis', null, 'Votre colis sera retourné')).toEqual(unknown);
    expect(answer('relais-colis', null, 'Une phrase inconnue')).toEqual(unknown);
  });

  it('answers Yamato by its exact labels', () => {
    expect(answer('yamato', null, '荷物受付')).toEqual(mapped('accepted'));
    expect(answer('yamato', null, '発送済み')).toEqual(mapped('in_transit'));
    expect(answer('yamato', null, '配達完了')).toEqual(mapped('delivered'));
    expect(answer('yamato', null, '配達予定')).toEqual(unknown);
  });

  it('answers Korea Post by its exact labels, English or Korean', () => {
    expect(answer('korea-post', null, 'Posting/Collection')).toEqual(mapped('accepted'));
    expect(answer('korea-post', null, 'Ready for customs clearance')).toEqual(mapped('customs'));
    expect(answer('korea-post', null, '배달준비')).toEqual(mapped('out_for_delivery'));
    expect(answer('korea-post', null, 'Delivery complete')).toEqual(mapped('delivered'));
    expect(answer('korea-post', null, 'Delivery complete soon')).toEqual(unknown);
  });

  it("answers Planzer by its labels, its \"Shipped\" stored as the delivery it means", () => {
    expect(answer('planzer', null, 'Recorded')).toEqual(mapped('registered'));
    expect(answer('planzer', null, 'In delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('planzer', null, 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('planzer', null, 'Not delivered – A delivery card has been deposited')).toEqual(mapped('failed_attempt'));
    expect(answer('planzer', null, 'Zugestellt.')).toEqual(mapped('delivered'));
    expect(answer('planzer', null, 'Versandt')).toEqual(unknown);
  });

  it('answers Estafeta by its Spanish wording', () => {
    expect(answer('estafeta', null, 'Recibido por Estafeta')).toEqual(mapped('accepted'));
    expect(answer('estafeta', null, 'En tránsito')).toEqual(mapped('in_transit'));
    expect(answer('estafeta', null, 'En proceso de entrega a domicilio')).toEqual(mapped('out_for_delivery'));
    expect(answer('estafeta', null, 'Entregado')).toEqual(mapped('delivered'));
    expect(answer('estafeta', null, 'Una frase nueva')).toEqual(unknown);
  });

  it("answers Intelcom by its code, and leaves a code it does not know open", () => {
    expect(answer('intelcom', '105', 'Synthetic label')).toEqual(mapped('accepted'));
    expect(answer('intelcom', '300', 'Synthetic label')).toEqual(mapped('out_for_delivery'));
    expect(answer('intelcom', '601', 'Synthetic label')).toEqual(mapped('delivered'));
    expect(answer('intelcom', '999', 'Delivered')).toEqual(unknown);
    expect(answer('intelcom', null, 'Synthetic label')).toEqual(unknown);
  });

  it("answers Landmark Global by its own labels", () => {
    expect(answer('landmark-global', null, 'Shipment Data Uploaded')).toEqual(mapped('registered'));
    expect(answer('landmark-global', null, 'Out for Delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('landmark-global', null, 'Out For Delivery To Courier')).toEqual(mapped('in_transit'));
    expect(answer('landmark-global', null, 'Item deposited to local postal operator')).toEqual(mapped('in_transit'));
    expect(answer('landmark-global', null, 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('landmark-global', null, 'A partner wording')).toEqual(unknown);
  });

  it("answers Pos Malaysia by a summary's own wording, and the delivery its parcel status adds", () => {
    expect(answer('pos-malaysia', null, 'Collected')).toEqual(mapped('accepted'));
    expect(answer('pos-malaysia', 'SYNTHETIC', 'Out for delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('pos-malaysia', null, 'Your parcel has been presented to the Customs Authority for inspection')).toEqual(mapped('customs'));
    expect(answer('pos-malaysia', 'DELIVERED', 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('pos-malaysia', 'SYNTHETIC', 'Synthetic process text')).toEqual(unknown);
  });

  it('answers Singapore Post by its event code', () => {
    expect(answer('singapore-post', 'IR', 'Synthetic scan')).toEqual(mapped('registered'));
    expect(answer('singapore-post', 'HC', 'Synthetic scan')).toEqual(mapped('customs'));
    expect(answer('singapore-post', 'AL', 'Synthetic scan')).toEqual(mapped('out_for_delivery'));
    expect(answer('singapore-post', 'FD', 'Synthetic scan')).toEqual(mapped('delivered'));
    expect(answer('singapore-post', 'ZZ', 'Synthetic scan')).toEqual(unknown);
    expect(answer('singapore-post', null, 'Synthetic scan')).toEqual(unknown);
  });

  it("answers The Courier Guy by its status code, and a copy by the wording the parser writes for one", () => {
    expect(answer('the-courier-guy', 'collected', 'Collected')).toEqual(mapped('accepted'));
    expect(answer('the-courier-guy', 'in-locker', 'In locker')).toEqual(mapped('ready_for_pickup'));
    expect(answer('the-courier-guy', 'delivered', 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('the-courier-guy', null, 'Out for delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('the-courier-guy', 'synthetic-code', 'Synthetic code')).toEqual(unknown);
  });

  it("answers SPX Philippines by its tracking code or a legacy row's status name", () => {
    expect(answer('spx-ph', 'F000', 'Synthetic scan')).toEqual(mapped('registered'));
    expect(answer('spx-ph', 'F600', 'Synthetic scan')).toEqual(mapped('out_for_delivery'));
    expect(answer('spx-ph', 'F980', 'Synthetic scan')).toEqual(mapped('delivered'));
    expect(answer('spx-ph', 'OnHold', 'Synthetic scan')).toEqual(mapped('exception'));
    expect(answer('spx-ph', 'F777', 'Delivered')).toEqual(unknown);
  });

  it("answers Yunda by its Chinese label, and a return leg by the wording the parser gives it", () => {
    expect(answer('yunda', '已揽件', 'Picked up')).toEqual(mapped('accepted'));
    expect(answer('yunda', '派送中', 'Out for delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('yunda', '已签收', 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('yunda', '已签收', 'Returned to the sender')).toEqual(mapped('returned'));
    expect(answer('yunda', '待取件', 'Ready for pickup on its way back')).toEqual(mapped('ready_for_pickup'));
    expect(answer('yunda', '示例状态', 'Synthetic label')).toEqual(unknown);
    expect(answer('yunda', null, 'Delivered')).toEqual(unknown);
  });

  it("answers Xpressbees by its state wording, and leaves a bare delivery open on purpose", () => {
    expect(answer('xpressbees', 'SYN', 'Picked Up')).toEqual(mapped('accepted'));
    expect(answer('xpressbees', 'SYN', 'Out for Delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('xpressbees', 'SYN', 'RTO Delivered')).toEqual(mapped('returned'));
    // The return's own delivery when the row's category is a return to origin.
    expect(answer('xpressbees', 'SYN', 'Delivered')).toEqual(unknown);
    expect(answer('xpressbees', null, 'Delivered')).toEqual(gap);
    expect(answer('xpressbees', 'SYN', 'Shipment is on its way')).toEqual(unknown);
  });

  it("answers Ninja Van by its event type, and leaves a delivery open on purpose", () => {
    expect(answer('ninja-van', 'HUB_INBOUND_SCAN', 'hub inbound scan')).toEqual(mapped('in_transit'));
    expect(answer('ninja-van', 'RTS', 'rts')).toEqual(mapped('exception'));
    // The return's delivery, or a problem on the way back, by a marker the stored scan does not keep.
    expect(answer('ninja-van', 'DELIVERY_SUCCESS', 'delivery success')).toEqual(gap);
    expect(answer('ninja-van', 'SYNTHETIC_TYPE', 'synthetic type')).toEqual(unknown);
  });

  it("answers Spee-Dee by its activity", () => {
    expect(answer('spee-dee', null, 'ARRIVAL SCAN')).toEqual(mapped('in_transit'));
    expect(answer('spee-dee', null, 'OUT FOR DELIVERY')).toEqual(mapped('out_for_delivery'));
    expect(answer('spee-dee', null, 'DELIVERED')).toEqual(mapped('delivered'));
    expect(answer('spee-dee', null, 'DEPARTURE SCAN')).toEqual(unknown);
  });

  it('answers Aramex by its exact wording, and leaves its notes out on purpose', () => {
    expect(answer('aramex', null, 'The shipment has been delivered')).toEqual(mapped('delivered'));
    expect(answer('aramex', null, 'Shipment collected from the shipper')).toEqual(mapped('accepted'));
    expect(answer('aramex', null, 'The shipment is currently going through customs inspection')).toEqual(mapped('customs'));
    expect(answer('aramex', null, 'The delivery address has been updated')).toEqual(mapped('in_transit'));
    expect(answer('aramex', null, 'Customer ID received')).toEqual(gap);
    expect(answer('aramex', null, 'Shipment charges paid')).toEqual(gap);
    expect(answer('aramex', null, 'Synthetic scan wording')).toEqual(unknown);
  });

  it('answers Blue Dart by its scan wording, in any case', () => {
    expect(answer('blue-dart', null, 'Shipment Picked Up')).toEqual(mapped('accepted'));
    expect(answer('blue-dart', null, 'Pickup Employee Is Out To P/U Shipment')).toEqual(mapped('registered'));
    expect(answer('blue-dart', null, 'SHIPMENT OUT FOR DELIVERY')).toEqual(mapped('out_for_delivery'));
    expect(answer('blue-dart', null, 'Cnee Refused Id/Otp Not Shared-Incorrect')).toEqual(mapped('failed_attempt'));
    expect(answer('blue-dart', null, 'Shipment Returned Back To Shipper')).toEqual(mapped('returned'));
    expect(answer('blue-dart', null, 'Synthetic scan wording')).toEqual(unknown);
  });

  it('answers Bring by its event code, a deviation by the cause its wording names, and leaves notices out on purpose', () => {
    expect(answer('bring-posten', 'HANDED_IN', 'Handed in')).toEqual(mapped('accepted'));
    expect(answer('bring-posten', 'TRANSPORT_TO_RECIPIENT', 'Out for delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('bring-posten', 'DELIVERED_SENDER', 'Returned to sender')).toEqual(mapped('returned'));
    expect(answer('bring-posten', 'DEVIATION', 'Handed in after the deadline')).toEqual(mapped('accepted'));
    expect(answer('bring-posten', 'DEVIATION', 'Delayed')).toEqual(mapped('exception'));
    expect(answer('bring-posten', 'DEVIATION', 'Delivery exception')).toEqual(mapped('exception'));
    expect(answer('bring-posten', 'DELIVERY_CHANGED', 'Delivery details changed')).toEqual(gap);
    expect(answer('bring-posten', 'NOTIFICATION_SENT', 'Notification sent')).toEqual(gap);
    expect(answer('bring-posten', 'SYNTHETIC_CODE', 'Synthetic code')).toEqual(unknown);
    // The wording is the scraper's own, so a copy without the code is not read by it.
    expect(answer('bring-posten', null, 'Delivered')).toEqual(unknown);
  });

  it("answers C chez vous by its step's wording, and leaves an unknown step open", () => {
    expect(answer('c-chez-vous', null, 'Commande enregistrée')).toEqual(mapped('registered'));
    expect(answer('c-chez-vous', null, 'Commande en route vers la plateforme régionale')).toEqual(mapped('in_transit'));
    expect(answer('c-chez-vous', null, 'Commande disponible au point retrait')).toEqual(mapped('ready_for_pickup'));
    expect(answer('c-chez-vous', null, 'Commande retirée au point retrait')).toEqual(mapped('delivered'));
    expect(answer('c-chez-vous', null, 'Commande livrée')).toEqual(mapped('delivered'));
    expect(answer('c-chez-vous', null, 'Suivi C Chez Vous')).toEqual(unknown);
  });

  it('answers Canpar by its code, and a copy without one by the wording Canpar gives a code', () => {
    expect(answer('canpar', 'WC', 'Out for Delivery-Almost There!')).toEqual(mapped('out_for_delivery'));
    expect(answer('canpar', 'DRP', 'Synthetic scan')).toEqual(mapped('ready_for_pickup'));
    expect(answer('canpar', 'NH', 'Consignee Not Home')).toEqual(mapped('failed_attempt'));
    expect(answer('canpar', null, 'Picked Up and On the Move!')).toEqual(mapped('accepted'));
    expect(answer('canpar', null, 'Your Package was Delivered with no Signature Required')).toEqual(mapped('delivered'));
    expect(answer('canpar', 'ZZZ', 'Our Package was Delivered')).toEqual(unknown);
    expect(answer('canpar', null, 'Synthetic scan')).toEqual(unknown);
  });

  it("answers Colisweb by its step's wording, and leaves the wording two steps share out on purpose", () => {
    expect(answer('colisweb', null, 'Livraison effectuée')).toEqual(mapped('delivered'));
    expect(answer('colisweb', null, 'Livraison annulée')).toEqual(mapped('returned'));
    expect(answer('colisweb', null, 'Colis pris en charge')).toEqual(mapped('in_transit'));
    expect(answer('colisweb', null, 'Livraison en cours')).toEqual(mapped('out_for_delivery'));
    expect(answer('colisweb', null, 'Livraison confirmée')).toEqual(mapped('registered'));
    expect(answer('colisweb', null, 'Incident de livraison')).toEqual(gap);
    expect(answer('colisweb', null, 'Mise à jour Colisweb')).toEqual(unknown);
  });

  it("answers Dachser by the English wording its rules give a scan, and a copy of Dachser's own wording by those rules", () => {
    expect(answer('dachser', null, 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('dachser', null, 'Shipment exception')).toEqual(mapped('exception'));
    expect(answer('dachser', null, 'Delivery attempt was unsuccessful')).toEqual(mapped('failed_attempt'));
    expect(answer('dachser', null, 'Delivery appointment updated')).toEqual(mapped('in_transit'));
    expect(answer('dachser', null, 'Shipment accepted by Dachser')).toEqual(mapped('accepted'));
    expect(answer('dachser', null, 'Entregado')).toEqual(mapped('delivered'));
    expect(answer('dachser', null, 'No entregado, destinatario ausente')).toEqual(mapped('failed_attempt'));
    expect(answer('dachser', null, 'Nueva fecha de entrega')).toEqual(mapped('in_transit'));
    // The neutral update replaced wording no rule matched, which the stored scan does not keep.
    expect(answer('dachser', null, 'Dachser tracking update')).toEqual(unknown);
    expect(answer('dachser', null, 'Synthetic scan')).toEqual(unknown);
  });

  it('answers DHL eCommerce Iberia by its code, and a depot scan by its wording before the town', () => {
    expect(answer('dhl-ecommerce-es', 'DOC', 'Shipment data received')).toEqual(mapped('registered'));
    expect(answer('dhl-ecommerce-es', 'IS', 'Delivered to DHL ServicePoint, ready for collection by the recipient')).toEqual(mapped('ready_for_pickup'));
    expect(answer('dhl-ecommerce-es', 'PC', 'Delivered, POD pending')).toEqual(mapped('delivered'));
    expect(answer('dhl-ecommerce-es', 'NH', 'The delivery could not be made due to consignee absent')).toEqual(mapped('failed_attempt'));
    expect(answer('dhl-ecommerce-es', 'ZZZ', 'Picked up Example Town')).toEqual(mapped('accepted'));
    expect(answer('dhl-ecommerce-es', 'ZZZ', 'Arrived at Example Town')).toEqual(mapped('in_transit'));
    expect(answer('dhl-ecommerce-es', 'ZZZ', 'Synthetic depot scan')).toEqual(mapped('in_transit'));
    expect(answer('dhl-ecommerce-es', null, 'Tránsito en Example Town')).toEqual(mapped('in_transit'));
    expect(answer('dhl-ecommerce-es', null, 'Delivered')).toEqual(unknown);
    expect(answer('dhl-ecommerce-es', 'XX', 'Arrived at Example Town')).toEqual(unknown);
  });

  it('answers DHL eCommerce UK by its sentence without the number, with either apostrophe', () => {
    expect(answer('dhl-ecommerce-uk', null, 'Your shipment has been collected')).toEqual(mapped('accepted'));
    expect(answer('dhl-ecommerce-uk', null, 'Your shipment is out for delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('dhl-ecommerce-uk', null, 'Collected')).toEqual(mapped('delivered'));
    expect(answer('dhl-ecommerce-uk', null, 'Delivery Attempted')).toEqual(mapped('failed_attempt'));
    expect(answer('dhl-ecommerce-uk', null, 'We’re sorry but your shipment was refused on delivery. Please contact your sender for further information'))
      .toEqual(mapped('exception'));
    expect(answer('dhl-ecommerce-uk', null, 'Synthetic scan wording')).toEqual(unknown);
  });

  it("answers a provider's copy of a DHL eCommerce UK sentence that still names the shipment", () => {
    expect(answer('dhl-ecommerce-uk', null, 'Your shipment 48261593704815 is out for delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('dhl-ecommerce-uk', null, 'Your shipment 948261593 has been collected')).toEqual(mapped('accepted'));
    expect(answer('dhl-ecommerce-uk', null, 'Your shipment 482615 is out for delivery')).toEqual(unknown);
  });

  it('answers DTDC by a status label kept as its wording, and leaves a delivery without its leg out on purpose', () => {
    expect(answer('dtdc', 'softdata_upload', 'Booked')).toEqual(mapped('registered'));
    expect(answer('dtdc', 'pickup_completed', 'Picked Up')).toEqual(mapped('accepted'));
    expect(answer('dtdc', 'outfordelivery', 'Out For Delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('dtdc', null, 'RTO Booked')).toEqual(mapped('exception'));
    expect(answer('dtdc', null, 'Delivered')).toEqual(gap);
    // A stored delivery was staged by its leg; the internal code does not tell the leg either.
    expect(answer('dtdc', 'delivered', 'Delivered')).toEqual(unknown);
    expect(answer('dtdc', 'in_transit', 'Synthetic scan wording')).toEqual(unknown);
  });

  it("answers EMS by the EMS Cooperative's exact labels", () => {
    expect(answer('ems', null, 'Posted')).toEqual(mapped('accepted'));
    expect(answer('ems', null, 'Held at destination import office')).toEqual(mapped('customs'));
    expect(answer('ems', null, 'Released from import customs')).toEqual(mapped('in_transit'));
    expect(answer('ems', null, 'Delivery attempted')).toEqual(mapped('failed_attempt'));
    expect(answer('ems', null, 'Export cancelled')).toEqual(mapped('exception'));
    expect(answer('ems', null, 'Delivered soon')).toEqual(unknown);
  });

  it("answers Delhivery by its wording, and leaves a delivery out on purpose, since the stored scan does not keep the return leg", () => {
    expect(answer('delhivery', null, 'Picked Up')).toEqual(mapped('accepted'));
    expect(answer('delhivery', null, 'IN_TRANSIT')).toEqual(mapped('in_transit'));
    expect(answer('delhivery', null, 'Dispatched')).toEqual(mapped('out_for_delivery'));
    expect(answer('delhivery', null, 'DELIVERED_SELLER')).toEqual(mapped('returned'));
    expect(answer('delhivery', null, 'RTO')).toEqual(mapped('returned'));
    expect(answer('delhivery', null, 'Canceled')).toEqual(mapped('exception'));
    expect(answer('delhivery', null, 'Delivered')).toEqual(gap);
    expect(answer('delhivery', null, 'Synthetic scan')).toEqual(unknown);
  });

  it("answers Ekart by its prose or coded wording, and leaves a delivery out on purpose, since the stored scan does not keep the scans before it", () => {
    expect(answer('ekart', null, 'Shipment Created')).toEqual(mapped('registered'));
    expect(answer('ekart', 'PickupReceived', 'PickupReceived - Example Hub')).toEqual(mapped('accepted'));
    expect(answer('ekart', 'InscannedAtDH', 'InscannedAtDH - Example Hub')).toEqual(mapped('in_transit'));
    // A copy without the code reads the code from the wording.
    expect(answer('ekart', null, 'InscannedAtDH - Example Hub')).toEqual(mapped('in_transit'));
    expect(answer('ekart', null, 'Received at Example Hub')).toEqual(mapped('in_transit'));
    expect(answer('ekart', null, 'Out For Delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('ekart', 'undelivered_attempted', 'undelivered_attempted - Example Hub')).toEqual(mapped('failed_attempt'));
    expect(answer('ekart', 'ShipmentRtoConfirmed', 'ShipmentRtoConfirmed - Example Hub')).toEqual(mapped('exception'));
    expect(answer('ekart', null, 'Delivered')).toEqual(gap);
    expect(answer('ekart', null, 'Synthetic scan')).toEqual(unknown);
    expect(answer('ekart', 'SyntheticCode', 'SyntheticCode - Example Hub')).toEqual(unknown);
  });

  it("answers JD Logistics by its operation code, and a partner's label by its wording", () => {
    expect(answer('jd-logistics', 'COSH', 'Synthetic scan')).toEqual(mapped('registered'));
    expect(answer('jd-logistics', '3041', 'Picking Completed.')).toEqual(mapped('accepted'));
    expect(answer('jd-logistics', 'CCL', 'Synthetic scan')).toEqual(mapped('customs'));
    expect(answer('jd-logistics', 'DMLMLS', 'Synthetic scan')).toEqual(mapped('out_for_delivery'));
    expect(answer('jd-logistics', 'DLV', 'Synthetic scan')).toEqual(mapped('delivered'));
    expect(answer('jd-logistics', 'SRRF3P', 'Shipping Label Created')).toEqual(mapped('registered'));
    expect(answer('jd-logistics', null, 'Shipping Label Created')).toEqual(mapped('registered'));
    // Another code is left to the shared wording rules, and a copy without its code to review.
    expect(answer('jd-logistics', 'SRRF3P', 'Synthetic scan')).toEqual(unknown);
    expect(answer('jd-logistics', null, 'Picking Completed.')).toEqual(unknown);
  });

  it("answers Ciblex by the English wording its adapter stores, and a copy by Ciblex's French label", () => {
    expect(answer('ciblex', null, 'Shipment collected')).toEqual(mapped('accepted'));
    expect(answer('ciblex', null, 'Parcel processed at Ciblex facility')).toEqual(mapped('in_transit'));
    expect(answer('ciblex', null, 'Ready for pickup')).toEqual(mapped('ready_for_pickup'));
    expect(answer('ciblex', null, 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('ciblex', null, 'Returned to sender')).toEqual(mapped('returned'));
    expect(answer('ciblex', null, 'Colis pris en charge')).toEqual(mapped('accepted'));
    expect(answer('ciblex', null, 'COLIS LIVRE')).toEqual(mapped('delivered'));
    expect(answer('ciblex', null, 'Disponible au relais')).toEqual(mapped('ready_for_pickup'));
    // A label the adapter does not read is stored in neutral wording, without the label.
    expect(answer('ciblex', null, 'Ciblex tracking update')).toEqual(unknown);
    expect(answer('ciblex', null, 'Acheminement contractuel du colis en 48h00')).toEqual(unknown);
    expect(answer('ciblex', null, 'Colis livré demain')).toEqual(unknown);
  });

  it("answers Asendia by its own codes, a partner's scan by its wording, and a scan without a code by either tracker's wording", () => {
    expect(answer('asendia', '1', 'Shipment Information Received')).toEqual(mapped('registered'));
    expect(answer('asendia', '2', 'Processed by Asendia USA')).toEqual(mapped('accepted'));
    expect(answer('asendia', 'ME3', 'Synthetic scan')).toEqual(mapped('in_transit'));
    expect(answer('asendia', 'IMPCUSTIN', 'In customs authorities')).toEqual(mapped('customs'));
    expect(answer('asendia', 'DELIVERY', 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('asendia', 'B8', 'Customs released')).toEqual(mapped('in_transit'));
    expect(answer('asendia', 'MA', 'Pre-Shipment, USPS Awaiting Item')).toEqual(mapped('registered'));
    expect(answer('asendia', 'FP05', 'It’s happening, your parcel will be delivered today. Get ready!')).toEqual(mapped('out_for_delivery'));
    expect(answer('asendia', null, 'Your parcel is ready for pick up')).toEqual(mapped('ready_for_pickup'));
    expect(answer('asendia', null, 'Information received')).toEqual(mapped('registered'));
    expect(answer('asendia', null, 'Delivered')).toEqual(mapped('delivered'));
    // The global portal's phrases read DAI Post's round as a delivery.
    expect(answer('asendia', null, 'It’s happening, your parcel will be delivered today. Get ready!')).toEqual(gap);
    // A partner's code is read by its wording alone, and FullTrack's return and inquiry codes stay open.
    expect(answer('asendia', 'B1', 'Synthetic scan')).toEqual(unknown);
    expect(answer('asendia', 'RETSYNTHETIC', 'Delivered')).toEqual(unknown);
    expect(answer('asendia', null, 'Synthetic scan')).toEqual(unknown);
  });

  it("answers CNE by its labels, and by its state code where no wording rule reads the label", () => {
    expect(answer('cne', '1', 'Parcel Infomation Received')).toEqual(mapped('registered'));
    expect(answer('cne', null, 'Picked Up by Courier')).toEqual(mapped('accepted'));
    expect(answer('cne', '1', 'Arrived at Transit Airport')).toEqual(mapped('in_transit'));
    expect(answer('cne', '1', 'The shipment is picked up by customs broker')).toEqual(mapped('customs'));
    expect(answer('cne', '1', 'On Board with Courier；Synthetic explanation')).toEqual(mapped('out_for_delivery'));
    expect(answer('cne', '9', 'Sorting failed []')).toEqual(mapped('exception'));
    expect(answer('cne', '8', "It was returned to customer's address by CNE")).toEqual(mapped('returned'));
    // A partner's acceptance once CNE codes the parcel as shipping, and wording no rule reads, take the code.
    expect(answer('cne', '1', 'Accepted at USPS Origin Facility')).toEqual(mapped('in_transit'));
    expect(answer('cne', '3', 'Synthetic scan')).toEqual(mapped('delivered'));
    expect(answer('cne', '5', 'Synthetic scan')).toEqual(mapped('customs'));
    // Wording only the shared rules read, and a code that establishes nothing, stay open.
    expect(answer('cne', null, 'Accepted at USPS Origin Facility')).toEqual(unknown);
    expect(answer('cne', '3', 'Delivered')).toEqual(unknown);
    expect(answer('cne', '4', 'Synthetic scan')).toEqual(unknown);
    expect(answer('cne', null, 'Synthetic scan')).toEqual(unknown);
  });

  it("answers DHL eCommerce Poland by its history page's English and Polish wording", () => {
    expect(answer('dhl-ecommerce-pl', null, 'The shipment has been dropped off at depot by the sender.')).toEqual(mapped('accepted'));
    expect(answer('dhl-ecommerce-pl', null, 'Przesyłka dotarła do oddziału nadawczego DHL Parcel.')).toEqual(mapped('accepted'));
    expect(answer('dhl-ecommerce-pl', null, 'The shipment is handled in Sorting Center')).toEqual(mapped('in_transit'));
    expect(answer('dhl-ecommerce-pl', null, 'Przesyłka przekazana kurierowi do doręczenia')).toEqual(mapped('out_for_delivery'));
    expect(answer('dhl-ecommerce-pl', null, 'Delivered to customer.')).toEqual(mapped('delivered'));
    expect(answer('dhl-ecommerce-pl', null, 'Przesyłka doręczona do Odbiorcy.')).toEqual(mapped('delivered'));
    // The API's current status is no scan.
    expect(answer('dhl-ecommerce-pl', null, 'Parcel has been delivered')).toEqual(unknown);
    expect(answer('dhl-ecommerce-pl', null, 'Synthetic scan')).toEqual(unknown);
  });

  it("answers GEODIS by its French sentences, and leaves a delivery still to come in transit", () => {
    expect(answer('geodis', null, "En préparation chez l'expéditeur")).toEqual(mapped('registered'));
    expect(answer('geodis', null, 'Envoi pris en charge')).toEqual(mapped('in_transit'));
    expect(answer('geodis', null, 'En cours de livraison')).toEqual(mapped('out_for_delivery'));
    expect(answer('geodis', null, 'Votre colis va être livré')).toEqual(mapped('in_transit'));
    expect(answer('geodis', null, 'Votre colis a été livré')).toEqual(mapped('delivered'));
    expect(answer('geodis', null, 'Colis disponible pour retrait')).toEqual(mapped('ready_for_pickup'));
    expect(answer('geodis', null, 'Destinataire absent')).toEqual(mapped('failed_attempt'));
    expect(answer('geodis', null, "Retour à l'expéditeur")).toEqual(mapped('returned'));
    expect(answer('geodis', null, 'Synthetic scan')).toEqual(unknown);
  });

  it("answers OnTrac by its event code, and leaves a copy without one open", () => {
    expect(answer('ontrac', 'EXRL', 'On its way to OnTrac')).toEqual(mapped('registered'));
    expect(answer('ontrac', 'ORIG', 'Origin Scan')).toEqual(mapped('in_transit'));
    expect(answer('ontrac', 'NFRP', 'Order has been transferred to another carrier')).toEqual(mapped('in_transit'));
    expect(answer('ontrac', 'OFDL', 'Out for Delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('ontrac', 'NDMI', 'Incomplete address. Please contact us')).toEqual(mapped('failed_attempt'));
    expect(answer('ontrac', 'DLVD', 'Package Delivered')).toEqual(mapped('delivered'));
    expect(answer('ontrac', 'ONHD', 'Details needed. Please contact us')).toEqual(mapped('exception'));
    expect(answer('ontrac', 'ZZZZ', 'Synthetic scan')).toEqual(unknown);
    expect(answer('ontrac', null, 'Package Delivered')).toEqual(unknown);
  });

  it("answers NZ Post by its EDIFACT code, and leaves a copy without one open", () => {
    expect(answer('nz-post', '997', 'Tracking number allocated to parcel')).toEqual(mapped('registered'));
    expect(answer('nz-post', '13', 'Collected from sender')).toEqual(mapped('accepted'));
    expect(answer('nz-post', '5019', 'Held for clearance')).toEqual(mapped('customs'));
    expect(answer('nz-post', '6028', 'Cleared for import')).toEqual(mapped('in_transit'));
    expect(answer('nz-post', '32', 'With courier for delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('nz-post', '52', 'Delivery attempted - refer to card')).toEqual(mapped('exception'));
    expect(answer('nz-post', '22', 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('nz-post', '9999', 'Synthetic scan')).toEqual(unknown);
    expect(answer('nz-post', null, 'Delivered')).toEqual(unknown);
  });

  it("answers Correos de Chile by its wording, with the portal's code where a stage needs it", () => {
    expect(answer('correos-chile', '001', 'ENVÍO ADMITIDO')).toEqual(mapped('accepted'));
    expect(answer('correos-chile', '003', 'ENVÍO EN PROCESO DE INTERNACIÓN AL PAÍS')).toEqual(mapped('customs'));
    expect(answer('correos-chile', '005', 'ENVIO EN REPARTO')).toEqual(mapped('out_for_delivery'));
    expect(answer('correos-chile', '006', 'ENVIO ENTREGADO')).toEqual(mapped('delivered'));
    expect(answer('correos-chile', null, 'RECIBIDO POR CORREOSCHILE')).toEqual(mapped('accepted'));
    expect(answer('correos-chile', null, 'ENVIO DESPACHADO AL PAIS DE DESTINO')).toEqual(mapped('in_transit'));
    expect(answer('correos-chile', null, 'ENVIO EN PROCESO DE INTERNACION')).toEqual(mapped('customs'));
    // A delivery without the portal's code stays open; the neutral update in place of free-form wording,
    // with any code or none, is a gap.
    expect(answer('correos-chile', null, 'ENVIO ENTREGADO')).toEqual(unknown);
    expect(answer('correos-chile', '001', 'ENVIO ENTREGADO')).toEqual(unknown);
    expect(answer('correos-chile', '006', 'Actualización del envío')).toEqual(gap);
    expect(answer('correos-chile', '12', 'Actualización del envío')).toEqual(gap);
    expect(answer('correos-chile', null, 'Actualización del envío')).toEqual(gap);
  });

  it('answers India Post by its event code and wording as the adapter read the row, and leaves a row no rule knows open', () => {
    expect(answer('india-post', 'ItemBooked', 'Item Booked')).toEqual(mapped('accepted'));
    expect(answer('india-post', 'CustomReceive', 'Item Presented to Customs')).toEqual(mapped('customs'));
    expect(answer('india-post', 'CustomReturn', 'Item Returned from Customs')).toEqual(mapped('in_transit'));
    expect(answer('india-post', 'ExportCustoms', 'Out of Export Customs')).toEqual(mapped('in_transit'));
    expect(answer('india-post', 'DeliveryAttempted', 'Delivery Attempted')).toEqual(mapped('failed_attempt'));
    expect(answer('india-post', 'ItemDelivered', 'Item Delivered')).toEqual(mapped('delivered'));
    expect(answer('india-post', 'ReturnToSender', 'Return To Sender')).toEqual(mapped('returned'));
    // The code stages a row its wording alone does not, and a spelled-out code reads as the code did.
    expect(answer('india-post', 'ItemReceived', 'Received')).toEqual(mapped('in_transit'));
    expect(answer('india-post', 'ItemTransfered', 'Transferred to Office of Exchange')).toEqual(mapped('in_transit'));
    // A flight keeps its own reading, whatever its wording.
    expect(answer('india-post', 'AircraftTakeOff', 'Aircraft Departure')).toEqual(mapped('in_transit'));
    expect(answer('india-post', 'AircraftTakeOff', 'Flight ZZ0102 departed: Frankfurt Airport (FRA) → CDG')).toEqual(mapped('in_transit'));
    expect(answer('india-post', 'MailArrived', 'Flight ZZ0102 arrived: FRA → Paris Charles de Gaulle Airport (CDG)')).toEqual(mapped('in_transit'));
    expect(answer('india-post', 'BagUnloaded', 'Bag unloaded at destination Airport')).toEqual(mapped('in_transit'));
    expect(answer('india-post', 'ItemTransfered', 'Transfer to OOE (Otb)')).toEqual(mapped('in_transit'));
    // The adapter keeps such a row in transit; the map leaves it open.
    expect(answer('india-post', 'SyntheticEvent', 'Synthetic Event')).toEqual(unknown);
    expect(answer('india-post', null, 'Synthetic scan')).toEqual(unknown);
  });

  it('answers Ukrposhta by its code, and a delivery worded as a return as returned', () => {
    expect(answer('ukrposhta', '10100', 'Registered')).toEqual(mapped('accepted'));
    expect(answer('ukrposhta', '89000', 'Item presented to customs')).toEqual(mapped('customs'));
    expect(answer('ukrposhta', '21700', 'Return: Arrived to the Branch')).toEqual(mapped('ready_for_pickup'));
    expect(answer('ukrposhta', '31200', "Returned to Sender (Due to Recipient's Refusal)")).toEqual(mapped('exception'));
    expect(answer('ukrposhta', '48000', 'Final delivery')).toEqual(mapped('delivered'));
    expect(answer('ukrposhta', '41000', 'Return: Delivered to Sender')).toEqual(mapped('returned'));
    expect(answer('ukrposhta', '41000', 'Повернення. Вручено відправнику')).toEqual(mapped('returned'));
    // A code the table does not know stays open, and so does wording without a code, which neither source sends.
    expect(answer('ukrposhta', '99999', 'Final delivery')).toEqual(unknown);
    expect(answer('ukrposhta', null, 'Final delivery')).toEqual(unknown);
  });

  it('answers Heppner by the English wording it stores, and leaves its neutral update open', () => {
    expect(answer('heppner', 'LIV_SYN', 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('heppner', 'SOL_REI', 'Returned to sender')).toEqual(mapped('returned'));
    expect(answer('heppner', 'PCH_SYN', 'Shipment collected')).toEqual(mapped('accepted'));
    expect(answer('heppner', null, 'Delivery instructions required')).toEqual(mapped('exception'));
    expect(answer('heppner', 'SYN_SYN', 'Heppner tracking update')).toEqual(unknown);
  });

  it("answers Hongkong Post by its own wordings, and leaves the shared rules' readings open", () => {
    expect(answer('hongkong-post', null, 'Posted')).toEqual(mapped('accepted'));
    expect(answer('hongkong-post', null, 'Held by customs.')).toEqual(mapped('customs'));
    expect(answer('hongkong-post', null, 'Delivery incomplete')).toEqual(mapped('failed_attempt'));
    expect(answer('hongkong-post', null, 'Item out for delivery')).toEqual(unknown);
  });

  it("answers LBC by its app's code, or a web scan's wording, in any case", () => {
    expect(answer('lbc-express', '8000', 'Synthetic wording')).toEqual(mapped('accepted'));
    expect(answer('lbc-express', '5', 'Released to authorized representative')).toEqual(mapped('delivered'));
    expect(answer('lbc-express', '0', 'Shipment has been received at Example Hub.')).toEqual(mapped('in_transit'));
    expect(answer('lbc-express', null, 'Please expect delivery within the day.')).toEqual(mapped('out_for_delivery'));
    expect(answer('lbc-express', null, 'Picked up by LBC')).toEqual(mapped('accepted'));
    expect(answer('lbc-express', null, 'Delivery update')).toEqual(unknown);
    expect(answer('lbc-express', '9', 'Delivered')).toEqual(unknown);
  });

  it('does not know a scan without wording', () => {
    expect(answer('dpd', 'DLO', '   ')).toEqual(unknown);
  });
});

describe("universal providers' answers", () => {
  const TIME = '2026-01-01T12:00:00Z';

  it('answer by the wording rules the providers apply, as the app files their scans under unknown', () => {
    expect(answer('unknown', null, 'Processed at EXAMPLE CITY - FRANCE')).toEqual(mapped('in_transit'));
    expect(answer('unknown', null, 'Shipment information received')).toEqual(mapped('registered'));
    // USPS's scan before its acceptance, and CTT's acceptance, as ParcelsApp relays them.
    expect(answer('unknown', null, 'Shipment Received, Package Acceptance Pending, ZIP Code 10001')).toEqual(mapped('registered'));
    expect(answer('unknown', null, 'Aceite. O envio foi aceite. O processo de envio foi iniciado.')).toEqual(mapped('accepted'));
    expect(answer('unknown', null, 'Clearance processing complete at EXAMPLE GATEWAY - USA')).toEqual(mapped('in_transit'));
    expect(answer('unknown', null, "  Colis en préparation chez l'expéditeur ")).toEqual(mapped('registered'));
    expect(answer('unknown', null, 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('unknown', null, 'Item prepared for pick-up at the post office.')).toEqual(mapped('ready_for_pickup'));
    expect(answer('unknown', null, 'DEPOSITADO PELO CLIENTE/EXPEDIDOR')).toEqual(mapped('accepted'));
    expect(answer('unknown', null, 'ENCOMENDA RECOLHIDA')).toEqual(mapped('accepted'));
    expect(answer('unknown', null, 'ENTRADA EM ARMAZÉM')).toEqual(mapped('in_transit'));
    expect(answer('unknown', null, 'Die Sendung ist im Zielland/Zielgebiet eingetroffen')).toEqual(mapped('in_transit'));
    // Wording the carriers' own maps now read.
    expect(answer('bpost', null, 'Your parcel was delivered at one of your neighbours. You can find all delivery details in your mailbox.'))
      .toEqual(mapped('delivered'));
    expect(answer('yanwen', null, 'Departure Scan')).toEqual(mapped('in_transit'));
    expect(answer('postnord', 'OTHER', 'A letter notification has been sent to the recipient.'))
      .toMatchObject({ kind: 'intentional_gap', note: expect.stringContaining('keeps the stage of the scan before it') });
    expect(answer('unknown', null, 'Item prepared for pick-up')).not.toEqual(mapped('ready_for_pickup'));
    expect(answer('unknown', null, 'Delivery not successful due to locker not available. The shipment will be delivered on the next business day.'))
      .toEqual(mapped('failed_attempt'));
    // Wording no rule reads, and a delivery still to come, stay open as gaps.
    expect(answer('unknown', null, 'Estado interno 99')).toEqual(unknown);
    expect(answer('unknown', null, 'Will be delivered tomorrow')).toEqual(unknown);
    expect(answer('unknown', null, '   ')).toEqual(unknown);
    // Chronopost's notice to the recipient, relayed as it is, is no scan.
    expect(answer('unknown', null, 'Destinataire informé par SMS ou mail')).toEqual(gap);
    expect(answer('unknown', 'SM', 'Destinataire informé par SMS ou mail')).toEqual(unknown);
    expect(answer('unknown', null, 'Destinataire informé par SMS ou mail. Type du message : Retard Média utilisé : E-mail')).toEqual(gap);
    // Nor is a bare delivery estimate, or a note that the recipient's details changed.
    expect(answer('unknown', null, 'Estimated delivery')).toEqual(gap);
    expect(answer('unknown', null, 'Recipient information updated')).toEqual(gap);
    // Posti's notification tool, as providers relay it beside Posti's scans.
    expect(answer('unknown', null, 'We have not received the recipient’s phone number')).toEqual(gap);
    expect(answer('unknown', null, 'We sent the recipient a letter about the item')).toEqual(gap);
  });

  it("answer by the providers' own reading, not the generic classifier's keyword rules", () => {
    // Posti's repeated handling scan, which the providers read before the shared rules.
    expect(classifyWording('The item has been registered').stage).toBe('registered');
    expect(answer('unknown', null, 'The item has been registered')).toEqual(mapped('in_transit'));
    // The providers leave a bare "Returned" unread, so the sync stores it unstaged.
    expect(classifyWording('Returned').source).toBe('wording:returned');
    expect(answer('unknown', null, 'Returned')).toEqual(unknown);
  });

  it('let a 17TRACK sub-status outrank the wording where the sync does', () => {
    expect(answer('unknown', 'Exception_Cancel', 'Estado interno 99')).toEqual(mapped('exception'));
    expect(answer('unknown', 'Exception_Returned', 'Delivered')).toEqual(mapped('returned'));
    expect(answer('unknown', 'InfoReceived', 'Shipping label created')).toEqual(mapped('registered'));
    expect(answer('unknown', 'InTransit_PickedUp', 'Processed at EXAMPLE HUB')).toEqual(mapped('accepted'));
    // Generic transit yields to any reading of the wording, and a delivery code
    // to wording that does not read as delivered.
    expect(answer('unknown', 'InTransit_Other', 'Arrived at customs')).toEqual(mapped('customs'));
    expect(answer('unknown', 'InTransit_Other', 'Estado interno 99')).toEqual(mapped('in_transit'));
    expect(answer('unknown', 'Delivered_Other', 'Not delivered')).toEqual(mapped('failed_attempt'));
    expect(answer('unknown', 'Delivered_Other', 'Estado interno 99')).toEqual(unknown);
    // Nor does the round's code outrank wording that reads as delivered.
    expect(answer('unknown', 'OutForDelivery_Other', 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('unknown', 'OutForDelivery_Other', 'Estado interno 99')).toEqual(mapped('out_for_delivery'));
    // Any other code, such as a UPU event code the provider does not map, leaves it to the wording.
    expect(answer('unknown', 'EMZ', 'Processed at EXAMPLE HUB')).toEqual(mapped('in_transit'));
    expect(answer('unknown', 'NotFound_Other', 'Estado interno 99')).toEqual(unknown);
  });

  it('give every scan the sync would review the stage the sync stored', () => {
    const wordings = ['Processed at EXAMPLE CITY - FRANCE', 'Shipment information received', 'Arrived at customs',
      'Released from import customs', 'Not delivered', 'Delivered', 'The item has been registered', 'Returned',
      'Will be delivered tomorrow', 'Estado interno 99', 'Parcel on hold at recipient’s request', 'Shipping label created'];
    const codes = [undefined, 'InfoReceived', 'InTransit_Other', 'InTransit_PickedUp', 'OutForDelivery_Other', 'Delivered_Other',
      'Exception_Cancel', 'Exception_Returned', 'NotFound_Other'];
    const scans: CarrierEvent[] = [];
    for (const description of wordings) {
      scans.push(event(TIME, description)!);
      // 17TRACK's own stage label, absent or one the providers do not map, decides whether the scan is reviewed.
      for (const code of codes) for (const stage of [null, 'Synthetic']) {
        scans.push(seventeenTrackEvent({ time_utc: TIME, description, stage, sub_status: code }, {})!);
      }
    }
    // The app reviews every scan whose stage did not come from a map.
    const reviewed = scans.filter(({ stage_source }) => stage_source !== 'carrier_map');
    expect(reviewed.filter(({ provider_code: code }) => code).length).toBeGreaterThan(50);
    for (const scan of reviewed) {
      expect(answer('unknown', scan.provider_code ?? null, scan.description!), JSON.stringify(scan))
        .toEqual(scan.stage === 'pending' ? unknown : mapped(scan.stage!));
    }
  });

  it('close the relayed wording the shared rules read, and keep the rest open', () => {
    expect(answer('unknown', null, 'order details received')).toEqual(mapped('registered'));
    expect(answer('unknown', null, 'shipment is out with courier for delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('unknown', null, 'admitido.. el envío ha tenido admisión en origen.')).toEqual(mapped('accepted'));
    expect(answer('unknown', null, 'i̇ptal edildi')).toEqual(mapped('exception'));
    // MailAmericas' hand-overs on the way to the last mile are no delivery, and its customs release moves the parcel on.
    for (const wording of ['Arrived at destination country. Delivered by Airline', 'Receiving destination mail. Delivered to Distributor',
      'Deliver to distributor', 'Destination customs. Released']) expect(answer('unknown', null, wording), wording).toEqual(mapped('in_transit'));
    // Apple Express's depot receipt as ParcelsApp relays it: the round is still to come.
    expect(answer('unknown', null, 'Parcel Received, Out for Delivery Soon')).toEqual(mapped('in_transit'));
    // Postal Ninja's, ParcelsApp's and Ship24's relayed steps, read whole.
    for (const [wording, stage] of [['registered in the system', 'registered'], ['2) Example Center Your order has been received', 'in_transit'],
      ['USPS in possession of item, EXAMPLE, ST 00000', 'accepted'], ['inventory in a warehouse', 'in_transit'], ['hand over to airline', 'in_transit'],
      ['new delivery, flexible delivery arrangement', 'in_transit'], ['in lavorazione', 'in_transit'], ['uscita centro postale', 'in_transit'],
      ['Your order has been shipped from 2) Example Center', 'in_transit']] as const) expect(answer('unknown', null, wording), wording).toEqual(mapped(stage));
    for (const wording of ["in paack's distribution centre", 'girildi', 'order triggered by recipient: forward']) {
      expect(answer('unknown', null, wording), wording).toEqual(unknown);
    }
    expect(answer('unknown', null, 'Released')).toEqual(gap);
  });

  it("read An Post's relayed sentences as its trace codes stage them", () => {
    for (const [code, wording, stage] of [
      [35, 'We have received information about your incoming item from the sender', 'registered'],
      [15, 'Your item has been handed to An Post', 'accepted'],
      [48, 'We have your item and will process it for delivery', 'accepted'],
      [5, 'Your item is being sent internationally. We will aim to show tracking updates as they become available, or visit the local delivery provider website for updates.', 'in_transit'],
      [40, 'Your item arrived abroad. We will aim to show tracking information from the receiving post, but would recommend tracking the item further on their site', 'in_transit'],
      [73, 'Your item is being prepared for delivery', 'in_transit'],
      [70, 'Your item is now available for collection', 'ready_for_pickup'],
      [13, 'Your item was not collected within the specified timeframe. This item will now be returned to sender.', 'failed_attempt'],
    ] as const) {
      expect(answer('unknown', null, wording), wording).toEqual(mapped(stage));
      expect(answer('an-post', String(code), wording), wording).toEqual(mapped(stage));
    }
    // Only the whole sentence is An Post's.
    expect(answer('unknown', null, 'We have received information about your incoming item')).toEqual(unknown);
  });

  it("read InPost's logistics centre and hand-over for delivery as InPost's own map does when an aggregator relays them", () => {
    expect(answer('unknown', null, 'Accepted at the Logistics Centre')).toEqual(mapped('in_transit'));
    expect(answer('unknown', null, 'Handed over for delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('inpost', null, 'Accepted at the Logistics Centre')).toEqual(mapped('in_transit'));
    // A hand-over to the airline or the recipient's side is still no round.
    expect(answer('unknown', null, 'Handed over to airline')).not.toEqual(mapped('out_for_delivery'));
  });

  it("read Česká pošta's English as its own map does when an aggregator relays it", () => {
    // Its whole-answer notices and the courier's position beside an attempt are not relayed as steps.
    const relayed = ceskaPosta.entries.filter((entry) => entry.language === 'en' && !['-3', '-4', 'QB'].includes(entry.code));
    expect(relayed.length).toBeGreaterThan(10);
    for (const entry of relayed) {
      const expected = 'stage' in entry && entry.stage ? mapped(entry.stage) : expect.objectContaining({ kind: 'intentional_gap' });
      expect(answer('unknown', null, entry.wording), entry.wording).toEqual(expected);
      expect(answer('ceska-posta', entry.code, entry.wording), entry.wording).toEqual(expected);
    }
  });

  it("close the aggregators' whole scans no shared rule reads, and nothing like them", () => {
    for (const [wording, stage] of [
      // Latvijas Pasts' export steps, ECMS's pre-alert and InPost's refusal at the door, as ParcelsApp and Ship24 relay them.
      ['Received at the logistics center', 'in_transit'], ['Item held at outward office of exchange', 'in_transit'], ['Sending the package', 'in_transit'],
      ['Virtual Manifest has been received. 发货预报已收到，正在等待货物到达我们的始发站仓库', 'registered'], ['Virtual Manifest has been received', 'registered'],
      ['Acceptance refusal', 'failed_attempt'],
      // Lietuvos paštas' acceptance, a bare receipt the shared rules leave unread.
      ['Parcel received', 'accepted'],
      ['Warehouse receipt.', 'accepted'], ['Received by warehouse', 'accepted'], ['Package received and scanned at warehouse', 'accepted'],
      ["We've got it", 'accepted'], ['Received at Evri', 'accepted'], ['Received by our network', 'accepted'], ['Checked in at origin hub', 'accepted'], ['Parcel received and processing', 'accepted'], ['Acceptance, Sent To Spain', 'accepted'],
      ['China Post has received the mail', 'accepted'], ['Envío recogido en origen', 'accepted'],
      ['First parcel scan along Poste Italiane’s logistic network', 'accepted'], ['RFID Confirmed Pickup', 'accepted'],
      ['示例处理中心已收寄【示例市】', 'accepted'],
      ['parcel handed', 'accepted'],
      // A forwarder's English copies of a Chinese post's scans, the place in brackets.
      ['Example Processing Center has received it [Example City]', 'accepted'],
      ['parcel leaves processing center [Example]', 'in_transit'], ['The shipment leaves the processing center [Example]', 'in_transit'],
      ['Airline received【Example】', 'in_transit'], ['Airline received', 'in_transit'],
      // Helthjem sending a home delivery on to a pickup point, as Ship24 relays it.
      ['Pakken din behandles for sending til hentested.', 'in_transit'], ['Pakken sorteres på nytt før den sendes til et hentested.', 'in_transit'],
      ['Instruction data transmitted to DPD', 'registered'], ['Order confirmed.', 'registered'], ['Order received successfully', 'registered'],
      ['Package finished', 'registered'], ['Package is ready for shipping from the warehouse', 'registered'],
      ["Your package will be in good hands with Intelcom! Good news! We've received your shipment details, but the package is still with your merchant.", 'registered'],
      ['Your package will be in good hands with Dragonfly!', 'registered'],
      ["Intelcom has your package! Your merchant has handed us your package at our station. We'll make sure to keep you posted as it makes its way to you.", 'accepted'],
      ['Dragonfly has your package!', 'accepted'],
      ['Created. Parcel created by Example Shop at EXA', 'registered'], ['create. Shipment order created', 'registered'],
      ['Pre-Shipment Info Sent To Spain', 'registered'],
      ['The order has information pending customer confirmation.', 'registered'],
      // Ship24's copies carry the feed's category or original wording after the sentence.
      ['Order confirmed., OTHER', 'registered'], ['Warehouse receipt., 仓库收货', 'accepted'], ['仓库收货', 'accepted'],
      ['Export declaration in progress., OTHER', 'customs'], ['Flight delayed., OTHER', 'in_transit'],
      ['Flight delay. The flight scheduled for the 7th is expected to be delayed', 'in_transit'],
      ['Airline delay', 'in_transit'], ['Flight delay', 'in_transit'], ['Parcel shipped', 'in_transit'], ['Customer information manifested', 'registered'],
      ['Pickup requested', 'registered'], ['Booked', 'registered'], ['Waiting for Parcel', 'registered'],
      ['Item inbound scanning', 'in_transit'], ['Item outbound scanning', 'in_transit'],
      ['In FedEx possession - Package received after final location pickup has occurred. Scheduled for pickup next business day', 'accepted'],
      ['In FedEx possession — At FedEx location', 'accepted'],
      ['Shipment under processing at origin hub', 'in_transit'], ['Shipment despatched to transshipment hub', 'in_transit'],
      ['Shipment received at transshipment hub', 'in_transit'], ['Shipment despatched to overseas', 'in_transit'],
      ['Shipment received at delivery branch', 'in_transit'],
      ['Goods leave the operation center', 'in_transit'], ['Package left the warehouse', 'in_transit'], ['Leave the warehouse', 'in_transit'],
      ['Package shipped from the warehouse', 'in_transit'],
      ["We're processing your parcel at our hub", 'in_transit'], ['Warehouse. Inbound warehouse', 'in_transit'],
      ['Warehouse. Delivery in last mile facilities', 'in_transit'], ['Warehouse. Ready to hand over to last-mile supplier', 'in_transit'],
      ['Hand Over To Last Mile', 'in_transit'], ['At destination country/region', 'in_transit'], ['Beladung', 'in_transit'],
      ['Entladung', 'in_transit'], ['Entrance to the terminal from the driver', 'in_transit'],
      ['Shipment Unloaded in Collection Terminal', 'in_transit'], ['Outboud from pickup terminal to the linehoul', 'in_transit'],
      ['Inbound from inehoul to terminal', 'in_transit'],
      ['Example warehouse, Example warehouse processing, order has been outbounded', 'in_transit'],
      ['Example warehouse, Example warehouse processing assembling operation', 'in_transit'],
      ['Received in Site-Example，the pick-up is Example', 'in_transit'], ['Exported', 'in_transit'], ['Plane has landed', 'in_transit'],
      ['Received by airline', 'in_transit'], ['WI – Intermediate warehouse. Container received', 'in_transit'],
      ['WI – Intermediate warehouse. Package received at Intermediate Warehouse', 'in_transit'],
      ['Delivery branch. Received at Distribution Branch', 'in_transit'], ['Receiving destination mail. Received by Distributor', 'in_transit'],
      ['Container reception', 'in_transit'],
      ['Internationaliy Package received at processing center', 'in_transit'], ['Leave the email processing center', 'in_transit'],
      ['Leave the Example City processing center', 'in_transit'],
      ['邮件到达处理中心【示例】', 'in_transit'], ['快件离开处理中心【示例】', 'in_transit'], ['航空公司接收【示例】', 'in_transit'],
      ['已交承运商运输【示例】', 'in_transit'], ['邮件已完成分拣，准备发出【示例】', 'in_transit'], ['出口海关/放行【示例】', 'in_transit'],
      ['启运【示例】', 'in_transit'], ['干线中转', 'in_transit'],
      ['邮件已乘机由Example City, Example Province飞往Sample City', 'in_transit'], ['您的邮件正途经Example City, Example Province', 'in_transit'],
      ['邮件到达Sample City，准备发往【示例航空中心】', 'in_transit'],
      ['预计【01月02日】到达Example City，两地距离1000km，将在【01月02日上午】更新邮件状态，请您放心。', 'in_transit'],
      ['已出库,货物离开操作中心', 'in_transit'], ['已出库', 'in_transit'],
      ['Delivery in progress, second attempt', 'out_for_delivery'],
      ['Site-ExampleScanned for delivery;the courier is Example', 'out_for_delivery'],
      ['交接成功-交出（派送员派送途中）', 'out_for_delivery'],
      ['Delivery branch. In the hands of the mailman', 'out_for_delivery'],
      ['FOR DELIVERY', 'out_for_delivery'],
      ['The shipment has left origin country', 'in_transit'], ['Przesyłka w oddziale FedEx.', 'in_transit'],
      ['Przesyłka wydana do doręczenia kurierowi FedEx.', 'out_for_delivery'],
      ['The shipment is handled by a return consolidator', 'exception'],
      ['Delivery. Your order has been shipped from the distribution center', 'in_transit'],
      // iMile's receipt at a centre in the destination country, and its dispatch from there.
      ['Example center Your order has been received', 'in_transit'], ['Received. Your order has been received', 'in_transit'],
      ['Your order has been shipped from Example center', 'in_transit'], ['Your order has been received', 'registered'],
      ['NUEVO REPARTO. Concertación entrega flexible', 'in_transit'], ['NUEVO REPARTO', 'in_transit'],
      ['Waiting for carrier to collect the order', 'registered'], ['Depositado en punto MRW', 'ready_for_pickup'], ['Pendiente de recoger', 'registered'],
      ['Dirección entrega incompleta', 'exception'],
      ['Order Submited', 'registered'], ['We have received the shipment from the sender', 'accepted'], ['Center Received', 'in_transit'],
      ['Origin port warehouse receive，Flight Schedule ETD MIA <2026-01-13 07:05:00>, ETA BOG <2026-01-13 09:50:00>', 'in_transit'],
      ['The flight has taken off', 'in_transit'], ['Center Parcel shipped to EXAMPLE.DS', 'in_transit'],
      ['EXAMPLE.DS Dispatch task assigned to DA', 'in_transit'], ['<Bad Address>', 'failed_attempt'],
      ['Cause of problem Rescheduled delivery', 'failed_attempt'], ['Cause of problem【Rescheduled delivery】', 'failed_attempt'],
      ['Contact Error need to return', 'exception'], ['Start returning，reason:[Contact Error]', 'exception'],
      ['EXA-DEVOLUCION.DS Order Closed', 'exception'],
      ['Shipment added to loading unit', 'in_transit'], ['Received at hub: in motherbag', 'in_transit'], ['Shipment received', 'in_transit'],
      ['The shipment has been prepared for further shipping in Example', 'in_transit'],
      ['The shipment was prepared for further shipping in Example (Example)', 'in_transit'],
      ['Notice card left indicating where and when to pick up item', 'failed_attempt'],
      ['Delivery has been made at the destination port', 'in_transit'], ['目的港已提货 Delivery has been made at the destination port', 'in_transit'],
      ['目的港已提货', 'in_transit'], ['The shipment was left at a drop-off location', 'delivered'], ['Order information has been sent to DPD.', 'registered'],
      ['Package received & scanned at warehouse', 'accepted'],
      // KTD's steps as ParcelsApp relays them.
      ["Package received and scanned at the carrier's local warehouse.", 'accepted'], ["Package leaves the carrier's local warehouse", 'in_transit'],
      ['Your item has left the East China warehouse', 'in_transit'], ['Export declaration completed', 'in_transit'], ['Take off', 'in_transit'],
      // Correos Express's way to the destination town, as Ship24 words it.
      ['En route to the destination location, Your shipment is now out for delivery to the destination facilities on one of our vehicles. You will receive it on the scheduled delivery date.', 'in_transit'],
      ['En route to the destination location', 'in_transit'],
      // 17FEIA's customs broker, as Ship24 relays it with 17FEIA's label or "OTHER".
      ['Broker picked up Shipment and delivered to warehouse., OTHER', 'customs'],
      ['Broker picked up Shipment and delivered to warehouse., 清关行提货到仓', 'customs'],
      // A customs agent's step, as ParcelsApp relays it after PostNL's pre-advice: the parcel waits for the agent.
      ['customs agent: ready for pickup', 'customs'], ['customs agent: item received in warehouse', 'customs'],
      ['Manifested - Out for Pickup', 'registered'], ['Manifested', 'registered'],
      ['Awaiting your Vinted parcel', 'registered'], ['Expecting Your Parcel', 'registered'],
      ['Parcel received by Relay', 'accepted'], ['Received Your Parcel', 'accepted'], ['Collection Complete', 'delivered'],
      ['Export Scan', 'in_transit'],
      ['Received in warehouse', 'accepted'], ['Item deposited to local postal operator', 'in_transit'],
      ['Item handed over to subcontractor', 'in_transit'], ['Item announced', 'registered'], ['Item sent', 'in_transit'],
      ['Origin Post is Preparing Shipment', 'registered'], ['Item posted abroad', 'accepted'],
      ['Item forwarded to destination country', 'in_transit'], ['Has been given to local carrier', 'in_transit'],
      ['En preparación', 'registered'],
      ['Recogido por el mensajero', 'accepted'], ['Paquete en el destino', 'in_transit'],
      ['Item received in destination country', 'in_transit'],
      ['Item posted / received from customer Customer centre: Example', 'accepted'],
      ['International item mailed in originating country', 'accepted'],
      ['The shipment has been posted by the sender at the retail outlet', 'accepted'], ['Label correction applied', 'in_transit'],
      ['Domestic allocation has begun', 'in_transit'], ['Under domestic allocation', 'in_transit'],
      ['Delivery to local courier', 'in_transit'],
      ['DHL eCommerce currently awaiting shipment and tracking will be updated when received', 'registered'],
      ['Tendered to delivery service provider, allow 1-3 days for updates for packages within the US', 'in_transit'],
      ['Shipment manifest received', 'registered'], ['Parcel received by Maersk', 'in_transit'], ['Package relabeled', 'in_transit'],
      ['Reception in the delegation', 'accepted'], ['OUT IN NATIONAL ROUTE', 'in_transit'],
      ['Item received at exchange office', 'in_transit'], ['Your delivery is in EXAMPLE TOWN, POST OFFICE', 'ready_for_pickup'],
      ['Delivery scheduled during the day.', 'out_for_delivery'], ['USPS in possession of the item, EXAMPLE, NY', 'accepted'],
      ['Order registered', 'registered'], ['Pickup scheduled for 01/02/2026', 'registered'],
      ['Pickup completed, No exceptions', 'accepted'], ['Furniture Received by Metro-<Warehouse>-Hub', 'in_transit'],
      ['Furniture Received by Metro-Example-Hub', 'in_transit'],
      ['The package is in the local warehouse. We will come back with details about the next steps', 'in_transit'],
      ['The package is in the local warehouse. We will come back with details about the delivery', 'in_transit'],
      ['The parcel has been delivered to the pick-up point. A courier will pick it up soon and take it to storage', 'accepted'],
      ['The parcel has been delivered to the pick-up point', 'ready_for_pickup'],
      ['Delivered at DHL ServicePoint', 'ready_for_pickup'], ['Delivered to DHL ServicePoint', 'ready_for_pickup'],
      ['SF Express has received your package, we sincerely protect your expectations, and will not let you down. If you have any questions, please contact courier Example at 10000000000.', 'accepted'],
      ['The shipment has been received at the SEUR facilities of origin', 'accepted'],
      ['Parcel was dropped off at the locker', 'accepted'], ['Parcel was dropped off at the parcel shop', 'accepted'],
      ['International shipment release - Import', 'in_transit'], ['International shipment release - Export', 'in_transit'],
      ['Restricted item - Battery item', 'in_transit'],
      ['Package information is created in the system', 'registered'],
      ['Package Received with Origin Scan warehouse (Exampleton, ON)', 'accepted'],
      ['Package is received at a Straightship station (Exampleton, ON)', 'in_transit'],
      ['Received at Origin Warehouse', 'in_transit'],
      ['In viaggio', 'in_transit'], ['In viaggio verso il centro', 'in_transit'], ['Item has passed a checkpoint', 'in_transit'],
      ['Confirmation of preparation of the shipment received', 'registered'], ['Item deposited to local postal operator', 'in_transit'],
      ['Item posted', 'accepted'], ['Item in transfer - please wait', 'in_transit'],
      ['Item received at the export unit in the country of origin', 'in_transit'],
      ['Item received by the Brazilian Post', 'in_transit'], ["Need to inform recipient's CPF/CNPJ", 'customs'],
      ['Objeto postado', 'accepted'], ['Objeto em transferência - por favor aguarde', 'in_transit'],
      ['Objeto recebido pelos Correios do Brasil', 'in_transit'], ['Necessidade de informar CPF/CNPJ do destinatário', 'customs'],
      ['Received by carrier', 'in_transit'],
      ['Cambio disposizioni di consegna', 'in_transit'],
      // Poste Italiane's intake and delivery round in an aggregator's English.
      ['The shipment was taken care of at the post office', 'accepted'], ['The shipment is on delivery', 'out_for_delivery'],
      ['Shipment expected, but not yet arrived or processed at PostNL', 'registered'],
      ['Parcel linked to packaging tool', 'in_transit'], ['Your parcel has crossed the border', 'in_transit'],
      ['Shipment received from sender', 'accepted'],
      // Posta Shqiptare's Albanian rows relayed with an empty English half, as its own map reads them.
      ['Objekti u pranua ne zyren e shkembimit /', 'in_transit'], ['Regjistrimi i informacionit doganor te objektit /', 'customs'],
    ] as const) expect(answer('unknown', null, wording), wording).toEqual(mapped(stage));
    // Each is matched whole: the same words in another scan, and the report's open wording, stay unread.
    for (const wording of ['Sending the package to the sender', 'Item held at outward office of exchange for inspection', 'Virtual Manifest pending',
      'Parcel received by the recipient']) {
      expect(answer('unknown', null, wording), wording).toEqual(unknown);
    }
    for (const wording of ['Order received from retailer, awaiting stock', 'Warehouse receipt pending', 'Order confirmed., pending',
      'Przesyłka w oddziale', 'Przesyłka w oddziale FedEx czeka na odbiór', 'Your order has been shipped from the distribution center to the store',
      'Concertación entrega flexible', 'Waiting for carrier to collect the order from the warehouse', 'Depositado en punto MRW de origen',
      'Order Closed', 'Center', 'Dispatch task assigned', 'Received at origin warehouse pending', 'Confirmation of preparation', 'Expecting your parcel back', 'Parcel received by relay point',
      'Item posted at the counter', 'Item in transfer', 'Item received by the Brazilian Post at the counter', "Need to inform recipient's address",
      'Ready for delivery', 'Shipment received from retailer', 'Received at hub', 'Shipment despatched to transshipment hub of Example',
      'Delivery has been made at the destination port of Example', '目的港已提货待清关', 'Received by our network partner in Example', 'Checked in at origin hub of Example', 'Parcel shipped to Example', 'The shipment was left at a drop-off location for the courier', 'Order information has been sent',
      'Received. Your order has been received by the store', 'Package finished at the store',
      'Package is ready for shipping from the warehouse to the store', 'Package shipped from the warehouse to Example',
      'Package received at processing center', 'Processing center has received it', 'The shipment leaves the return processing center [Example]', '未出库', '已出库待取件', '未排航班', 'Pendiente de recoger en Example', 'Dirección entrega incompleta y teléfono', 'Leave the return processing center', 'Cause of problem',
      'Rescheduled delivery', 'Parcel handed to the recipient', 'Parcel handed over to the recipient', 'Handed over to your neighbour', 'Pickup completed', 'Pickup scheduled',
      'Order registered by the recipient', 'We will come back with details about the delivery', 'The package is in the local warehouse for collection',
      'Courier collection complete', 'Collection complete from sender',
      'Export scan pending', 'Awaiting export scan', 'Received in warehouse Example', 'Item deposited',
      'Parcel was dropped off at the locker by the courier', 'International shipment release pending', 'Package is received at a station',
      "Package received at the carrier's local warehouse for return", 'Take off the label', 'Export declaration completed for the return',
      // A store receipt that is a drop-off or a collection, and a retailer's order sent to its store.
      'Received at Example Store', 'Your order has been shipped from Example center to the store',
      'The shipment was taken care of at the post office by the sender', 'The shipment is on delivery hold']) {
      expect(answer('unknown', null, wording), wording).toEqual(unknown);
    }
  });

  it("close relayed copies of Nova Poshta's, TNT Italy's, the US Postal Service's, BRT's, nox's, Vinted Go's, MeiHoo Pegasus's, PostNL's, UPS's, ePost Global's, Hermes's, DPD Poland's and a forwarder's scans as their carriers read them", () => {
    for (const [wording, stage] of [['Registered and being prepared', 'registered'], ['Left the branch 12', 'in_transit'],
      ['Collo von der nox Niederlassung weiterverladen. Sendung weiterverladen', 'in_transit'],
      ['Collo is reloaded by the nox branch. Consignment reloaded', 'in_transit'],
      ["La spedizione e' regolarmente partita", 'in_transit'], ['Spedizione affidata a una FedEx Location in attesa di ritiro del corriere', 'accepted'],
      ['Tendered to International Gateway.', 'in_transit'], ['Attempted but unfinished drop off at locker', 'registered'],
      ['Received by partner carrier', 'in_transit'], ['Operation center is processing package information', 'registered'],
      ['Preparing to leave Hong Kong operation center', 'in_transit'], ['The item is ready for shipment', 'registered'],
      ['Consignment received at the PostNL Acceptance Centre', 'accepted'], ['Pre-alerted shipment enriched by PostNL management', 'registered'],
      ['As requested, the UPS My Choice® delivery change was completed.', 'in_transit'], ['The address was changed as the receiver requested.', 'in_transit'],
      ["The company or receiver name is incorrect. This will delay delivery. We're attempting to update this information.", 'exception'],
      ['Shipment in Transit to the ePost Global Processing Center', 'registered'],
      ['The package was dropped off by the sender at the PaketShop Beispielkiosk, Musterstraße 1, 00000 Musterstadt.', 'accepted'],
      ['Acceptance of the package at the delivery branch abroad', 'in_transit'], ['Acceptance of the package at the Pickup point', 'ready_for_pickup'],
      ["Package received & scanned at carrier's domestic warehouse.", 'accepted'], ['THE GOODS ARRIVE AT THE RECEIVING POINT', 'accepted'],
      ['TURMOIL', 'exception']] as const) {
      expect(answer('unknown', null, wording), wording).toEqual(mapped(stage));
    }
    expect(answer('unknown', null, 'Left the branch office of the recipient')).toEqual(unknown);
  });

  it("read Pitney Bowes's Global Shipping Program steps and Interpost's as Pitney Bowes's own map reads them", () => {
    expect(answer('unknown', null, 'Tracking details uploaded')).toEqual(mapped('registered'));
    for (const wording of ['First Dimension Event', 'Second Dimension Event', 'Processing at Shipping Center', 'Parcel Documentation and Labeling',
      'Container Assignment', 'Container Closed', 'Shipped from Global Shipping Center to Destination', 'Ready to ship. FML label requested',
      'Interpost handed item over to postal company']) {
      expect(answer('unknown', null, wording), wording).toEqual(mapped('in_transit'));
    }
  });

  it('leave out notices, detail lines, headings and scans whose wording cannot settle a step, each with its reason', () => {
    expect(universal.gaps.slice(0, 6).map((gap) => gap.wording)).toEqual(['destinataire informé par sms ou mail',
      'destinataire informé par sms ou mail. type du message : retard média utilisé : e-mail', 'estimated delivery',
      'recipient information updated', 'change of delivery address', 'last-mile delivery forecast']);
    expect(answer('unknown', null, 'EN DEMORA - EL ENVÍO HA SUFRIDO UN RETRASO PROVOCANDO UNA POSIBLE DEMORA EN LA ENTREGA.')).toEqual(gap);
    expect(answer('unknown', null, 'Last-mile delivery forecast')).toEqual(gap);
    // A forwarder's stock count, as ParcelsApp relays it after the flight.
    expect(answer('unknown', null, 'Stocktaking delay')).toEqual(gap);
    // An address change as ParcelsApp relays Huahan's; Huahan's own map stages it after the hand-off.
    expect(answer('unknown', null, 'Change of delivery address')).toEqual(gap);
    expect(answer('huahan', null, 'Change of delivery address')).toEqual(mapped('in_transit'));
    expect(answer('unknown', null, 'Forecast of last-mile delivery by carrier')).toEqual(gap);
    // The same notice relayed with Cainiao's code, whatever its words.
    for (const wording of ['Last-mile delivery forecast', 'Carrier update']) expect(answer('unknown', 'LAST_MILE_ASN_NOTIFY', wording), wording).toEqual(gap);
    // Poste Italiane's acceptance as ParcelsApp relays it, without its verb.
    expect(answer('unknown', null, 'From one of our operators')).toEqual(gap);
    // Its "in data", the end of a movement's sentence, as ParcelsApp relays it translated.
    expect(answer('unknown', null, 'On date')).toEqual(gap);
    // Colis Privé's notices as ParcelsApp relays them.
    expect(answer('unknown', null, 'Consignee notified: by email')).toEqual(gap);
    expect(answer('unknown', null, 'Your package will be delivered to another pickup point. You will be informed of the address and hours by email.')).toEqual(gap);
    // DPD Poland's messages to the recipient as ParcelsApp relays them.
    for (const wording of ['Email notification', 'SMS notification']) expect(answer('unknown', null, wording)).toEqual(gap);
    for (const wording of ['Shipment parameters updated', 'Tax ID. Form received', 'Keine weiteren Details erforderlich', 'Filiale / Agentur',
      'Benachrichtigt', 'In progress', 'Delivery cannot be changed', 'PIOS notice', 'Update on your parcel', 'Carrier update', '110', 'Item received', 'Package received', 'Received.', 'Shipped', 'Driver assigned',
      'Parcel is with the driver', 'Not received from retailer', 'Pickup document attached', 'Delivery branch. Rescheduling',
      'Parcel to be taken to a Yodel Store', 'The parcel has reached the ParcelShop', 'Barcode scanning', 'Packaged']) expect(answer('unknown', null, wording), wording).toEqual(gap);
    // Only the whole wording: a receipt that names its receiver, or another number, is not left out.
    for (const wording of ['Item received by Royal Mail']) expect(answer('unknown', null, wording), wording).toEqual(mapped('accepted'));
    // Royal Mail's sender drop-offs, relayed without their carrier.
    for (const wording of ['Sender advised item dropped off at parcel locker', 'Dropped off at Postbox']) expect(answer('unknown', null, wording), wording).toEqual(mapped('accepted'));
    for (const wording of ['111', 'Received at Example Store']) expect(answer('unknown', null, wording), wording).toEqual(unknown);
  });
});

describe('declared status maps', () => {
  const declared = Object.entries<CarrierStatusMap>(STATUS_MAPS);

  it('registers every carrier that declares one', async () => {
    const found: string[] = [];
    for (const carrier of readdirSync(carriers).sort()) {
      if (!readdirSync(path.join(carriers, carrier)).includes('status.ts')) continue;
      const module = await import(path.join(carriers, carrier, 'status.ts')) as { statusMap?: CarrierStatusMap };
      if (module.statusMap) {
        found.push(carrier);
        expect(STATUS_MAPS[carrier], carrier).toBe(module.statusMap);
      }
    }
    expect(found).toEqual(Object.keys(STATUS_MAPS).sort());
  });

  it.each(declared)('%s keys its gaps as the app does, and stages none of them', (_carrier, map) => {
    const keys = map.gaps.map(({ code, wording }) => JSON.stringify([code ?? null, wording ?? null]));
    expect(new Set(keys).size).toBe(keys.length);
    for (const { code, wording, note } of map.gaps) {
      expect(code !== undefined || wording !== undefined).toBe(true);
      expect(code === undefined || (code.length >= 1 && code.length <= 100)).toBe(true);
      if (wording !== undefined) expect(normalizeStatusWording(wording)).toBe(wording);
      expect(note.length >= 1 && note.length <= 500).toBe(true);
      expect(map.stage(code ?? null, wording ?? 'synthetic wording')).toBeUndefined();
    }
  });
});
