import { describe, expect, it } from 'vitest';
import { classifyWording, wordingStage } from './wording.js';
import { trackingLanguageStage } from './language.js';

describe('classifyWording', () => {
  it.each(['Not delivered to sender', 'Will be delivered back to sender', 'May have been delivered to the sender',
    "Wasn't delivered back to shipper", 'To be delivered to the shipper', 'Being delivered back to sender', 'Will not be delivered to sender'])(
    'does not complete sender delivery from %s', wording => {
      expect(trackingLanguageStage(wording)).toBe('exception');
      expect(wordingStage(wording)).toBe('exception');
    },
  );
  it.each(['Returning to sender', 'Return to sender', 'The item will be returned to sender',
    'To be returned to the sender', 'The item is being returned to the sender', 'Return initiated',
    'Will soon be returned to sender', 'Not yet returned to sender', 'Could not be returned to sender',
    'Cannot be returned to sender', 'Will not be returned to sender', "Hasn't been returned to sender",
    'Hasn’t yet been returned to the sender', "Won't be returned to sender", "Wasn't returned to sender",
    'May be returned to sender', 'Should be returned to sender', 'Might have been returned to sender',
    'Will have been returned to sender', 'Could already have been returned to sender'])(
    'keeps %s nonterminal', wording => {
      expect(wordingStage(wording)).toBe('exception');
    },
  );

  it('never reads a pickup that did not happen, or is still to come, as the acceptance', () => {
    for (const wording of ['Not picked up', 'Parcel not picked up by the recipient', "Parcel wasn't picked up",
      'The recipient has not picked up the shipment from the retail outlet within the seven-day storage period',
      'Consignment has not been picked up', 'Shipment(s) not picked up due to backlog, pickup order cancelled', 'Item not collected',
      'Uncollected parcel', 'Die Sendung wurde nicht abgeholt', "Le colis n'a pas été retiré", 'Il pacco non è stato ritirato',
      'No se ha recogido el envío']) expect(trackingLanguageStage(wording), wording).toBe('exception');
    // One yet to be made waits for whoever the scan names.
    for (const wording of ['Shipment not yet picked up by the courier', 'Label created, not yet picked up',
      'Not yet picked up by the last-mile carrier']) expect(trackingLanguageStage(wording), wording).toBe('registered');
    expect(trackingLanguageStage('Parcel not yet collected by the recipient')).toBe('ready_for_pickup');
    for (const wording of ['If not picked up within 7 days the parcel returns', 'Shipment will be picked up as scheduled', 'To be picked up by courier']) {
      expect(trackingLanguageStage(wording), wording).toBeUndefined();
    }
    for (const wording of ['Picked up', 'Shipment has been picked up by the courier']) expect(trackingLanguageStage(wording), wording).toBe('accepted');
    // One the recipient can make now is the parcel waiting for them, unless the courier is to make it.
    expect(trackingLanguageStage('Item can be picked up at the Post Office')).toBe('ready_for_pickup');
    expect(trackingLanguageStage('Parcel can be collected by the courier')).toBeUndefined();
  });

  it.each(["Il va être retourné à l'expéditeur", "Retour à l'expéditeur en cours", "Votre colis est en cours de retour vers l'expéditeur",
    "Le colis sera livré à son expéditeur", 'Die Sendung wird an den Absender zurückgesendet', 'Die Sendung ist auf dem Rückweg zum Absender',
    'Sendung wird retourniert', 'Il pacco sarà restituito al mittente', 'In restituzione al mittente',
    'Het pakket wordt teruggestuurd naar de afzender', 'Przesyłka zostanie zwrócona do nadawcy', 'Zwrot do nadawcy',
    'Devolver a origen', 'Will be returned to the shipper', 'Your parcel will be returned to its origin', 'Return in progress',
    "Retour à l'expéditeur", 'Retour expéditeur', 'Zurück an Absender', 'Rücksendung an den Absender', 'Ritorno al mittente',
    'Retour afzender', 'Terug naar de afzender', 'Retorno al remitente'])(
    'keeps a return under way nonterminal in any language: %s', wording => {
      expect(classifyWording(wording)).toEqual({ stage: 'exception', source: 'wording:language' });
    },
  );

  it.each(["Votre colis est livré à son expéditeur à la suite d'un retour.", "Le colis est livré à l'expéditeur",
    "Colis en retour, livré à l'expéditeur", 'Paket wurde an den Absender zugestellt', 'Die Sendung wurde dem Absender zugestellt',
    'Il pacco è stato consegnato al mittente', 'Het pakket is afgeleverd bij de afzender', 'Teruggestuurd naar afzender',
    'Przesyłka doręczona do nadawcy', 'Przesyłka zwrócona do nadawcy', 'The return was handed over to the sender',
    "Retour à l'expéditeur effectué", "Retour à l'expéditeur, livré à l'expéditeur", 'Rücksendung an Absender zugestellt',
    'Sendung an den Absender zurückgesendet', 'Zwrócono do nadawcy'])(
    'reads a parcel delivered back to its sender as returned, not delivered: %s', wording => {
      expect(classifyWording(wording)).toEqual({ stage: 'returned', source: 'wording:language' });
    },
  );

  it('still reads deliveries to come to the recipient as forecasts', () => {
    expect(wordingStage('Die Sendung wird morgen zugestellt')).toBe('in_transit');
    expect(wordingStage('Uw pakket wordt vandaag bezorgd')).toBe('in_transit');
    expect(wordingStage('Die Sendung konnte nicht zugestellt werden und wurde an den Absender zurückgeschickt')).toBe('returned');
  });

  it.each(['Returned to sender', 'Has been returned to the sender', 'Delivered back to sender',
    'Delivered to the shipper', 'Has been delivered back to the sender',
    'Has already been returned to sender', 'The item was not delivered and has been returned to sender',
    'Not delivered to recipient; delivered back to sender'])(
    'recognizes completed sender delivery: %s', wording => {
      expect(wordingStage(wording)).toBe('returned');
    },
  );

  it('names the rule that decided the stage', () => {
    expect(classifyWording('Delivery attempt failed')).toEqual({ stage: 'failed_attempt', source: 'wording:language' });
    expect(classifyWording('Confirmation of receipt')).toEqual({ stage: 'delivered', source: 'wording:delivered' });
    expect(classifyWording('Parcel is out for delivery')).toEqual({ stage: 'out_for_delivery', source: 'wording:language' });
    expect(classifyWording('Reported')).toEqual({ stage: 'registered', source: 'wording:language' });
  });

  it('classifies carrier-reported problems as exception', () => {
    expect(classifyWording('Colis endommagé')).toEqual({ stage: 'exception', source: 'wording:language' });
    expect(classifyWording('Package refused by the recipient')).toEqual({ stage: 'exception', source: 'wording:language' });
    expect(classifyWording('Indirizzo errato')).toEqual({ stage: 'exception', source: 'wording:language' });
    expect(classifyWording('Carrier exception')).toEqual({ stage: 'exception', source: 'wording:exception_incident' });
    expect(classifyWording('Updated delivery address required from customer')).toEqual({ stage: 'exception', source: 'wording:language' });
    expect(wordingStage('Przesyłka zatrzymana')).toBe('exception');
  });

  it('keeps missed delivery attempts and returns out of exception', () => {
    expect(wordingStage('Delivery attempt, recipient absent')).toBe('failed_attempt');
    expect(wordingStage('Non livré, destinataire absent')).toBe('failed_attempt');
    // Like "Return to sender", the bare noun says where the parcel goes, not that it got there:
    // the return is under way until a scan says it reached the sender.
    expect(wordingStage('Retour à l\'expéditeur')).toBe('exception');
    expect(wordingStage('Retourné à l\'expéditeur')).toBe('returned');
  });

  it('reads missed rounds worded around the attempt, the absent recipient or a closed business', () => {
    for (const wording of [
      "We've attempted to deliver the shipment, but the customer was not available at the time. Not to worry, the delivery has been rescheduled",
      "We've attempted to deliver the shipment, but the customer was not available at the time. Not to worry, the delivery will be re-attempted",
      'Attempted delivery - receiver unavailable',
      'Absence. Attempted delivery.',
      '<User not at home>',
      'Unsuccessful delivery. Reason : Absence of addressee Result :',
      // Poste Italiane's failed round, which names the day the next one starts from.
      'Non è stato possibile effettuare la consegna. La spedizione sarà in consegna il primo giorno lavorativo utile a partire dal 2026-01-01 00:00',
      // Poste Italiane's locker failure as a universal provider relays it in English.
      'Delivery not successful due to locker not available. The shipment will be delivered on the next business day.',
      "We're sorry but we were unable to complete your delivery. Please continue to check your tracking for real time updates",
      'The driver tried to deliver the package, but the business was closed. We will reattempt up to 3 times. Contact us with any access or delivery instructions',
      'Business closed. Please provide hours',
      // The card a missed round leaves, as YunExpress relays Australia Post's scan.
      '1 item has been transferred to 0000 (example) card left', 'Card left - item held at post office', 'Carded',
      // Indian couriers' hyphenated or spaced "undelivered" is no delivery.
      'Un-Delivered', 'Un Delivered', 'Undelivered',
      // DHL's failed round as a universal provider relays it in English.
      'Delivery not possible. Pickup information will follow by mail', 'Delivery not possible. Forwarding in postal retail outlet',
      'Delivery was not possible', 'Delivery impossible',
      // Cainiao's last mile when the pickup point would not take the parcel in (closed).
      'Delivered to PUDO Failure', 'Your shipment has been failed to be delivered to the parcelshop [parcelshop closed]',
    ]) expect(classifyWording(wording)).toEqual({ stage: 'failed_attempt', source: 'wording:language' });
    // A scheduled attempt, a sender pickup attempt or a hypothetical absence is not a missed round.
    for (const wording of [
      'Attempted delivery tomorrow', 'Attempted delivery scheduled for tomorrow', 'Delivery will be attempted tomorrow',
      'Pickup attempted', 'Pickup attempted - business closed', 'Attempted pickup, customer not available',
      'Pickup attempted - card left', 'Parcel discarded',
      'If you are not at home, the courier will leave the parcel with a neighbour',
      'If the recipient is not available, the parcel goes to the nearest pickup point',
    ]) expect(wordingStage(wording, 'pending')).not.toBe('failed_attempt');
  });

  it('reads the postal and aggregator labels of first scans, the round and delivery', () => {
    for (const [wording, stage] of [
      ['Posting/Collection', 'accepted'],
      ['Posted', 'accepted'],
      ['Origin Scan', 'accepted'],
      ['The shipment has been received at our Aramex origin office and will continue its journey to the destination country', 'accepted'],
      ['The shipment item has been dropped off after latest drop-off time.', 'accepted'],
      ['Item created', 'registered'],
      ['Item out for physical delivery', 'out_for_delivery'],
      ['Final delivery', 'delivered'],
    ] as const) expect(classifyWording(wording)).toEqual({ stage, source: 'wording:language' });
    for (const wording of ['Final delivery attempt tomorrow', 'Posted to the wrong address']) {
      expect(wordingStage(wording, 'pending')).not.toBe('delivered');
      expect(wordingStage(wording, 'pending')).not.toBe('accepted');
    }
  });

  it('tells a courier on the round from a notice that only mentions the round', () => {
    expect(classifyWording("An Aramex Delivery Champion has the shipment and is expected to reach the customer's doorstep shortly"))
      .toEqual({ stage: 'out_for_delivery', source: 'wording:language' });
    // New instructions with the round still to come, like "Delivery option requested".
    expect(wordingStage('The customer has shared new delivery instructions and the status will be updated once shipment is out for delivery'))
      .toBe('in_transit');
    // A depot's receipt with the round still to come, as Apple Express words it.
    expect(wordingStage('Parcel Received, Out for Delivery Soon')).toBe('in_transit');
  });

  it('keeps sender pre-advice and labels the carrier has not received at registered', () => {
    for (const wording of [
      'We have received a notification from your shipper that they are preparing an item for you. The tracking information will be updated when the parcel is handed over to PostNord.',
      'Shipper generated a new shipment label, but the shipment has not been handed over to Aramex, yet. Shipment will be updated once collected from shipper and received in Aramex offices',
      'The package data was sent to OnTrac, but we have yet to receive the package from the sender. Tracking will update once it arrives. Please contact the sender for more information',
      // Lietuvos paštas' label, as aggregators relay it for a parcel filed under no carrier.
      'The label for the parcel has been created',
      // PostNL's pre-alert, as aggregators relay it.
      'Pre-alerted shipment enriched by PostNL management', 'Shipment pre-alerted',
    ]) expect(classifyWording(wording, 'pending')).toEqual({ stage: 'registered', source: 'wording:language' });
    // The carrier itself taking the parcel is still acceptance.
    expect(wordingStage('The parcel was handed over to GLS.')).toBe('accepted');
    // A handover that has not happened is not, with or without "yet".
    for (const wording of ['The parcel has not been handed over to GLS.', "The parcel hasn't been handed over to DPD",
      'Shipment not handed over to the carrier']) {
      expect(classifyWording(wording), wording).toEqual({ stage: 'registered', source: 'wording:language' });
    }
    // Nor is a parcel not handed to the recipient's side or to customs still with its sender.
    for (const wording of ['The parcel was not handed over to the recipient', 'Parcel was not handed over to a neighbour',
      'Parcel has not been handed over to customs', 'The parcel was not handed to you', 'Parcel not handed to the person named']) {
      expect(wordingStage(wording), wording).not.toBe('registered');
    }
  });

  it('reads a handover that has not happened as registered in French, German and Italian too', () => {
    for (const wording of [
      "Le colis n'a pas encore été remis à GLS.", "Le colis n'a pas été remis au transporteur",
      'Colis pas encore confié au transporteur', "Le colis n'a jamais été remis à l'opérateur",
      'Das Paket wurde noch nicht an GLS übergeben.', 'Die Sendung ist noch nicht an den Paketdienst übergeben worden',
      'Paket noch nicht an DPD übergeben', 'Il pacco non è ancora stato affidato a GLS.',
      'Spedizione non affidata al corriere', "Pacco non ancora affidato all'operatore",
    ]) expect(classifyWording(wording), wording).toEqual({ stage: 'registered', source: 'wording:language' });
    // The handover made keeps its reading.
    for (const [wording, stage] of [
      ['Le colis a été remis à GLS.', 'accepted'], ['Le colis a été remis au transporteur', 'in_transit'],
      ['Il a été remis au transporteur pour son acheminement.', 'in_transit'],
      ['Das Paket wurde an GLS übergeben.', 'accepted'], ['Il pacco è stato affidato a GLS.', 'accepted'],
    ] as const) expect(wordingStage(wording), wording).toBe(stage);
    // So does what else the scan reports.
    expect(wordingStage('Im Paketzentrum angekommen; noch nicht an den Zusteller übergeben')).toBe('in_transit');
    // Only a handover to a carrier or an operator that has not happened: not one that
    // cannot or will not happen, nor one to the recipient's side, a place, the sender or
    // customs, nor an idiom. Each keeps the reading it had.
    for (const [wording, stage] of [
      ['Die Sendung konnte nicht an der Haustür übergeben werden', 'pending'],
      ['Das Paket wird nicht an Feiertagen übergeben', 'pending'],
      ['Le colis ne peut pas être remis au point relais', 'pending'],
      ["Le suivi n'a pas été remis à jour", 'pending'],
      ['Le colis ne sera pas remis au transporteur', 'in_transit'],
      ['Retour : colis pas remis au point relais', 'returned'],
      ['Il pacco non è stato affidato al corriere: mancata consegna', 'failed_attempt'],
      ["Le colis n'a pas encore été remis au destinataire", 'pending'],
      ["Le colis n'a pas été remis à la douane", 'customs'],
      // A return not back with the sender yet reads like English "not yet returned to sender".
      ["Le colis n'a pas encore été remis à l'expéditeur", 'exception'],
      ['Das Paket wurde noch nicht an den Empfänger übergeben', 'pending'],
      ['Das Paket wurde nicht an die Packstation übergeben', 'pending'],
      ['Das Paket wurde nicht an den Zoll übergeben', 'customs'],
      ['Il pacco non è ancora stato affidato al destinatario', 'pending'],
      ["Il pacco non è stato affidato all'indirizzo indicato", 'pending'],
      ['Il pacco non è stato affidato alla dogana', 'customs'],
      // A carrier's shop, locker or pickup point is a place too, named by brand or not.
      ['Das Paket wurde noch nicht an die DHL Packstation übergeben', 'pending'],
      ['Paket noch nicht an DHL-Packstation übergeben', 'pending'],
      ['Das Paket wurde noch nicht an den GLS PaketShop übergeben', 'pending'],
      ['Das Paket wurde noch nicht an den Hermes PaketShop übergeben', 'pending'],
      ['Das Paket wurde noch nicht an den DPD Pickup Paketshop übergeben', 'pending'],
      ['Das Paket wurde noch nicht an den UPS Access Point übergeben', 'pending'],
      ['Das Paket wurde noch nicht an die Post Filiale übergeben', 'pending'],
      ["Le colis n'a pas encore été remis au Chronopost Pickup", 'pending'],
      ["Le colis n'a pas encore été remis à UPS Access Point", 'pending'],
      ["Le colis n'a pas encore été remis à la poste restante", 'pending'],
      ['Il pacco non è ancora stato affidato al BRT-fermopoint', 'pending'],
      ['Il pacco non è ancora stato affidato a InPost locker', 'pending'],
      ['Parcel not yet handed to the DHL Packstation', 'pending'],
    ] as const) expect(wordingStage(wording, 'pending'), wording).toBe(stage);
    // The carrier named on its own, or its post, still is one.
    for (const wording of ["Le colis n'a pas encore été remis à la Poste", "Le colis n'a pas encore été remis aux transporteurs",
      'Il pacco non è ancora stato affidato alle Poste', 'Das Paket ist noch nicht an die Deutsche Post übergeben worden']) {
      expect(classifyWording(wording), wording).toEqual({ stage: 'registered', source: 'wording:language' });
    }
  });

  it('reads a hold the recipient asked for as a delivery choice, not a problem', () => {
    for (const wording of [
      "Item on hold at recipient's request", 'Held at customer request', 'On hold per recipient’s request',
      'Shipment held at the request of the consignee', 'Customer requested hold',
      'Article retenu à la demande du destinataire', 'Sendung auf Wunsch des Empfängers zurückgehalten',
      'Spedizione trattenuta su richiesta del destinatario', 'Retenido a petición del destinatario',
      'Retido a pedido do destinatário', 'Przesyłka zatrzymana na prośbę odbiorcy',
    ]) expect(classifyWording(wording, 'pending'), wording).toEqual({ stage: 'in_transit', source: 'wording:language' });
    // Held at a counter for the recipient to collect.
    expect(wordingStage('Held at Post Office, At Customer Request')).toBe('ready_for_pickup');
    // Ready for the customs agent, as DealerSend words it, is customs at work.
    expect(wordingStage('Customs Agent: Ready For Pickup')).toBe('customs');
    expect(wordingStage('Fermo in ufficio postale su richiesta del destinatario')).toBe('ready_for_pickup');
    // A hold nobody asked for, or a missed attempt, keeps its own stage.
    for (const wording of ['Shipment on hold', 'Shipment held, awaiting instructions', 'Colis retenu', 'Sendung zurückgehalten']) {
      expect(wordingStage(wording), wording).toBe('exception');
    }
    expect(wordingStage("Delivery attempt failed; parcel on hold at recipient's request")).toBe('failed_attempt');
  });

  it('keeps postal storage wording (a parcel waiting for collection) out of exception', () => {
    expect(wordingStage('In giacenza presso l\'ufficio postale')).not.toBe('exception');
    expect(wordingStage('Colis en souffrance au bureau de poste')).not.toBe('exception');
  });

  it('recognizes a parcel waiting at a pickup point in the wording carriers actually use', () => {
    for (const wording of [
      'Votre colis vous attend dans votre point de retrait. Le délai de retrait est de 5 jours.',
      'Colis mis à disposition au point de retrait',
      'Le message de mise à disposition en point relais a été reçu par le destinataire.',
      '5 jours restants pour retirer le colis en Locker',
      'Delivered to an access point location and awaiting customer pickup.',
      // A pick-up/drop-off point (PUDO) signing for the parcel, in Cainiao's last mile.
      'Delivered to PUDO',
    ]) expect(classifyWording(wording)).toEqual({ stage: 'ready_for_pickup', source: 'wording:language' });
    // An order ready for the courier to collect from its sender is a registration.
    expect(classifyWording('Order information has been received and ready for pickup')).toEqual({ stage: 'registered', source: 'wording:language' });
    // Travelling to the pickup point, or handed back to the seller, is not availability.
    expect(wordingStage('Colis en cours de livraison au point de retrait')).toBe('in_transit');
    expect(wordingStage('Colis mis à disposition du vendeur suite à un retour')).toBe('returned');
    // A carrier collecting the parcel is no pickup by the recipient, as DHLink words the hand-over after clearance.
    expect(wordingStage('Awaiting pickup by local carrier')).not.toBe('ready_for_pickup');
    expect(wordingStage('Customs import clearance completed, awaiting pickup by local carrier')).toBe('in_transit');
  });

  it('reads French missed attempts, same-day delivery notices and mailbox deliveries', () => {
    expect(wordingStage('Nous sommes passés mais nous n\'avons pu vous remettre votre colis. Il va être acheminé vers votre point de retrait.')).toBe('failed_attempt');
    expect(wordingStage('Votre envoi n\'a pas pu être distribué ce jour.')).toBe('failed_attempt');
    // A day's delivery called off, worded as the next round to come.
    expect(wordingStage('Votre colis ne peut être livré ce jour. Il sera mis en livraison au plus tôt.')).toBe('failed_attempt');
    expect(wordingStage('Il sera mis en livraison au plus tôt.')).toBe('in_transit');
    expect(wordingStage("Echec de livraison suite à l'absence du destinataire.")).toBe('failed_attempt');
    expect(wordingStage("Avis de passage suite à l'absence du destinataire")).toBe('failed_attempt');
    expect(wordingStage("En cas d'absence du destinataire, le colis sera déposé en point relais")).not.toBe('failed_attempt');
    expect(wordingStage('Livraison reportée de 24h')).toBe('in_transit');
    expect(wordingStage('Le destinataire est informé par SMS de la livraison de son colis ce jour')).toBe('out_for_delivery');
    expect(wordingStage('Le destinataire est informé par e-mail de la livraison de son colis ce jour')).toBe('out_for_delivery');
    expect(wordingStage('Votre envoi a été distribué dans la boîte à lettres.')).toBe('delivered');
    // An announced distribution is not a delivery.
    expect(wordingStage('Votre envoi sera distribué dans la journée.')).toBe('in_transit');
    expect(wordingStage('Votre colis va être distribué à votre adresse.')).toBe('in_transit');
    expect(wordingStage('Instruction de livraison reçue')).toBe('in_transit');
    expect(wordingStage('Colis expédié depuis le site logistique')).toBe('in_transit');
  });

  it('separates customs formalities in progress from their completion', () => {
    expect(wordingStage('Les formalités import/export sont en cours sur votre colis.')).toBe('customs');
    expect(wordingStage('Les formalités import/export de votre colis sont terminées et il poursuit son acheminement.')).toBe('in_transit');
    expect(wordingStage('Import customs clearance started')).toBe('customs');
    for (const wording of ['Import customs clearance complete', 'Export clearance success', 'Leaving customs', 'Departed from customs',
      'Customs Import cleared', 'B2C Clearance 4. Customs Import cleared']) {
      expect(wordingStage(wording)).toBe('in_transit');
    }
  });

  it('reads verb-first clearance as completed and keeps negated or pending clearance in customs', () => {
    for (const wording of [
      'Your parcel cleared customs successfully', 'Cleared customs', 'Shipment cleared by customs',
      'The parcel has been cleared through customs', 'Shipment completed the customs clearance process at destination',
      'Shipment completed customs clearance process.', 'The parcel has finished import customs clearance',
    ]) {
      expect(classifyWording(wording)).toEqual({ stage: 'in_transit', source: 'wording:language' });
    }
    for (const wording of [
      'The parcel has not cleared customs yet', 'Parcel has not yet been cleared through customs',
      "Shipment hasn't cleared customs", 'Your parcel will be cleared through customs',
      'Parcel is being cleared by customs', 'Shipment started the customs clearance process at destination',
      'The parcel has not completed customs clearance', "Shipment hasn't completed the customs clearance process",
      'The parcel moves on once it has completed customs clearance', 'Shipment is yet to complete customs clearance',
    ]) {
      expect(wordingStage(wording)).toBe('customs');
    }
  });

  it('distinguishes release from import or export customs from pending release', () => {
    for (const customs of ['customs', 'import customs', 'export customs', 'import/export customs']) {
      expect(wordingStage(`Released from ${customs}`)).toBe('in_transit');
      expect(wordingStage(`Item has been released from ${customs}`)).toBe('in_transit');
      for (const prefix of ['Item has not been', 'Item has not yet been', "Item hasn't been", 'Item will be', 'Item is being']) {
        expect(wordingStage(`${prefix} released from ${customs}`)).toBe('customs');
      }
    }
  });

  it('reads a release from a country, not from a place or a hold, as the journey', () => {
    for (const wording of ['Released from Russia', 'Released from United Kingdom']) expect(trackingLanguageStage(wording), wording).toBe('in_transit');
    for (const wording of ['Released from hold', 'Released from the warehouse', 'Released from storage', 'Released from post office',
      'Released from sender']) expect(trackingLanguageStage(wording), wording).toBeUndefined();
  });

  it('reads a customs hold as customs and a customs problem as an exception', () => {
    for (const wording of [
      'Held by customs', 'Held by Custom', 'Shipment held at customs', 'Parcel on hold at customs', 'Customs hold',
      'Detained by customs', 'Colis retenu en douane', 'Vom Zoll zurückgehalten', 'Fermo in dogana', 'Retenido en aduana',
      'Retido na alfândega', 'Przesyłka zatrzymana przez urząd celny',
      // UPS's customs broker, which it calls the clearing agency.
      'The package is at the clearing agency awaiting final release.', 'Your package is being held by the clearing agency.',
    ]) expect(classifyWording(wording, 'pending'), wording).toEqual({ stage: 'customs', source: 'wording:language' });
    for (const wording of ['Customs issue', 'Customs problem, documents missing', 'Problème de douane', 'Zollproblem',
      'Problema doganale', 'Problema de aduana', 'Problem celny', 'Shipment on hold']) {
      expect(classifyWording(wording, 'pending'), wording).toEqual({ stage: 'exception', source: 'wording:language' });
    }
    expect(wordingStage('Customs hold lifted')).toBe('in_transit');
    expect(wordingStage('Held by customs, delivery attempt failed')).toBe('failed_attempt');
  });

  it('reads import charges the recipient still owes as customs', () => {
    for (const wording of [
      // UPS's OQ activity, as universal providers relay it, and cut short.
      'Your package is being held until duties and taxes are paid. Awaiting customer action.',
      'Your package is being held until duties and taxes are paid. Awaiting customer ac',
      'Awaiting payment of duties and taxes', 'Import duties are due', 'Shipment on hold pending customs charges',
      'Duty payment required',
    ]) expect(classifyWording(wording, 'pending'), wording).toEqual({ stage: 'customs', source: 'wording:language' });
    expect(wordingStage('Held at the counter, duties paid')).not.toBe('customs');
    expect(wordingStage('Duties and taxes paid, out for delivery')).toBe('out_for_delivery');
  });

  it('reads a completed release or clearance as transit in each language', () => {
    for (const wording of [
      'Released From Import Customs', 'Shipment released from customs', 'Cleared by the broker and released at customs',
      'Customs clearance finished', 'Customs clearance processing complete', 'Parcel has cleared export customs',
      'Left the customs terminal', 'Item returned from import customs', 'Released from customs hold',
      // A heading and its line, as MailAmericas words its release and providers relay it.
      'Destination customs: Released', 'Destination customs. Released',
      // China Post's release label in English, as forwarders and providers relay it.
      'Export customs release', 'Export customs/release [Example City]',
      'The package was released by the clearing agency.',
      'Problème douanier résolu, colis en cours d’acheminement', 'Colis dédouané', 'Dédouanement effectué', 'Sorti de la douane',
      'Verzollung abgeschlossen', 'Sendung verzollt', 'Zollfreigabe erfolgt', 'Die Sendung hat den Zoll verlassen',
      'Spedizione sdoganata', 'Sdoganamento effettuato', 'Svincolo avvenuto', 'Uscito dalla dogana',
      'Liberado por aduana', 'Salida de aduana', 'Trámites de aduana finalizados',
      'Liberado pela alfândega', 'Desalfandegado', 'Fiscalização aduaneira finalizada',
      'Odprawa celna zakończona', 'Przesyłka odprawiona celnie',
    ]) expect(classifyWording(wording, 'pending'), wording).toEqual({ stage: 'in_transit', source: 'wording:language' });
    // Holds, inspections, submissions and a release still to come stay with customs.
    for (const wording of [
      'Not yet released by import customs', 'Your parcel will be released from customs after payment',
      'Once released from customs, your parcel will be forwarded', 'Customs clearance will be completed soon',
      'Customs clearance in progress, documents completed', 'The shipment item is being customs cleared by us.',
      'Awaiting release from customs', 'Released to customs broker', 'Held for export customs inspection', 'Submitted to customs',
      'Destination customs: Released to customs broker',
      "Le colis n'a pas encore été dédouané", "Colis en attente d'être dédouané", 'Die Sendung wird verzollt', 'Noch nicht verzollt',
      'Non ancora sdoganato', 'In attesa di essere sdoganato', 'Pendiente de liberación por aduana', 'No ha sido liberado por aduana',
      'Envío en aduana', 'Não foi liberado pela alfândega', 'Encaminhado para fiscalização aduaneira',
      'Przesyłka oczekuje na odprawę celną', 'Nie została odprawiona celnie',
    ]) expect(classifyWording(wording, 'pending'), wording).toEqual({ stage: 'customs', source: 'wording:language' });
  });

  it('maps sender drop-off and carrier pickup scans to accepted', () => {
    for (const wording of [
      'Drop-Off', 'Pickup Scan', 'Pick-up scan', 'Shipment pickup', 'Salesperson collects the package.',
      'The UPS Access Point™ location has prepared the package for return to UPS or pickup by UPS.',
      'Die Sendung wurde vom Absender im PaketShop Beispielkiosk, Musterstraße 1, Musterstadt abgegeben.',
      'Die Sendung wurde vom Absender im Hermes PaketShop abgegeben',
      'The package was dropped off by the sender at the PaketShop Example Kiosk, Example Street 1, 01234 Exampletown',
      'The parcel has been dropped off by the sender at the Hermes ParcelShop.',
    ]) expect(classifyWording(wording, 'pending')).toEqual({ stage: 'accepted', source: 'wording:language' });
    // Recipient-side pickup wording must not be read as the carrier accepting the parcel.
    expect(wordingStage('Ready for pickup')).toBe('ready_for_pickup');
    expect(wordingStage('Drop-off point closed, delivery attempt failed')).toBe('failed_attempt');
    // Only the bare scan label is the sender's hand-in; a parcel left at the recipient's pickup shop is not.
    expect(wordingStage('Your parcel has been dropped off at your chosen pickup shop')).not.toBe('accepted');
    // Nor is a parcel the courier left at a shop for the recipient, or a drop-off still to come.
    expect(wordingStage('Die Sendung wurde im PaketShop abgegeben')).not.toBe('accepted');
    expect(wordingStage('Die Sendung wurde vom Absender im PaketShop noch nicht abgegeben')).not.toBe('accepted');
    expect(wordingStage('The package was dropped off by the driver at the PaketShop Example Kiosk')).not.toBe('accepted');
  });

  it('maps facility scans, handovers and notices that carry no milestone of their own', () => {
    for (const wording of [
      'At local carrier facility', 'Left origin facility', 'Parcel is leaving airport', 'Item Dispatched', 'Delay',
      'Received by local delivery company', 'Received by logistics company', 'Delivery option requested', 'Cambio disposizioni di consegna',
      'The parcel is at the distribution center', 'Your package is now at the distribution centre',
      'The notification for delivery has been sent to the recipient',
      'Item handed over to delivery partner', 'Item distributed', 'The shipment item has been loaded.',
      'Your package has been loaded onto a vehicle',
      'The latest feedback from abroad is expected to arrange truck transfer to the destination port of Example on October 13th',
    ]) expect(classifyWording(wording)).toEqual({ stage: 'in_transit', source: 'wording:language' });
    expect(wordingStage('On vehicle for delivery')).toBe('out_for_delivery');
    expect(wordingStage('On FedEx vehicle for delivery')).toBe('out_for_delivery');
    // Australia Post's wording, which providers relay for parcels filed under no carrier.
    expect(classifyWording('Onboard for delivery', 'pending')).toEqual({ stage: 'out_for_delivery', source: 'wording:language' });
    expect(wordingStage('On board for delivery')).toBe('out_for_delivery');
    expect(wordingStage('Loaded onto the delivery vehicle')).toBe('out_for_delivery');
    expect(wordingStage('Delivery successful.')).toBe('delivered');
    expect(wordingStage('Delivery complete. Recipient : () Result : Delivery complete')).toBe('delivered');
    expect(wordingStage('Delivery completion expected tomorrow', 'pending')).not.toBe('delivered');
    expect(wordingStage('Parcel Data Received')).toBe('registered');
    expect(wordingStage('Shipment information sent to FedEx')).toBe('registered');
    // A parcel left with the recipient is a delivery, not a departure.
    expect(wordingStage('Delivered, left at front door')).toBe('delivered');
  });

  it('reads the Spanish and Portuguese labels carriers send', () => {
    // Labels from the carrier vocabularies (statuses.json) and TIPSA's history on ParcelsApp.
    for (const [wording, stage] of [
      ['ENTREGADO', 'delivered'],
      ['EL ENVÍO HA SIDO ENTREGADO A UN VECINO.', 'delivered'],
      ['Entregue', 'delivered'],
      ['Objeto entregue ao destinatário', 'delivered'],
      ['REPARTO', 'out_for_delivery'],
      ['EL ENVÍO ESTÁ EN REPARTO.', 'out_for_delivery'],
      ['En proceso de entrega a domicilio', 'out_for_delivery'],
      ['Objeto saiu para entrega ao destinatário', 'out_for_delivery'],
      ['Ausente', 'failed_attempt'],
      ['Intento de entrega. Ausente', 'failed_attempt'],
      ['Realizado intento de entrega', 'failed_attempt'],
      ['Disponible en punto NACEX', 'ready_for_pickup'],
      ['Disponible en Punto Collectt Express', 'ready_for_pickup'],
      ['DEVUELTO', 'returned'],
      ['En devolución', 'exception'],
      ['LECTURA EN AGENCIA DESTINO [location]', 'in_transit'],
      ['LEIDO EN DESTINO', 'in_transit'],
      ['Clasificado', 'in_transit'],
      ['Alta en la unidad de reparto', 'in_transit'],
      ['EN RUTA A LOCALIDAD DE DESTINO', 'in_transit'],
      ['Objeto em transferência - por favor aguarde', 'in_transit'],
      ['Saída do Centro Internacional', 'in_transit'],
      ['PENDIENTE DE ENTREGAR A TIPSA', 'registered'],
      ['Pendiente de recepción en CTT Express', 'registered'],
      ['Aguarda entrada nos CTT', 'registered'],
      // CTT's pre-advice as ParcelsApp translates it.
      ['Waiting for entry at CTT. The information about the shipment has been received.', 'registered'],
      ['Waiting for entry at CTT', 'registered'],
      ['The information about the shipment has been received.', 'registered'],
    ] as const) expect(classifyWording(wording)).toEqual({ stage, source: 'wording:language' });
    // Carriers disagree on a new round, and a failed pickup or a cancelled round is
    // not a missed delivery: the carrier maps decide these.
    for (const wording of ['NUEVO REPARTO', 'Recogida fallida', 'Saída para entrega cancelada']) {
      expect(trackingLanguageStage(wording)).toBeUndefined();
    }
  });

  it('keeps Spanish and Portuguese negations, handoffs, returns and forecasts apart from delivery', () => {
    for (const [wording, stage] of [
      ['No entregado', 'failed_attempt'],
      ['No se ha podido entregar', 'failed_attempt'],
      ['Não entregue', 'failed_attempt'],
      ['Não foi possível efetuar a entrega', 'failed_attempt'],
      ['Objeto não entregue - carteiro não atendido', 'failed_attempt'],
      ['Estabelecimento fechado', 'failed_attempt'],
      ['Em distribuição', 'out_for_delivery'],
      ['Está a ser entregue', 'out_for_delivery'],
      ['Chegada ao centro de distribuição', 'in_transit'],
      ['In viaggio', 'in_transit'],
      ['Przesyłka w drodze', 'in_transit'],
      ['Pakket is onderweg', 'in_transit'],
      ['Entregado al transportista', 'in_transit'],
      // MailAmericas' Spanish hand-overs in the destination country, as ParcelsApp relays them.
      ['Arribado a país destino. Entregado por Aerolínea', 'in_transit'],
      ['Recepción correo de destino. Entregado a Distribuidor', 'in_transit'],
      ['Proceso finalizado. Entregado', 'delivered'],
      ['Entregue à transportadora', 'in_transit'],
      ['Entregado en el punto de recogida', 'ready_for_pickup'],
      ['Entregue no cacifo', 'ready_for_pickup'],
      ['Disponível para levantamento', 'ready_for_pickup'],
      ['Entregado al remitente', 'returned'],
      ['Devolvido ao remetente', 'returned'],
      ['Será devuelto al remitente', 'exception'],
      ['O envio está a ser devolvido ao remetente', 'exception'],
      ['Não foi devolvido', 'exception'],
      ['Su envío ha llegado al centro de distribución y será entregado mañana', 'in_transit'],
      ['A encomenda chegou ao centro de distribuição e será entregue amanhã', 'in_transit'],
      ['Pendiente de entrega', 'in_transit'],
      ['Estará disponible para recoger mañana', 'in_transit'],
    ] as const) expect(classifyWording(wording)).toEqual({ stage, source: 'wording:language' });
    // A condition, a scheduled attempt, a sender pickup or a delivery still to come.
    for (const wording of [
      'Si el destinatario está ausente, el paquete irá al punto de recogida',
      'Em caso de ausência, o envio fica no ponto de recolha',
      'Intento de entrega programado para mañana',
      'Intento de recogida, cliente ausente',
      'Recibirás un SMS una vez entregado',
      'Quando for entregue, receberá um SMS',
      'Fecha de entrega modificada',
      'No disponible para recoger',
    ]) expect(['delivered', 'failed_attempt', 'ready_for_pickup']).not.toContain(wordingStage(wording, 'pending'));
  });

  // GENERATED notices: a delivery still to come reports no movement, so a
  // forecast alone takes the caller's fallback and a sentence that also
  // reports a scan keeps that scan's stage.
  it.each(['Your parcel will be delivered on Tuesday between 10:00 a.m. and 11:00 a.m.',
    'Your parcel will be delivered to a safe place as you instructed', 'Your parcel will now be delivered on Wednesday',
    'Will not be delivered today', "Won't be delivered before Monday", 'Your parcel will be delivered to a pickup point',
    'Votre colis sera livré demain', 'Il sera livré après paiement des droits et taxes', 'Votre colis va être livré aujourd’hui',
    'Ihre Sendung wird am Dienstag zugestellt', 'Voraussichtliche Zustellung am 06.10.2026', 'Zustellung voraussichtlich morgen',
    'Il pacco sarà consegnato domani', 'Il pacco verrà consegnato domani', 'Será entregado mañana', 'Se entregará a la mayor brevedad',
    'Será entregue amanhã', 'Vai ser entregue hoje',
    // Estimates are forecasts too, so "to be delivered" does not read them as transit.
    'Your parcel is estimated to be delivered on: Friday, July 17, 2026', 'Expected to be delivered on Monday',
    'Your package has been scheduled to be delivered by 08:00 PM on Mar 11.', 'Due to be delivered tomorrow',
    'The parcel is now expected to be delivered on 17.07.2026'])('gives the notice "%s" no stage', wording => {
    expect(trackingLanguageStage(wording)).toBeUndefined();
    expect(classifyWording(wording, 'pending')).toEqual({ stage: 'pending', source: 'none' });
    expect(classifyWording(wording, 'in_transit')).toEqual({ stage: 'in_transit', source: 'none' });
  });

  it.each([
    ['Your parcel has arrived at the depot and will be delivered tomorrow', 'in_transit'],
    ['Out for delivery. Your parcel will be delivered between 10:00 and 11:00', 'out_for_delivery'],
    ['Label created; your parcel will be delivered by the carrier', 'registered'],
    ['Shipment information received, it will be delivered next week', 'registered'],
    ["Les formalités d'importation de votre envoi sont terminées et il sera livré contre paiement des droits et taxes", 'in_transit'],
    ['Les formalités d’importation de votre envoi sont terminées et il sera livré contre paiement de droits et taxes de douane.', 'in_transit'],
    ['Votre colis est dédouané. Il sera livré contre paiement des droits et taxes de douane', 'in_transit'],
    ['Votre colis est en cours de livraison, il sera livré avant 13 h', 'out_for_delivery'],
    ['Die Sendung ist im Paketzentrum angekommen und wird voraussichtlich am 06.10.2026 zugestellt', 'in_transit'],
    ['Die Sendung wird heute nicht zugestellt', 'failed_attempt'],
    ['Não será entregue hoje', 'failed_attempt'],
    ['Delivery attempt failed. Your parcel will be delivered again tomorrow', 'failed_attempt'],
    ['Your parcel cannot be delivered', 'failed_attempt'],
    ['Will be delivered back to sender', 'exception'],
    ['Arrived at the depot. Your parcel is estimated to be delivered on: Friday, July 17, 2026', 'in_transit'],
    ['The shipment was loaded into the delivery vehicle and is expected to be delivered today.', 'out_for_delivery'],
  ] as const)('reads only what "%s" reports: %s', (wording, stage) => {
    expect(classifyWording(wording, 'pending')).toEqual({ stage, source: 'wording:language' });
  });

  it('reads the round beside an estimate, and keeps what still waits to be delivered in transit', () => {
    expect(classifyWording('The item is expected to be delivered today. The item is out for doorstep delivery', 'pending'))
      .toEqual({ stage: 'out_for_delivery', source: 'wording:out_for_delivery' });
    for (const wording of ['Parcel to be delivered', 'Waiting to be delivered', 'The package is ready to be delivered to the final destination']) {
      expect(classifyWording(wording, 'pending'), wording).toEqual({ stage: 'in_transit', source: 'wording:language' });
    }
  });

  it('files a linehaul handover as transit, not acceptance', () => {
    expect(classifyWording('Handed over from linehaul office', 'pending')).toEqual({ stage: 'in_transit', source: 'wording:language' });
    expect(classifyWording('Parcel handed over', 'pending')).toEqual({ stage: 'accepted', source: 'wording:accepted' });
  });

  it('reads the last-mile wording that consolidators relay', () => {
    for (const [wording, stage] of [
      ['Your package is ready to be picked up.', 'ready_for_pickup'],
      ['Parcel has been handed over to a third-party courier', 'in_transit'],
      ['New delivery attempt on the next delivery day', 'in_transit'],
      ['We missed each other', 'failed_attempt'],
      ['We missed you. We deliver your shipment at a pickup point.', 'failed_attempt'],
      ['No payment, new delivery attempt on the next delivery day', 'failed_attempt'],
      ['Shipment not yet received or processed', 'registered'],
      ['Registered parcel data, parcel not dispatched yet', 'registered'],
      ['Not yet accepted', 'registered'],
      ['Shipment not accepted yet', 'registered'],
      // A forwarder's hand-over to the airport for its flight, as Mayi Yinfu translates it.
      ['The goods have been delivered to the airport and are awaiting the arrangement of flights.', 'in_transit'],
      ['Shipment delivered to the airport', 'in_transit'],
      // A forwarder's hand-over to its destination agent after clearance, as Linhan relays it.
      ['transfer to local acting company International self-operation team', 'in_transit'],
      ['Transfer to the destination delivery partner', 'in_transit'],
      // The last-mile carrier taking the parcel over, as DHLink relays it, is a handover, not the acceptance.
      ['Package picked up by last-mile carrier', 'in_transit'],
      ['Collected by the final mile courier', 'in_transit'],
      // The same handover after clearance, as a universal provider relays it.
      ['Handover To Last Mile', 'in_transit'], ['Received by Last Mile Provider', 'in_transit'],
      ['Package picked up', 'accepted'],
      ['Picked up by the carrier', 'accepted'],
      // Colis Privé's English as ParcelsApp relays it: its takeover, its depot with the driver's round to come, and a pickup point.
      ['Your package is taken care of by Colis Privé. It will be shipped to our regional distribution center.', 'in_transit'],
      ['Your package has arrived at our regional distribution agency, it will be handed over to your delivery driver.', 'in_transit'],
      ['Your package is waiting for you at the collection point.', 'ready_for_pickup'],
    ] as const) expect(classifyWording(wording, 'pending'), wording).toEqual({ stage, source: 'wording:language' });
    // A hand-over to come to the carrier is still a registration.
    expect(classifyWording('Your package is being prepared by the sender. It will be handed over to us soon.', 'pending').stage).toBe('registered');
    expect(wordingStage('Not yet picked up by the last-mile carrier')).not.toBe('in_transit');
    expect(wordingStage('Not yet received by last mile provider')).not.toBe('in_transit');
    // Only the day's delivery is Royal Mail's round; a later day is still a forecast.
    expect(wordingStage('Due to be delivered tomorrow')).toBe('in_transit');
    // A notice the carrier failed to send is no scan; a failed delivery still is.
    for (const wording of ['REMINDER EMAIL SENT FAILED', 'SMS notification failed', 'Failed to send notification for collection']) {
      expect(classifyWording(wording, 'pending'), wording).toEqual({ stage: 'pending', source: 'none' });
    }
    expect(wordingStage('Failed delivery notification sent')).toBe('failed_attempt');
    // A parcel the carrier still has to collect, a failed new attempt, a missed
    // round with the parcel waiting, a parcel already abroad.
    expect(wordingStage('Parcel ready to be picked up by the courier')).not.toBe('ready_for_pickup');
    expect(wordingStage('New delivery attempt failed')).toBe('failed_attempt');
    expect(wordingStage('We missed each other, ready for collection at the sorting centre')).toBe('ready_for_pickup');
    expect(wordingStage('Item not yet received at the destination office')).not.toBe('registered');
  });

  it('reads a parcel turned away as a fault, not an acceptance', () => {
    for (const wording of ['Package not accepted by sorting center', "Parcel wasn't accepted at the depot", 'Could not be accepted',
      'Not accepted by the recipient']) expect(wordingStage(wording), wording).toBe('exception');
    for (const wording of ['Accepted', 'Parcel accepted at the post office', 'Item accepted, not yet dispatched']) {
      expect(wordingStage(wording), wording).toBe('accepted');
    }
  });

  it('lets the rest of a scan outrank a step not yet taken and a courier handover', () => {
    for (const [wording, stage] of [
      // A step the carrier has not taken yet leaves the rest of the scan to read.
      ['Clearance delay: payment not yet received', 'customs'],
      ['Arrived at hub; not yet processed', 'in_transit'],
      ['Parcel not yet handed over to the courier', 'registered'],
      // Clearance worded within the step's own sentence stays with customs too.
      ['Payment not yet received: clearance delay', 'customs'],
      ['Not handed over to the carrier: awaiting customs clearance', 'customs'],
      ['Not yet handed over to the carrier: awaiting customs clearance', 'customs'],
      ['Not handed over to the carrier yet, awaiting customs clearance', 'customs'],
      ['Item not yet handed over to customs', 'customs'],
      // A release moves the parcel on, whatever the punctuation, but not one still to come.
      ['Not yet handed over to the carrier: customs cleared', 'in_transit'],
      ['Not yet handed over to the carrier. Customs cleared', 'in_transit'],
      ['Not yet handed over to the airline; export customs cleared', 'in_transit'],
      ['Das Paket wurde noch nicht an GLS übergeben: Zollabfertigung abgeschlossen', 'in_transit'],
      ['Not yet handed over to the carrier: customs clearance not completed', 'customs'],
      ['Not yet handed over to the carrier: once released from customs', 'customs'],
      ['Not yet handed over to the carrier: waiting for customs clearance to be completed', 'customs'],
      ['Das Paket wurde noch nicht an GLS übergeben: Zollabfertigung nicht abgeschlossen', 'customs'],
      ["Le colis n'a pas encore été remis au transporteur : dédouanement non terminé", 'customs'],
      ['Il pacco non è ancora stato affidato al corriere: sdoganamento non completato', 'customs'],
      // The courier alone is the round; a carrier or a courier set apart is another network.
      ['Out for delivery, handed over to our courier', 'out_for_delivery'],
      ['Handed over to the courier', 'out_for_delivery'],
      ['Handed Over to SingPost Courier', 'in_transit'],
      ['Handed over to the last-mile carrier', 'in_transit'],
      ['Handed over to the courier company', 'in_transit'],
      ['Handed over to The Courier Guy', 'in_transit'],
    ] as const) expect(classifyWording(wording, 'pending'), wording).toEqual({ stage, source: 'wording:language' });
    // A pickup order, a return or the sender's hand-in is not the round.
    for (const wording of ['Pickup order handed over to the courier', 'Return handed over to the courier',
      'Parcel handed over to the courier by the sender']) expect(trackingLanguageStage(wording), wording).toBeUndefined();
  });

  it('reads customs from Spanish and Portuguese stems, not from a Malay or Indonesian complaint', () => {
    for (const wording of ['Pengaduan pelanggan diterima', 'Aduan pelanggan diterima']) {
      expect(classifyWording(wording, 'pending'), wording).toEqual({ stage: 'pending', source: 'none' });
    }
    for (const wording of ['Envío en aduana', 'Gestión aduanera en curso', 'Desaduanaje en proceso',
      'Em fiscalização aduaneira', 'Aguardando liberação aduaneira']) {
      expect(classifyWording(wording, 'pending'), wording).toEqual({ stage: 'customs', source: 'wording:language' });
    }
  });

  it('reads the first scans, the round and a cancellation that universal providers relayed', () => {
    for (const [wording, stage] of [
      // Sender data and a shipment record, as Paack's, DPD UK's, InPost's and Asendia's maps file them.
      ['order details received', 'registered'],
      ["We've received your order details, but have not yet received your parcel", 'registered'],
      ['Dane zamówienia otrzymane', 'registered'],
      ['shipment created', 'registered'],
      ['Przesyłka utworzona', 'registered'],
      ['Gönderi oluşturuldu', 'registered'],
      ['notificado - el envío ha sido registrado.', 'registered'],
      ['El paquete fue registrado', 'registered'],
      ['The shipment has been registered', 'registered'],
      // GEODIS's notice of the sender's data, unlike a parcel transferred on.
      ['Transferred Data', 'registered'],
      ['Transferred to next facility', 'in_transit'],
      // Correos: left for admission, pre-registered, admitted.
      ['depositado para admisión. envío depositado por remitente en taquilla citypaq para admisión por correos', 'registered'],
      ['Entregado en CityPaq para admisión', 'registered'],
      ['pre-registered. shipment pre-registered in the postal correos spain system, pending acceptance', 'registered'],
      ['Prerregistrado', 'registered'],
      ['admitido.. el envío ha tenido admisión en origen.', 'accepted'],
      ['ADMITIDO EN OFICINA DE CORREOS', 'accepted'], ['Admisión país de origen', 'accepted'],
      // USPS before its acceptance scan, and CTT's acceptance.
      ['Shipment Received, Package Acceptance Pending, ZIP Code 10001', 'registered'],
      ['Aceite', 'accepted'],
      ['Aceite. O envio foi aceite. O processo de envio foi iniciado.', 'accepted'],
      // DHL Express's round.
      ['shipment is out with courier for delivery', 'out_for_delivery'],
      // A cancellation, as carriers' codes file it.
      ['i̇ptal edildi', 'exception'],
      ['Gönderi iptal edildi', 'exception'],
      ['Order canceled', 'exception'],
      ['Your parcel has been cancelled', 'exception'],
      ['Przesyłka anulowana', 'exception'],
    ] as const) expect(classifyWording(wording, 'pending'), wording).toEqual({ stage, source: 'wording:language' });
    // A cancelled return, pickup or hold lets the parcel go on; a return
    // label is no new shipment; refused admission and a pickup round are
    // not these steps. Too specific or too bare to read: Paack's origin
    // scan, a Turkish "entered", Swiss Post's forward order.
    for (const wording of ['Return cancelled', 'Pickup cancelled', 'Hold cancelled', 'Pickup order cancelled',
      'Return shipment created', 'No admitido', 'Out with driver for pickup', 'O pedido de devolução foi aceite',
      "in paack's distribution centre", 'girildi', 'order triggered by recipient: forward']) {
      expect(classifyWording(wording, 'pending'), wording).toEqual({ stage: 'pending', source: 'none' });
    }
  });

  it('reads the recipient collecting a parcel as delivered, and the courier collecting it as acceptance', () => {
    for (const wording of [
      // By the recipient, consignee, addressee or customer, as DPD Germany, DHL eCommerce and Asendia word it.
      'Parcel picked up by recipient', 'Picked up by consignee', 'Picked up from Pickup parcelshop by consignee.',
      'Picked up from DPD Pickup station by consignee.', 'Collected by the recipient', 'collected by recipient',
      'Collected at DHL ServicePoint by the recipient', 'Your shipment has been collected by consignee at the parcelshop',
      'The recipient has picked up the shipment from the retail outlet.', 'Your parcel was collected by the addressee',
      'Picked up by the customer', 'Picked-up by recipient',
      // From a pickup point, a locker or a counter.
      'Your parcel has been picked up from the Pickup point', 'Collected from DHL Locker by the recipient',
      'Item collected from Parcel Locker', 'Final delivery - Collected at counter', 'Collected at the post office counter',
      // French, German, Italian, Spanish, Portuguese and Polish.
      'Retiré par le destinataire', 'Colis retiré par son destinataire', 'Votre colis a été retiré au point relais',
      'Le destinataire a retiré son colis', 'Vom Empfänger abgeholt', 'Die Sendung wurde vom Empfänger in der Filiale abgeholt.',
      'Der Empfänger hat die Sendung in der Filiale abgeholt.', 'Die Sendung wurde aus der Packstation abgeholt.',
      'Abholung im Paketshop durch Empfänger',
      'Ritirato dal destinatario', "La spedizione è stata ritirata dal destinatario presso l'ufficio postale",
      'Il destinatario ha ritirato la spedizione', 'Recogido por el destinatario', 'Retirado por el destinatario',
      'El destinatario ha retirado el envío de la tienda SEUR Pickup seleccionada.', 'Levantado pelo destinatário',
      'Odebrana przez odbiorcę',
    ]) expect(classifyWording(wording, 'pending'), wording).toEqual({ stage: 'delivered', source: 'wording:language' });
    // A bare pickup is the sender's hand-in, and so is the courier's collection, even at a pickup point.
    for (const wording of ['Picked up', 'Picked up at the client', 'Picked up by the courier', 'Picked up by the driver',
      'Picked up from the sender', 'Picked up from shipper', 'Picked up at DHL ServicePoint by the courier',
      'Picked up from DHL Locker by the courier', 'Picked up at post office by the courier', 'Picked up at parcelshop']) {
      expect(classifyWording(wording, 'pending'), wording).toEqual({ stage: 'accepted', source: 'wording:language' });
    }
    // A parcel shop or service point also takes in drop-offs the courier
    // collects. Nor is a pickup point taking the parcel in, a mailbox
    // collection, a sender pickup or a parcel taken off the round a delivery.
    for (const wording of ['The shipment has been collected from the ServicePoint', 'Collected from the pickup point by the courier',
      'Parcel collected by pickup point', 'Shipment collected from the shipper', 'We successfully picked it up from your mailbox.',
      'Die Sendung wurde beim Absender abgeholt', 'Die Sendung wurde vom Paketboten in der Filiale abgeholt', 'Ritirato dal corriere',
      'Colis retiré de la tournée', 'Picked up by customer service', 'Abholung im Paketshop durch den Kurier',
      'Abholung durch Empfänger möglich']) {
      expect(wordingStage(wording, 'pending'), wording).not.toBe('delivered');
    }
    // A parcel still to collect.
    for (const wording of ['Ready to be picked up', 'Ready to be picked up by the recipient', 'Your parcel is ready to be collected',
      'Prêt à être retiré']) expect(classifyWording(wording, 'pending'), wording).toEqual({ stage: 'ready_for_pickup', source: 'wording:language' });
    for (const wording of ['To be collected by the recipient', 'The parcel can be collected from the parcel locker',
      'Your parcel will be kept at the pickup point until it is collected', 'Die Sendung kann vom Empfänger in der Filiale abgeholt werden',
      'Held at the counter until collected by the recipient']) {
      expect(wordingStage(wording, 'pending'), wording).not.toBe('delivered');
    }
    // A parcel nobody collected, which Spanish and Portuguese used to read as delivered.
    for (const wording of ['Not collected by the recipient', 'Not collected at DHL ServicePoint', 'Parcel not picked up by the recipient',
      'Parcel has not been collected from the pickup point', 'The recipient has not collected the parcel', 'Non retiré par le destinataire',
      "Le colis n'a pas été retiré par le destinataire", 'Vom Empfänger nicht abgeholt', 'Non ritirato dal destinatario',
      'No recogido por el destinatario', 'Não levantado pelo destinatário']) {
      expect(wordingStage(wording, 'pending'), wording).not.toBe('delivered');
    }
    for (const [wording, stage] of [
      ['Not collected by the recipient, return to sender', 'exception'],
      ['Not collected from DHL Locker, return to the sender', 'exception'],
      ['Shipment not collected by recipient, awaiting instructions', 'exception'],
      ['Collected by the recipient and returned to sender', 'returned'],
    ] as const) expect(classifyWording(wording, 'pending'), wording).toEqual({ stage, source: 'wording:language' });
  });

  it('reads pickup points, failed rounds and hand-offs in the words carriers use', () => {
    for (const [wording, stage] of [
      // A pickup spelled "pick-up", and DPD's "retrieval point".
      ['Ready for pick-up at the example parcel point', 'ready_for_pickup'],
      ['Your parcel has been delivered to the retrieval point', 'ready_for_pickup'],
      ['Your parcel is available at the retrieval point', 'ready_for_pickup'],
      // "Couldn't", and premises that were closed.
      ["We couldn't deliver your parcel and had to return it to the depot", 'failed_attempt'],
      ["We couldn’t deliver your parcel, it will soon be available at a retrieval point", 'failed_attempt'],
      ['Your parcel is being held at our delivery depot, your premises were closed', 'failed_attempt'],
      // A delivery terminal is no delivery round.
      ['Shipment Unloaded in Delivery Terminal', 'in_transit'],
      // The sender's deposit with a postal partner, an airline taking the
      // parcel, and the recipient collecting it.
      ['Your shipment has been deposited by the sender with postal partner in their country of origin', 'accepted'],
      ['Handed over to airline.', 'in_transit'],
      ['You have collected your parcel', 'delivered'],
      // An export release, completed import procedures and a parcel cleared to leave move on.
      ['Item released by export Customs', 'in_transit'],
      ['The import procedures for your shipment are complete.', 'in_transit'],
      ['Your shipment is ready to leave the foreign territory. It will be handed over to the carrier for delivery', 'in_transit'],
      // A new delivery date someone asked for, and a parcel the carrier has not received yet.
      ['Delivery exception, A request was made to change this delivery date.', 'in_transit'],
      // Updated delivery details and a local carrier's bare shipment scan, relayed mid-route.
      ['Delivery details updated', 'in_transit'],
      ['Delivery information has been updated.', 'in_transit'],
      ['Package shipment', 'in_transit'],
      ["We're expecting your parcel to arrive with us soon and we'll update your tracking once we've received it", 'registered'],
      ['The shipment was created by the sender, we are waiting for it to be entrusted to us for sending to its destination', 'registered'],
      ['The shipment has been created by the sender, we are waiting for it to be entrusted to us for dispatch to its destination.', 'registered'],
    ] as const) expect(classifyWording(wording, 'pending'), wording).toEqual({ stage, source: 'wording:language' });
    // A French sort still reads as one; "retrieval" is no sort, nor a notice a pickup.
    expect(wordingStage('Colis trié', 'pending')).toBe('in_transit');
    expect(classifyWording('Retrieval of shipment data', 'pending')).toEqual({ stage: 'pending', source: 'none' });
    expect(classifyWording('Package shipment information', 'pending')).not.toEqual({ stage: 'in_transit', source: 'wording:language' });
    expect(classifyWording('Please update your delivery details', 'pending')).toEqual({ stage: 'pending', source: 'none' });
    expect(wordingStage('Your parcel will be available at the retrieval point', 'pending')).toBe('in_transit');
    expect(wordingStage('Your parcel is not available at the retrieval point', 'pending')).not.toBe('ready_for_pickup');
    // The round itself still reads as one, a terminal or depot does not.
    expect(wordingStage('The parcel is in delivery.', 'pending')).toBe('out_for_delivery');
    for (const wording of ['Arrived in delivery depot', 'Sorted in delivery centre', 'Parcel scanned in delivery hub']) {
      expect(wordingStage(wording, 'pending'), wording).not.toBe('out_for_delivery');
    }
    // A sender's deposit is no delivery; a deposit for the recipient is.
    expect(wordingStage('Deposited by the sender at the post office', 'pending')).not.toBe('delivered');
    expect(wordingStage('Deposited in the mailbox', 'pending')).toBe('delivered');
    for (const wording of ['Shipment in letterbox', 'Your parcel was left in the mailbox']) expect(wordingStage(wording, 'pending'), wording).toBe('delivered');
    // A collection still to come is none.
    expect(wordingStage('Once you have collected your parcel, rate your delivery', 'pending')).not.toBe('delivered');
  });

  it('reads relayed pre-advice, receipts, cross-docks and flights the providers pass on', () => {
    for (const [wording, stage] of [
      ['Order submitted, pending to receive.', 'registered'], ['Order created. Order submitted and pending receipt', 'registered'],
      ['Shipment data uploaded', 'registered'], ['Sender preparing item', 'registered'], ['Forecast has been received', 'registered'],
      ['Sender preparing item. The sender has let us know they have despatched your item', 'registered'],
      ['Sender has despatched item', 'registered'], ['Sender despatching item', 'registered'],
      ['Shipping info sent to BRT', 'registered'],
      ['Information, We have received your shipment information, we will have your goods soon', 'registered'],
      ['INFORMADO. Ya hemos recibido la información de su envío, en breve dispondremos de él', 'registered'],
      ['We will pick up the package from the sender soon', 'registered'],
      ['We will pick up your parcel from the sender soon.', 'registered'],
      ['Booked for collection', 'registered'], ['Processing at destination branch', 'in_transit'],
      ['Receipt of the package at the DPD branch', 'in_transit'], ['Release of shipment for delivery', 'out_for_delivery'],
      ['Erfolgreich abgeholt', 'accepted'], ['Die Sendung wurde erfolgreich abgeholt', 'accepted'],
      ['Expected from Forward2me Ltd', 'registered'],
      ['Csomagod elkészült. Csomagod létrejött a rendszerünkben, a feladó még nem adta át azt a FOXPOST részére.', 'registered'],
      ['The collection has been registered', 'registered'], ['The shipment has been deposited at a SEUR pickup point', 'accepted'],
      ['The collection has been carried out', 'accepted'], ['Order placed', 'registered'], ['Sent abroad', 'in_transit'],
      // Poczta Polska's departure from Poland, as ParcelsApp words it.
      ['Sending the package from Poland', 'in_transit'],
      // Russian Post's operations, as ParcelsApp words them.
      ['Processing: Left pickup location', 'in_transit'], ['Export of international mail', 'in_transit'],
      ['Import of international mail', 'in_transit'], ['Released from Russia', 'in_transit'],
      ['Example Forwarding has received the goods, Example Town, CN.', 'accepted'],
      // DPD Poland's scans as ParcelsApp words them.
      ['Sending the package at the pickup point', 'accepted'], ['Handing over the package to the courier', 'accepted'],
      ['Acceptance of the package at the delivery branch abroad', 'in_transit'], ['Release for delivery abroad', 'out_for_delivery'],
      ['Acceptance of the package at the Pickup point', 'ready_for_pickup'],
      // A forwarder's warehouse receipt, as 17TRACK relays it.
      ["Package received & scanned at carrier's domestic warehouse.", 'accepted'],
      // The forwarder's receiving point before that warehouse, 17TRACK's first scan of the parcel.
      ['THE GOODS ARRIVE AT THE RECEIVING POINT', 'accepted'],
      // DAI Post's own words, relayed by universal providers.
      ["We’ve received your delivery details. We’ll let you know as soon as your parcel is in our hands.", 'registered'],
      ['Your parcel’s checked in and being prepared for its journey.', 'accepted'], ['Checked in at origin hub', 'accepted'],
      ['Your parcel is in the air and is heading your way.', 'in_transit'],
      ['Your parcel’s left the transfer country and is back on the move.', 'in_transit'],
      ['Touchdown! Your parcel has landed.', 'in_transit'], ['Collected from the airline for processing', 'in_transit'],
      ['Your parcel’s on an interstate journey. We’ll keep you updated as it travels.', 'in_transit'],
      ['It’s happening, your parcel will be delivered today. Get ready!', 'out_for_delivery'],
      ['Parcel out for final mile carrier delivery', 'out_for_delivery'], ['Parcel unsafe to leave at address', 'failed_attempt'],
      ['Parcel received by UniUni', 'in_transit'],
      ['The courier will deliver the parcel soon. Additional details are available in the app, email or SMS.', 'out_for_delivery'],
      ['Item received by Royal Mail', 'accepted'],
      // Royal Mail's delivery round, relayed by universal providers.
      ['Due to be delivered today', 'out_for_delivery'], ['Due to be delivered today by', 'out_for_delivery'],
      // Posta Slovenije's and GLS's delivery rounds, relayed without their codes.
      ['The item is expected to be delivered today', 'out_for_delivery'],
      ['The parcel is expected to be delivered during the day.', 'out_for_delivery'],
      ['Sender advised item dropped off at parcel locker', 'accepted'], ['Dropped off at Postbox', 'accepted'],
      ['The shipment has been taken over by one of our operators at the post office.', 'accepted'],
      ['The shipment has been taken over at the post office point', 'accepted'],
      ['The shipment has been taken over at the Post-Locker point.', 'accepted'],
      ["We've received your parcel at the ParcelShop and will be collecting it shortly", 'accepted'],
      ['已入库,到达收货点', 'accepted'], ['国内清关中', 'customs'],
      ['Cross docked. Crossdock', 'in_transit'], ['Flight 202 is taking off and is expected to land on the 9th', 'in_transit'],
      ['The second leg is taking off, expected to land on the 9th', 'in_transit'],
      ['The flight landed, and the board was dismantled and cleared', 'in_transit'],
      ['Courier Pick-up', 'accepted'], ['Received in Office', 'in_transit'], ['Export to foreign provider', 'in_transit'],
      ['Parcel Stored by Customer', 'accepted'], ['Scan out - hub', 'in_transit'],
      ['Attempted but unfinished drop off at locker', 'registered'], ['Received by partner carrier', 'in_transit'],
      ['Operation center is processing package information', 'registered'], ['Preparing to leave Hong Kong operation center', 'in_transit'],
      ['The item is ready for shipment', 'registered'], ['Consignment received at the PostNL Acceptance Centre', 'accepted'],
      ['As requested, the UPS My Choice® delivery change was completed.', 'in_transit'], ['The address was changed as the receiver requested.', 'in_transit'],
      ["The company or receiver name is incorrect. This will delay delivery. We're attempting to update this information.", 'exception'],
      ['Shipment in Transit to the ePost Global Processing Center', 'registered'],
      ['Registered and being prepared', 'registered'], ['Left the branch', 'in_transit'], ['Left the branch 3', 'in_transit'],
      ['Collo in der nox Niederlassung eingetroffen. Sendung eingetroffen', 'in_transit'],
      ['Collo von der nox Niederlassung weiterverladen. Sendung weiterverladen', 'in_transit'],
      ['Collo is reloaded by the nox branch. Consignment reloaded', 'in_transit'],
      ["La spedizione e' regolarmente partita", 'in_transit'], ['Tendered to International Gateway.', 'in_transit'],
      ['Spedizione affidata a una FedEx Location in attesa di ritiro del corriere', 'accepted'],
      ['Pending shipping by the seller', 'registered'], ['Connecting flights flight takeoff', 'in_transit'],
      ['Initial landing', 'in_transit'], ['Item flight landing', 'in_transit'],
      ['The cargo tally in the supervised warehouse is in progress.', 'in_transit'],
      ['Prepared for last mile handover', 'in_transit'],
      ['Parcel was dropped off at the parcel shop', 'accepted'], ['create, Shipment order created', 'registered'],
      ['Create. Shipment order created', 'registered'], ['Handover to airline', 'in_transit'],
      ['Shipping Order Created.', 'registered'], ['Parcel received by in ORD01.', 'in_transit'], ['到达收货点', 'accepted'],
      ['快件电子信息已经收到', 'registered'], ['中国邮政已收取快件', 'in_transit'],
      ['邮件到达投递点【zz sample town 00000】', 'in_transit'], ['邮件到达【示例市国际互换局】', 'in_transit'], ['邮件到达处理中心【示例】', 'in_transit'],
      ['Tracking number changed, Carrier note: Package relabeled', 'in_transit'],
      ['The goods leave the operation center', 'in_transit'], ['Goods leaving the operation center', 'in_transit'],
      ['Parcel was handed over to Pickup parcel shop', 'ready_for_pickup'], ['Takeover by Pickup parcel shop', 'ready_for_pickup'],
      ['Takeover by pickup parcel shop_shop', 'ready_for_pickup'], ['Parcel handed over to DPD at the Pickup parcel shop', 'accepted'],
      ['Has been put into storage', 'accepted'], ['Has left the warehouse', 'in_transit'],
      ['Package left the warehouse', 'in_transit'],
      // A forwarder's warehouse scans before the flight, relayed by providers.
      ['Warehouse scanning bagging', 'in_transit'], ['Master Airway Bill Number Received', 'in_transit'],
      ['Master air waybill assigned', 'in_transit'], ['Unbagging', 'in_transit'],
      ['Parcel has been packed and is ready for outbound shipping', 'in_transit'],
    ] as const) expect(classifyWording(wording, 'pending'), wording).toEqual({ stage, source: 'wording:language' });
    // A delivery window is not a sender's notice.
    expect(wordingStage('Expected from tomorrow', 'pending')).toBe('pending');
    expect(wordingStage('Expected from 9am to 11am', 'pending')).toBe('pending');
    // Another carrier's delivery forecast for the day stays one.
    expect(wordingStage('Your parcel will be delivered today', 'pending')).toBe('pending');
    // Goods a recipient, a pickup point or a destination received are no acceptance.
    for (const wording of ['The recipient has received the goods', 'The pickup point has received the goods, Example Town, CN.', 'Destination warehouse has received the goods']) {
      expect(wordingStage(wording, 'pending'), wording).not.toBe('accepted');
    }
    // A parcel's own air waybill still marks registration.
    expect(wordingStage('Air waybill created', 'pending')).toBe('registered');
    // A notice sent to the recipient is no pre-advice, and an item received elsewhere keeps its reading.
    expect(wordingStage('Shipping information sent to the recipient', 'pending')).not.toBe('registered');
    expect(wordingStage('Item received at delivery office', 'pending')).toBe('accepted');
    expect(wordingStage('Item received by customs', 'pending')).toBe('customs');
  });

  it('reads a waybill or label generated as registration, unless the scan reports more', () => {
    for (const wording of ['Waybill generated', 'WAYBILL GENERATED', 'Waybill generated for 4PX0000000000001CN',
      'Waybill created', 'Waybill has been created', 'E-waybill generated', 'Air waybill created', 'AWB created at origin',
      'Waybill number generated', 'Shipping label generated', 'Label created for EXAMPLESHOP',
      'Waybill created. Shipment has not been received from the retailer']) {
      expect(classifyWording(wording, 'pending'), wording).toEqual({ stage: 'registered', source: 'wording:language' });
    }
    for (const [wording, stage] of [
      ['Waybill generated, departed facility', 'in_transit'],
      ['Waybill generated for 4PX0000000000001CN, arrived at sorting center', 'in_transit'],
      ['Label created, parcel handed to DPD', 'accepted'],
      ['Waybill created. Returned to sender', 'returned'],
      ['Waybill allocated to linehaul', 'in_transit'],
      ['Waybill delivered', 'delivered'],
    ] as const) expect(wordingStage(wording, 'pending'), wording).toBe(stage);
    // Paperwork not generated or cancelled is no registration.
    for (const wording of ['Waybill not generated', 'Waybill cancelled', 'Label creation failed']) {
      expect(trackingLanguageStage(wording), wording).not.toBe('registered');
    }
  });

  it('falls back without a rule id when nothing matches', () => {
    expect(classifyWording('Estado interno 99', 'pending')).toEqual({ stage: 'pending', source: 'none' });
    expect(wordingStage('Estado interno 99')).toBe('in_transit');
  });
});
